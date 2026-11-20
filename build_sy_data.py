# -*- coding: utf-8 -*-
"""
把四川省事业单位岗位汇总表 .xlsx 编译成网页可直接加载的数据文件
data/sy_positions.js

用法:  python -I build_sy_data.py [岗位表.xlsx ...]

不给文件名时优先读当前目录的「20日9点】26下四川事业单位岗位汇总表.xlsx」；
没有这份文件时再扫描目录里表头含「岗位编码 / 招聘范围」的 .xlsx/.xls。

汇总表一份文件里有 22 个 sheet（省直属 + 21 个市州），每个 sheet 都是
第 1 行大标题、第 2 行分组标题、第 3 行列名、第 4 行起数据。列数有 29 / 30
两种（省直属没有「序号」，绵阳没有「省级主管部门」），所以按列名定位，
不按固定列号。

输出:  data/sy_positions.js  ->  window.SY_DATA = {...}

和 build_sc_data.py 一样，这里只做「抽取 + 压缩 + 少量派生列」，
招聘范围、专业匹配、资格判定全部在 sy_match.js 里，两边不会各说各话。
专业词表相关的几个小函数直接从 build_sc_data.py 借用。
"""

import json
import os
import re
import sys
from collections import Counter, defaultdict

import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_sc_data import (  # noqa: E402  两个构建脚本共用同一套专业词表规则
    common_prefix_len, extract_major, extract_names, flat, header_key,
    is_lei, load_gk_class_hints,
)

DEFAULT_SOURCE = "20日9点】26下四川事业单位岗位汇总表.xlsx"

# 输出列。前 28 列是原表字段（列名改短、去掉括号说明），后面是派生列。
# 派生列只为了筛选和判定，卡片上仍显示原文。
COLUMNS = [
    "岗位编码", "市州", "县市区", "招聘单位", "招聘范围", "岗位名称",
    "岗位类别及等级", "招聘名额", "年龄", "政治面貌", "学历学位", "专业",
    "职称资格", "工作经历", "公共科目", "专业科目", "笔试成绩计算",
    "笔试合格线", "笔试开考比例", "综合面试", "专业面试", "面试成绩计算",
    "面试合格线", "面试入围比例", "总成绩计算", "最低服务期", "咨询电话", "备注",
    # ---- 派生 ----
    "岗位类别", "学历要求", "学位要求", "考试科目", "教资要求", "服务期年数",
    "年龄截止", "年龄研究生截止", "年龄可放宽2岁",
]

DERIVED = set(COLUMNS[28:])

# 原表表头（去掉空白后） -> 输出列名
SOURCE_ALIASES = {
    "招聘名额（人）": "招聘名额",
    "招聘名额": "招聘名额",
    "学历/学位": "学历学位",
    "专业（学科）": "专业",
    "职称/资格证书": "职称资格",
    "工作经历要求": "工作经历",
    "笔试成绩合格分数线": "笔试合格线",
    "面试成绩合格分数线": "面试合格线",
    "岗位咨询联系人及电话": "咨询电话",
}

# 专业栏的学历分段。省考的 match.js 只切本科/研究生，事业单位还有大专段
LEVEL_MARK_RE = re.compile(r"(大专|专科|本科|研究生|硕士|博士)")

EDU_RE = re.compile(r"(?:大学)?(专科|本科|研究生|硕士|博士)学历")
EDU_LABEL = {"专科": "大专及以上", "本科": "本科及以上",
             "研究生": "研究生及以上", "硕士": "研究生及以上",
             "博士": "研究生及以上"}

# 「同时设专业学位类别，代码为 1055」是括号里的补充说明，把整段换成
# 「（1055）」，既保留专业代码，又不让说明文字混进专业名。
CODE_NOTE_RE = re.compile(
    r"[（(][^（）()]*代码为\s*([0-9]{4,6}[A-Za-z]?)[^（）()]*[）)]")


def clean_cell(value, keep_breaks=False):
    """单元格 -> 文本。保留一个空格：公共科目「教育类 教育公共基础」靠它分段。

    与 build_sc_data.clean 的区别是不把所有空格删光——那份表大量「地区、部\\n门」
    折行，必须删；这份表的空格是正常分隔，删了反而不成句。
    """
    if value is None:
        return ""
    text = str(value).replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t　]+", " ", text)
    if not keep_breaks:
        text = text.replace("\n", " ")
    text = re.sub(r"\n{2,}", "\n", text)
    return text.strip()


def clean_major(value):
    """专业栏原文 -> 适合分词和展示的文本。

    汇总表里专业之间大量用空格分隔（「会计学（120203K） 财务管理（120204）」），
    而前端 normalize 会把空格删掉，两个专业名会粘成一个。构建时把空格换成
    顿号，保证分词正确。

    折行 986 行，多数是「本科：…／研究生：…」的层次分隔，前端靠「本科/研究生」
    切段，不能动；只有折行两侧都不是分隔符时补一个「；」，避免两行粘在一起。
    卡片仍按 pre-wrap 展示，折行结构保留。
    """
    text = clean_cell(value, keep_breaks=True)
    if not text:
        return ""
    text = CODE_NOTE_RE.sub(r"（\1）", text)
    lines = [re.sub(r"[ \t　]+", "、", line.strip())
             for line in text.split("\n")]
    lines = [line for line in lines if line]
    if not lines:
        return ""
    out = lines[0]
    for line in lines[1:]:
        prev_ok = bool(re.search(r"[；;、,，:：]$", out))
        next_level = bool(re.match(
            r"(大专|专科|本科|研究生|硕士|博士)[：:]", line))
        out += ("\n" if prev_ok or next_level else "；\n") + line
    return out


def find_header(rows):
    """找真正的列名行：同时含「岗位编码」和「招聘范围」。

    汇总表第 1 行是大标题，第 2 行是「招聘岗位情况 / 招聘条件 …」分组行，
    第 3 行才是列名。按内容找，以后表头挪行也不影响。
    """
    for i, row in enumerate(rows):
        vals = [header_key(v) for v in row]
        if "岗位编码" in vals and "招聘范围" in vals:
            return i, vals
    return None, None


def parse_edu(text):
    """学历/学位 -> (学历要求, 学位要求)。

    「大学本科学历及以上，并取得相应学士及以上学位」-> 本科及以上 / 学士及以上
    「研究生学历，并取得相应硕士及以上学位」-> 研究生及以上 / 硕士及以上
    「大学专科学历及以上」-> 大专及以上 / 不限
    """
    m = EDU_RE.search(text or "")
    edu = EDU_LABEL.get(m.group(1), "") if m else ""
    if "学士及以上" in text:
        degree = "学士及以上"
    elif "硕士及以上" in text:
        degree = "硕士及以上"
    elif "博士" in text:
        degree = "博士"
    elif "学士学位" in text:
        # 只有 1 行写「大学本科学历，并取得相应学士学位」，没有「及以上」；
        # 它仍然要求学位，不能归到「不限」。
        degree = "学士及以上"
    else:
        degree = "不限"
    return edu, degree


def parse_cert(text):
    """职称/资格证书 -> 教师资格证学段要求。

    汇总表把教师资格证和医师、会计等职称混写在同一列，这里只在出现
    「教师资格」时才判断学段：
      小学 / 小学或初中或高中        -> 小学及以上
      初级中学或高级中学            -> 初中及以上
      高级中学 / 高中 / 高中或中职   -> 高中
      只写「中职」「相应种类」「相应学科学段」 -> 其他（不做学段判定）
    其余（医师、会计师、无、空）都算不限。
    """
    text = text or ""
    if "教师资格" not in text:
        return "不限"
    if "小学" in text:
        return "小学及以上"
    if "初级中学" in text and ("高级中学" in text or "高中" in text):
        return "初中及以上"
    if "高级中学" in text or "高中" in text:
        return "高中"
    if "初级中学" in text or "初中" in text:
        return "初中及以上"
    return "其他"


def parse_age(text):
    """年龄 -> (普通截止, 研究生截止, 是否可再放宽 2 周岁)。日期写成 ISO。"""
    def iso(m):
        return "%s-%02d-%02d" % (m.group(1), int(m.group(2)), int(m.group(3)))

    base = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日及以后出生", text or "")
    grad = re.search(
        r"研究生学历报考[（(](\d{4})年(\d{1,2})月(\d{1,2})日",
        text or "",
    )
    relax = "退役军人可再放宽2周岁" in (text or "")
    return (iso(base) if base else "",
            iso(grad) if grad else "",
            "是" if relax else "否")


def parse_service(text):
    m = re.search(r"服务期(\d+)年", text or "")
    if not m:
        m = re.search(r"(\d+)年服务期", text or "")
    return m.group(1) if m else ""


def parse_subject(text):
    m = re.match(r"(教育类|综合类|卫生类)", text or "")
    if m:
        return m.group(1)
    if "教育" in (text or ""):
        return "教育类"
    if "卫生" in (text or ""):
        return "卫生类"
    if "综合" in (text or ""):
        return "综合类"
    return ""


def parse_job_cat(text):
    if "管理" in (text or ""):
        return "管理"
    if "专业技术" in (text or ""):
        return "专业技术"
    if "工勤" in (text or ""):
        return "工勤技能"
    return ""


def load_sheet(path, book):
    """读一份表里的所有 sheet，返回职位行（dict 列表）。"""
    out = []
    for ws in book.worksheets:
        rows = list(ws.iter_rows(values_only=True))
        header_at, _ = find_header(rows)
        if header_at is None:
            continue

        # 两层表头：序号 / 省级主管部门 / 市州 / 县市区 / 招聘单位 只在上面
        # 那行，下面那行的前几格是合并单元格留下的空值。空位用上一行补回。
        header = [header_key(v) for v in rows[header_at]]
        if header_at > 0:
            above = [header_key(v) for v in rows[header_at - 1]]
            for i, name in enumerate(header):
                if not name and i < len(above):
                    header[i] = above[i]

        index = {}
        for i, name in enumerate(header):
            if not name:
                continue
            key = SOURCE_ALIASES.get(name, name)
            if key in COLUMNS:
                index[key] = i

        missing = [c for c in ("岗位编码", "市州", "县市区", "招聘单位",
                               "招聘范围", "岗位名称", "招聘名额")
                   if c not in index]
        if missing:
            print("  跳过 %s：缺列 %s" % (ws.title, "、".join(missing)))
            continue

        for row in rows[header_at + 1:]:
            if not row or all(v is None or str(v).strip() == "" for v in row):
                continue

            values = {}
            for col in COLUMNS:
                if col in DERIVED:
                    continue
                pos = index.get(col)
                if col == "专业":
                    value = clean_major(row[pos]) if pos is not None else ""
                else:
                    value = clean_cell(
                        row[pos] if pos is not None and pos < len(row) else None,
                        keep_breaks=(col == "备注"))
                values[col] = value

            code = values.get("岗位编码", "")
            if not re.match(r"^\d{6,}$", code):
                continue  # 表尾的「说明」行

            try:
                values["招聘名额"] = str(int(float(values["招聘名额"])))
            except ValueError:
                values["招聘名额"] = ""

            cat = values["岗位类别及等级"]
            values["岗位类别"] = parse_job_cat(cat)
            values["学历要求"], values["学位要求"] = parse_edu(values["学历学位"])
            values["考试科目"] = parse_subject(values["公共科目"])
            values["教资要求"] = parse_cert(values["职称资格"])
            values["服务期年数"] = parse_service(values["最低服务期"])
            (values["年龄截止"], values["年龄研究生截止"],
             values["年龄可放宽2岁"]) = parse_age(values["年龄"])
            values["_sheet"] = ws.title
            values["_source"] = os.path.basename(path)
            out.append(values)
    return out


def discover(base_dir):
    """优先读全省汇总表；没有时再扫描目录里所有事业单位岗位表。"""
    preferred = os.path.join(base_dir, DEFAULT_SOURCE)
    if os.path.exists(preferred):
        return [preferred]

    found = []
    for name in sorted(os.listdir(base_dir)):
        if not name.lower().endswith((".xlsx", ".xls")):
            continue
        path = os.path.join(base_dir, name)
        try:
            book = openpyxl.load_workbook(path, read_only=True, data_only=True)
            hit = any(find_header(list(ws.iter_rows(values_only=True)))[0]
                      is not None for ws in book.worksheets)
            book.close()
        except Exception:
            continue
        if hit:
            found.append(path)
    return found


def main():
    if not sys.stdout.isatty():
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass

    if len(sys.argv) > 1:
        paths = sys.argv[1:]
    else:
        paths = discover(HERE)
        if not paths:
            print("目录里没找到事业单位岗位表。用法: "
                  "python -I build_sy_data.py 岗位表.xlsx")
            return 1

    rows = []
    for path in paths:
        if not os.path.exists(path):
            print("找不到文件: %s" % path)
            return 1
        book = openpyxl.load_workbook(path, read_only=True, data_only=True)
        sheet_rows = load_sheet(path, book)
        book.close()
        print("%s: %d 个职位" % (os.path.basename(path), len(sheet_rows)))
        rows.extend(sheet_rows)

    if not rows:
        print("没有读到任何职位，检查表头是否为「岗位编码 / 招聘范围」")
        return 1

    # ---- 城市汇总：选择界面按这个渲染 --------------------------------------
    city_map = {}
    for values in rows:
        city = values["市州"]
        entry = city_map.setdefault(city, {
            "name": city,
            "title": city + "事业单位岗位表",
            "source": values["_source"],
            "count": 0,
            "headcount": 0,
            "counties": set(),
            "units": set(),
        })
        entry["count"] += 1
        entry["headcount"] += int(values["招聘名额"] or 0)
        if values["县市区"]:
            entry["counties"].add(values["县市区"])
        if values["招聘单位"]:
            entry["units"].add(values["招聘单位"])
    cities = []
    for entry in city_map.values():
        entry["counties"] = len(entry["counties"])
        entry["units"] = len(entry["units"])
        cities.append(entry)
    # 省直属永远排第一，其余按岗位数从多到少
    cities.sort(key=lambda c: (c["name"] != "省直属", -c["count"], c["name"]))

    # ---- 派生词表（专业名 / 代码 / 类目）----------------------------------
    lei_counter = Counter()
    major_counter = Counter()
    code_to_lei = defaultdict(Counter)
    name_to_lei = defaultdict(Counter)

    for values in rows:
        raw = values["专业"]
        text = flat(raw)
        leis = extract_major(raw)
        for lei in leis:
            lei_counter[lei] += 1

        # 大专段也要切出来，否则「大专：临床医学（520101K）」整段被当成
        # 本科段的叙述，专业名抽不出来
        for chunk in LEVEL_MARK_RE.split(raw):
            if chunk in ("大专", "专科", "本科", "研究生", "硕士", "博士"):
                continue
            for name in extract_names(chunk):
                hits = [lei for lei in leis if common_prefix_len(name, lei[:-1]) >= 2]
                if len(hits) == 1:
                    name_to_lei[name][hits[0]] += 1

        for code, name in re.findall(r"(?<![0-9])([0-9]{6}[A-Z]?)([一-龥]{2,20})", text):
            major_counter[(code, name)] += 1
        for code, name in re.findall(r"(?<![0-9])([0-9]{4})([一-龥]{2,20})", text):
            major_counter[(code, name)] += 1
        for code, name in re.findall(r"(?<![0-9])(0[1-9]|1[0-4])([一-龥]{2,20})", text):
            major_counter[(code, name)] += 1
        for name, code in re.findall(r"([一-龥]{2,20})[（(]([0-9]{2,6}[A-Z]?)[）)]", text):
            major_counter[(code, name)] += 1

        for code, lei in re.findall(r"(?<![0-9])([0-9]{4}[A-Z]?)([一-龥]{2,12}类)", text):
            if is_lei(lei):
                code_to_lei[code][lei] += 1
        for code, lei in re.findall(r"(?<![0-9])(0[1-9]|1[0-4])([一-龥]{2,12}类)", text):
            if is_lei(lei):
                code_to_lei[code][lei] += 1
        for lei, code in re.findall(r"([一-龥]{2,12}类)[（(]([0-9]{2,4})[）)]", text):
            if is_lei(lei):
                code_to_lei[code][lei] += 1

    major_class = load_gk_class_hints(
        "".join(flat(v["专业"]) for v in rows), set(lei_counter))

    # ---- 列存 + 字典编码 ---------------------------------------------------
    all_columns = [[values[c] for values in rows] for c in COLUMNS]
    encoded = []
    for values in all_columns:
        uniques = sorted(set(values))
        total_len = sum(len(v) for v in values)
        dict_len = sum(len(v) for v in uniques)
        if len(uniques) < 4000 and dict_len * 2 < total_len:
            index = {v: i for i, v in enumerate(uniques)}
            encoded.append({"d": uniques, "i": [index[v] for v in values]})
        else:
            encoded.append({"v": values})

    counties = [[name, count, city] for (city, name), count in sorted(
        Counter((v["市州"], v["县市区"]) for v in rows if v["县市区"]).items(),
        key=lambda kv: (-kv[1], kv[0][0], kv[0][1]))]

    payload = {
        "meta": {
            "sources": [os.path.basename(p) for p in paths],
            "total": len(rows),
            "cities": cities,
        },
        "H": COLUMNS,
        "D": encoded,
        "leiVocab": [[name, count] for name, count in lei_counter.most_common()],
        "majorDict": [[code, name, count]
                      for (code, name), count in major_counter.most_common()],
        "codeToLei": {
            code: [lei for lei, _ in counter.most_common(3)]
            for code, counter in code_to_lei.items()
            if sum(counter.values()) >= 2
        },
        "nameToLei": {
            name: [lei for lei, _ in counter.most_common(2)]
            for name, counter in name_to_lei.items()
        },
        "majorClass": major_class,
        "counties": counties,
    }

    out_dir = os.path.join(HERE, "data")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "sy_positions.js")
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write("// 由 build_sy_data.py 生成，请勿手工编辑\n")
        fh.write("window.SY_DATA=")
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write(";\n")

    print("写出 %s  (%.1f KB)" % (out_path, os.path.getsize(out_path) / 1024.0))
    print("合计 %d 个职位 / %d 人" % (
        len(rows), sum(int(v["招聘名额"] or 0) for v in rows)))
    for city in cities:
        print("  %s: %d 个职位 / %d 人 / %d 个区县 / %d 个单位" % (
            city["name"], city["count"], city["headcount"],
            city["counties"], city["units"]))
    print("类目词表 %d 条，专业代码表 %d 条，类目归属映射 %d 条，国考补充 %d 条"
          % (len(payload["leiVocab"]), len(payload["majorDict"]),
             len(payload["codeToLei"]), len(payload["majorClass"])))
    print("考试科目: %s" % " / ".join(
        "%s %d" % (k, n) for k, n in Counter(v["考试科目"] for v in rows).most_common()))
    print("学历要求: %s" % " / ".join(
        "%s %d" % (k, n) for k, n in Counter(v["学历要求"] for v in rows).most_common()))
    print("教资要求: %s" % " / ".join(
        "%s %d" % (k, n) for k, n in Counter(v["教资要求"] for v in rows).most_common()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
