# -*- coding: utf-8 -*-
"""
把国考职位表 .xls 编译成网页可直接加载的数据文件 data/positions.js

用法:  python build_data.py "2027年国考职位表（全国）.xls"

输出:  data/positions.js   ->  window.GK_DATA = {...}

设计要点:
  * 输出 JS 全局量而非 JSON —— 双击 index.html 从 file:// 打开时 fetch() 会被
    CORS 拦掉，<script src> + 全局赋值可以绕开，无需起本地服务器。
  * 低基数列做字典编码（值表 + 整数索引），实测 8.4MB 量级。
  * 只做「抽取 + 压缩」。专业分词与匹配判定全部放在 match.js 里，保证匹配逻辑
    只有一个实现，避免 Python / JS 两套实现漂移。
  * 派生词表（类目、专业代码表）全部从这份表本身提取，不引入外部专业目录 ——
    因为表里有「财会审计类」「经济金融类」这类招录机关自编类目。
"""

import json
import os
import re
import sys
from collections import Counter, defaultdict

import xlrd

# 输出被重定向（管道/文件）时强制 UTF-8，便于日志留痕；
# 直接跑在真实控制台时保持系统编码，让 Windows 控制台自己处理中文。
if not sys.stdout.isatty():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

# 原表 27 列，丢掉第 25/26 列（咨询电话2/3，几乎全空）
SRC_COLUMNS = [
    "部门代码", "部门名称", "用人司局", "机构性质", "招考职位", "职位属性",
    "职位分布", "职位简介", "职位代码", "机构层级", "考试类别", "招考人数",
    "专业", "学历", "学位", "政治面貌", "基层工作最低年限", "服务基层项目工作经历",
    "是否在面试阶段组织专业能力测试", "面试人员比例", "工作地点", "落户地点",
    "备注", "部门网站", "咨询电话1",
]
LEI_COLUMN = SRC_COLUMNS.index("专业")
REMARK_COLUMN = SRC_COLUMNS.index("备注")

# 类目名里不允许出现的字，用来挡掉「本科专业为电子信息类」这种误切
LEI_STOPWORDS = ("本科", "研究生", "硕士", "博士", "专业", "学历", "学位", "或", "和", "及", "的", "为", "须", "是", "、")
# 切出片段后，剥掉开头的连接词，让「本科专业为电子信息类」还原成「电子信息类」
LEI_LEAD_JUNK_RE = re.compile(
    r"^(?:.*(?:招收|招录|招考|面向))?"
    r"(?:(?:本科|研究生|硕士|博士|专业|学历|学位|阶段|所学|以上|须|需|为|是|的|应|限|或|和|及|与)+)?"
)

PROVINCES = [
    "北京市", "天津市", "上海市", "重庆市",
    "河北省", "山西省", "辽宁省", "吉林省", "黑龙江省", "江苏省", "浙江省", "安徽省",
    "福建省", "江西省", "山东省", "河南省", "湖北省", "湖南省", "广东省", "海南省",
    "四川省", "贵州省", "云南省", "陕西省", "甘肃省", "青海省", "台湾省",
    "内蒙古自治区", "广西壮族自治区", "西藏自治区", "宁夏回族自治区", "新疆维吾尔自治区",
    "香港特别行政区", "澳门特别行政区",
]
PROVINCE_RE = re.compile("^(" + "|".join(sorted(PROVINCES, key=len, reverse=True)) + ")")


def norm(text):
    """全角标点归一化为半角，去掉空白，便于统一切分。"""
    text = str(text)
    for a, b in (("，", ","), ("、", ","), ("；", ";"), ("：", ":"),
                 ("（", "("), ("）", ")"), ("　", ""), (" ", ""), (" ", "")):
        text = text.replace(a, b)
    return text.strip()


def is_lei(name):
    """判断一个片段是不是「专业类目」名，如 计算机类 / 财会审计类。"""
    if not name.endswith("类") or len(name) < 3 or len(name) > 12:
        return False
    return not any(w in name for w in LEI_STOPWORDS)


def extract_major(raw):
    """从「专业」栏原文里抽取类目名。仅用于建词表，不参与匹配判定。

    逐个「类」字切段（而不是用贪婪正则），因为「财会审计类社会保障类」这种
    两个类目连写、中间没有标点的情况很常见。
    """
    leis = set()
    for run in re.findall(r"[一-龥]+", norm(raw)):
        start = 0
        for match in re.finditer("类", run):
            cand = LEI_LEAD_JUNK_RE.sub("", run[start:match.end()])
            start = match.end()
            if is_lei(cand):
                leis.add(cand)
    return leis


def main():
    if len(sys.argv) < 2:
        print("用法: python build_data.py <职位表.xls>")
        return 1
    xls_path = sys.argv[1]
    if not os.path.exists(xls_path):
        print("找不到文件: %s" % xls_path)
        return 1

    book = xlrd.open_workbook(xls_path, on_demand=True)

    rows = []          # 每行的 25 个字段
    categories = []    # 每行所属的招录类别（sheet 名）
    for sheet_name in book.sheet_names():
        sheet = book.sheet_by_name(sheet_name)
        # 第 0 行是免责声明，第 1 行才是表头，数据从第 2 行起
        if sheet.nrows < 2 or sheet.ncols < 25:
            book.unload_sheet(sheet_name)
            continue
        for r in range(2, sheet.nrows):
            values = [norm(sheet.cell_value(r, c)) for c in range(len(SRC_COLUMNS))]
            if not values[0]:          # 部门代码为空 = 空行 / 小计行
                continue
            rows.append(values)
            categories.append(sheet_name)
        book.unload_sheet(sheet_name)

    total = len(rows)
    print("读取职位数: %d" % total)

    # ---- 派生词表（全部来自这份表自身）------------------------------------
    lei_counter = Counter()
    for values in rows:
        for lei in extract_major(values[LEI_COLUMN]):
            lei_counter[lei] += 1

    # 专业代码 -> 专业名：只在「代码紧邻名称」的写法里取，避免张冠李戴
    major_counter = Counter()
    code_to_lei = defaultdict(Counter)
    for values in rows:
        text = norm(values[LEI_COLUMN])
        for code, name in re.findall(r"(?<![0-9])([0-9]{6}[A-Z]?)([一-龥]{2,20})", text):
            major_counter[(code, name)] += 1
        # 类目归属只认「0809计算机类」这种紧邻写法。
        # 同格共现不可用 —— 0809 会和「电子信息类」共现 265 次，只因两者写在同一格。
        for code, lei in re.findall(r"(?<![0-9])([0-9]{4}[A-Z]?)([一-龥]{2,12}类)", text):
            if is_lei(lei):
                code_to_lei[code][lei] += 1
        for code, lei in re.findall(r"(?<![0-9])([0-9]{2})([一-龥]{2,12}类)", text):
            if is_lei(lei):
                code_to_lei[code][lei] += 1

    # ---- 列存 + 字典编码 ---------------------------------------------------
    columns = list(SRC_COLUMNS) + ["招录类别"]
    all_columns = [[row[i] for row in rows] for i in range(len(SRC_COLUMNS))]
    all_columns.append(categories)

    encoded = []
    for values in all_columns:
        uniques = sorted(set(values))
        total_len = sum(len(v) for v in values)
        dict_len = sum(len(v) for v in uniques)
        # 字典编码只在「值表明显更小」时才划算，否则存原文
        if len(uniques) < 4000 and dict_len * 2 < total_len:
            index = {v: i for i, v in enumerate(uniques)}
            encoded.append({"d": uniques, "i": [index[v] for v in values]})
        else:
            encoded.append({"v": values})

    lei_vocab = [[name, count] for name, count in lei_counter.most_common()]
    major_dict = [[code, name, count] for (code, name), count in major_counter.most_common()]
    code_to_lei_out = {
        code: [lei for lei, _ in counter.most_common(3)]
        for code, counter in code_to_lei.items()
        if sum(counter.values()) >= 2          # 只保留出现 2 次以上的，压掉噪声
    }

    payload = {
        "meta": {
            "source": os.path.basename(xls_path),
            "total": total,
            "sheets": [s for s in book.sheet_names()],
        },
        "H": columns,
        "D": encoded,
        "leiVocab": lei_vocab,
        "majorDict": major_dict,
        "codeToLei": code_to_lei_out,
        "provinces": PROVINCES,
        # 备注风险标签：正则在 JS 侧执行，这里只声明定义
        "tagDefs": [
            ["应届", "涉及应届身份", "应届"],
            ["四级", "要求英语四级", "四级"],
            ["六级", "要求英语六级", "六级"],
            ["性别", "含性别相关要求", "男性|女性|适合男性|适合女性|限男性|限女性"],
            ["户籍", "含户籍/生源限制", "户籍|生源地|生源"],
            ["服务期", "有最低服务年限", "最低服务[年限]*[0-9一二三四五]+年|[0-9一二三四五]+年最低服务|服务期"],
            ["体能", "需体能测评/体检", "体能|体检"],
            ["艰苦", "标注艰苦或偏远", "艰苦|偏远|高原|高寒|野外|夜间"],
        ],
    }

    out_dir = os.path.join(os.path.dirname(os.path.abspath(xls_path)), "data")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "positions.js")

    with open(out_path, "w", encoding="utf-8") as f:
        f.write("// 由 build_data.py 生成，请勿手工编辑\n")
        f.write("window.GK_DATA=")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")

    size_mb = os.path.getsize(out_path) / 1048576.0
    print("写出 %s  (%.2f MB)" % (out_path, size_mb))
    print("类目词表 %d 条，专业代码表 %d 条，类目归属映射 %d 条"
          % (len(lei_vocab), len(major_dict), len(code_to_lei_out)))
    print("类目前 12: %s" % " / ".join("%s(%d)" % (n, c) for n, c in lei_vocab[:12]))
    print("招录类别: %s" % Counter(categories).most_common())

    if total != 19426:
        print("!! 警告: 职位数 %d 与基准 19426 不一致，请核对源表" % total)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
