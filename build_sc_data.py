# -*- coding: utf-8 -*-
"""
把四川省考职位表 .xlsx 编译成网页可直接加载的数据文件 data/sc_positions.js

用法:  python -I build_sc_data.py "2027四川省考岗位汇总表.xlsx" [原表.xlsx] [报名人数统计表.xls]

不给报名人数统计表时，自动用目录里最新的一份（文件名含「报名人数统计」，
日期按「截止X月X日X点」挑）。统计表每天更新，重新运行本脚本即可。

输出:  data/sc_positions.js   ->  window.SC_DATA = {...}

与 build_data.py（国考）的分工相同：这里只做「抽取 + 压缩」，
专业分词、资格判定、标签推断全部放在 sc_match.js 里，避免两套逻辑漂移。

数据源是《2027四川省考岗位汇总表》：6 个 sheet 按考试类目分，4,561 个职位。
它比原来的《…职位情况表》63 个 sheet 那份多 560 个（定向公务员 276、监狱 218、
戒毒 9、公安 51、特警 6），重合的 4,001 条逐字段一致，所以以汇总表为唯一来源。

这份表的结构上要注意四点：
  * 表头不在固定行：定向公务员那张第 1 行是说明、第 2 行才是表头，
    所以按「职位编码」定位表头，不能写死行号。
  * 列名和原表不一致：市（州）/ 录用名额 / 招考对象 / 联系方式 / 招录职位，
    在 SOURCE_ALIASES 里映射到统一列名。
  * 加试、体能这几列按类目拆开了：警察那张齐全，法院只有体能，综合/司法行政/定向
    一个都没有。缺列时补「否」——原表 4,001 行里这些组合本来就全是「否」，
    唯一的例外是定向那 276 行，那里确实没列，留空。
  * 定向公务员只有 9 列：没有学历、学位、专业、政治面貌，工具判不了，
    所以单独标成「定向招录」，不参与硬条件判断（见 sc_match.js 的 matchRow）。
  * 可选的第 2 个参数是原表，用来补回「审核单位」——汇总表丢了南充 76 行的这一列。
"""

import json
import os
import re
import sys
from collections import Counter, defaultdict

import openpyxl

if not sys.stdout.isatty():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

# 输出列。前 15 列是原表字段名，后 14 列是改名/派生字段。
# 名字尽量短而稳定，前端卡片与 CSV 都按这些键取值。
COLUMNS = [
    "职位编码", "市州", "系统类别", "招录机关", "内设机构", "职位名称",
    "考试类别", "职位简介", "拟任职务", "招录名额", "考录范围", "考录对象",
    "学历", "学位", "专业", "政治面貌",
    "笔试开考比例", "面试开考比例", "成绩占比",
    "加试专业", "加试民族语言", "加试心理测试", "体能测评",
    "考察比例", "其他要求", "民族自治州驻地", "咨询电话", "备注", "审核单位",
    # 来自另一份《报名人数统计表》，按职位编码并进来；每天一份，见 load_reg_stats
    "报名比例",
]

# 报名人数统计表的文件名形如「…(截止10月31日17点).xls」，日期直接从文件名读
CUTOFF_RE = re.compile(r"截止\s*(\d{1,2})月(\d{1,2})日\s*(?:(\d{1,2})[点时])?")

# 原表表头（去掉换行后） -> 输出列名
SOURCE_ALIASES = {
    "地区、部门": "市州",
    "市（州）": "市州",
    "录用名额": "招录名额",
    "招考对象": "考录对象",
    "联系方式": "咨询电话",
    # 定向那张表里「招录机关」是区县，「招录职位」才是具体单位，对应一般表的「内设机构」
    "招录职位": "内设机构",
    "笔试、面试成绩占比": "成绩占比",
    "笔试加试科目一（专业科目）": "加试专业",
    "笔试加试科目二（少数民族语言）": "加试民族语言",
    "笔试加试科目三（心理素质测试）": "加试心理测试",
    "是否开展体能测评": "体能测评",
    "单位驻地是否在少数民族自治州、自治县": "民族自治州驻地",
}

SYSTEMS = ("人民警察", "参照管理", "司法行政", "法院系统", "检察院系统",
           "省级机关", "监狱系统", "戒毒系统", "定向公务员")

# 汇总表里「警察、监狱戒毒」一张 sheet 混了四个系统，按职位编码前缀分开；
# 「法院检察院」同理。前缀对应关系是拿原表 63 个 sheet 的划分核对出来的。
SHEET_BY_PREFIX = {"29": "监狱系统", "42": "戒毒系统", "43": "人民警察", "81": "人民警察"}
AUTONOMOUS = ("阿坝州", "甘孜州", "凉山州")

# 类目名里不允许出现的字，挡住「本科专业为电子信息类」这种误切
LEI_STOPWORDS = ("本科", "研究生", "硕士", "博士", "专业", "学历", "学位", "或", "和", "及", "的", "为", "须", "是", "、")
LEI_LEAD_JUNK_RE = re.compile(
    r"^(?:.*(?:招收|招录|招考|面向))?"
    r"(?:(?:本科|研究生|硕士|博士|专业|学历|学位|阶段|所学|以上|须|需|为|是|的|应|限|或|和|及|与)+)?"
)


def clean(text):
    """单元格 -> 字符串。换行在专业/备注里是有意义的排版，保留为 \n。"""
    if text is None:
        return ""
    text = str(text).replace("\r\n", "\n").replace("\r", "\n")
    # 全角空格与制表符清掉，普通空格也清掉：表里大量「地区、部\n门」这种折行
    text = text.replace("　", "").replace("\t", "").replace(" ", "")
    # 连续空行压成一行
    return re.sub(r"\n{2,}", "\n", text).strip()


def header_key(text):
    """表头也要去掉换行：阿坝州那张表的表头是「地区、部\\n门」。"""
    if text is None:
        return ""
    return re.sub(r"\s+", "", str(text))


def flat(text):
    """用于分词/匹配：把换行也去掉，让「国际法\n研究生：…」能接着切段。"""
    return text.replace("\n", "")


def is_lei(name):
    if not name.endswith("类") or len(name) < 3 or len(name) > 12:
        return False
    return not any(w in name for w in LEI_STOPWORDS)


def extract_major(raw):
    """从专业栏原文里抽取类目名，只用于建词表，不参与匹配判定。"""
    leis = set()
    for run in re.findall(r"[一-龥]+", flat(raw)):
        start = 0
        for match in re.finditer("类", run):
            cand = LEI_LEAD_JUNK_RE.sub("", run[start:match.end()])
            start = match.end()
            if is_lei(cand):
                leis.add(cand)
    # 排序后返回：set 的迭代顺序随 PYTHONHASHSEED 变，会让计数相同的类目在
    # 词表里互相调换位置，两次构建出来的文件因此对不上（内容等价，只是顺序）。
    return sorted(leis)


def extract_names(raw):
    """专业栏里的专业名。只给「名称 -> 类目」提示表用，不做判定。"""
    names = set()
    text = flat(raw)
    for seg in re.split(r"本科|研究生|硕士|博士", text):
        for piece in re.split(r"[,;:/()\[\]{}、\n（）:：]", seg):
            piece = re.sub(r"^[0-9A-Za-z]+", "", piece)
            piece = re.sub(r"(等专业|等学科门类|等|专业|学科门类)$", "", piece)
            if not (2 <= len(piece) <= 24):
                continue
            if not re.fullmatch(r"[一-龥]+", piece):
                continue
            if piece in ("不限", "二级学科") or is_lei(piece):
                continue
            names.add(piece)
    return sorted(names)  # 同上：排序后输出，构建才可复现


def common_prefix_len(a, b):
    n = 0
    while n < len(a) and n < len(b) and a[n] == b[n]:
        n += 1
    return n


def load_gk_class_hints(sc_text, lei_set):
    """从国考构建产物里借一张「专业名 → 专业类」表。

    省考表基本不写专业代码，也没有「0809计算机类」这种写法，所以像
    「数据科学与大数据技术」这种和类目名毫无字面关系的专业，光看省考表推不出来
    （39 行提到它，只有 1 行同时写了类目名）。国考表里代码和类目名都规范，
    可以按代码前缀对上：080910T → 0809 → 计算机类。

    只收「唯一确定类目」的，且这个专业要在省考表里真的出现过——宁缺勿错。
    国考数据不存在时返回空表，不影响构建。
    """
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "positions.js")
    if not os.path.exists(path):
        print("  未找到 data/positions.js，跳过国考码表补充")
        return {}
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    text = text[text.index("window.GK_DATA=") + len("window.GK_DATA="):].strip()
    gk = json.loads(text.rstrip(";"))
    code_to_lei = gk.get("codeToLei") or {}

    hints = defaultdict(set)
    for entry in gk.get("majorDict") or []:
        code, name = entry[0], entry[1]
        if not re.fullmatch(r"[一-龥]{2,20}", name) or "研究生" in name:
            continue
        if name not in sc_text:
            continue
        # 国考里同一个专业名可能挂着不同代码（简称、笔误），归到的类目只是候选；
        # 最后只收「候选唯一」的，两个以上就算推不准
        for lei in code_to_lei.get(str(code)[:4], []):
            if lei in lei_set:
                hints[name].add(lei)
    return {name: sorted(leis) for name, leis in hints.items() if len(leis) == 1}


def system_of(sheet_name, code):
    """sheet 名（+ 职位编码前缀）-> 系统类别。

    汇总表按考试类目分 sheet，类目比系统粗，所以两张混装的 sheet 再按编码前缀拆：
    33 法院、34 检察院、29 监狱、42 戒毒、43 公安、81 特警。
    原表 63 个 sheet 的老名字是「市州-人民警察」这种，仍按后缀认，两边都能跑。
    """
    if sheet_name == "综合、县乡":
        return "参照管理"
    if sheet_name == "省直机关":
        return "省级机关"
    if sheet_name == "司法行政":
        return "司法行政"
    if sheet_name == "法院检察院":
        return "法院系统" if code[:2] == "33" else "检察院系统"
    if sheet_name == "警察、监狱戒毒":
        return SHEET_BY_PREFIX.get(code[:2], "人民警察")
    if sheet_name == "定向公务员":
        return "定向公务员"
    if sheet_name in ("法院系统", "检察院系统", "省级机关"):
        return sheet_name
    for suffix in ("人民警察", "参照管理", "司法行政"):
        if sheet_name.endswith("-" + suffix):
            return suffix
    return sheet_name


def load_review_units(path):
    """从原表补「审核单位」：只有「南充市-参照管理」那张有这一列，76 行有值。

    汇总表按类目重排后把这列丢了。它是受理审核的区县（顺庆区 / 高坪区 / …），
    不等于工作地点——工作地点在备注里。文件不在就返回空表，不影响构建。
    """
    if not path or not os.path.exists(path):
        return {}
    book = openpyxl.load_workbook(path, read_only=True, data_only=True)
    out = {}
    for ws in book.worksheets:
        sheet_rows = list(ws.iter_rows(values_only=True))
        header = None
        for i, row in enumerate(sheet_rows):
            vals = [header_key(v) for v in row]
            if "职位编码" in vals:
                header = vals
                header_at = i
                break
        if header is None or "审核单位" not in header:
            continue
        ci, ri = header.index("职位编码"), header.index("审核单位")
        for row in sheet_rows[header_at + 1:]:
            if len(row) <= max(ci, ri):
                continue
            code, unit = clean(row[ci]), clean(row[ri])
            if code.isdigit() and unit:
                out[code] = unit
    book.close()
    return out


def cutoff_text(text):
    """「…(截止10月31日17点).xls」-> 「10月31日17点」；没有日期返回空串。"""
    m = CUTOFF_RE.search(text or "")
    if not m:
        return ""
    out = "%d月%d日" % (int(m.group(1)), int(m.group(2)))
    if m.group(3):
        out += "%d点" % int(m.group(3))
    return out


def find_reg_file(base_dir):
    """在项目目录里找最新的一份报名人数统计表。

    每天下载的文件都带「截止X月X日X点」，按这个日期挑最新；文件名里没有日期时
    退回修改时间。找不到返回 None，构建照常进行，只是没有报名比例。
    """
    best = None
    for name in os.listdir(base_dir):
        if not name.lower().endswith((".xls", ".xlsx")):
            continue
        if "报名人数统计" not in name:
            continue
        path = os.path.join(base_dir, name)
        m = re.search(r"(\d{1,2})月(\d{1,2})日\s*(?:(\d{1,2})[点时])?", name)
        key = ((int(m.group(1)), int(m.group(2)), int(m.group(3) or 0))
               if m else (0, 0, 0))
        key = key + (os.path.getmtime(path),)
        if best is None or key > best[0]:
            best = (key, path)
    return best[1] if best else None


def cell_text(value):
    """单元格 -> 文本。xlrd 会把编码读成 36101001.0，去掉小数尾巴。"""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return clean(value)


def reg_sheet_rows(path):
    """读统计表的每个 sheet（行列表）。按文件头判断格式，不看扩展名。

    官方文件其实是 xlsx、扩展名却写 .xls，所以 xlsx 分支把文件对象交给 openpyxl，
    绕开扩展名校验；万一以后真换成老式 .xls（BIFF），再用 xlrd 读。
    """
    with open(path, "rb") as fh:
        head = fh.read(2)
    sheets = []
    if head == b"PK":
        # read_only 模式是边读边从 zip 里取行的，文件对象要一直开到遍历完
        with open(path, "rb") as fh:
            book = openpyxl.load_workbook(fh, read_only=True, data_only=True)
            for ws in book.worksheets:
                sheets.append(list(ws.iter_rows(values_only=True)))
            book.close()
    else:
        import xlrd
        book = xlrd.open_workbook(path)
        for ws in book.sheets():
            sheets.append([tuple(ws.row_values(r)) for r in range(ws.nrows)])
    return sheets


def load_reg_stats(path):
    """读取《报名人数统计表》：职位编码 -> 缴费比例区间，以及截止日期。

    表头在第 2 行（第 1 行是大标题），列为：所属地市、招录机关、职位编码、
    职位名称、缴费状况(缴费人数与招录名额的比例区间)。值就是区间本身，
    如「<5:1」「≥30:1且<50:1」，工具不改写、不折算成具体人数。
    """
    ratios = {}
    title = ""
    for sheet_rows in reg_sheet_rows(path):
        header_at = None
        header = None
        for i, row in enumerate(sheet_rows):
            vals = [header_key(v) for v in row]
            if "职位编码" in vals:
                header_at, header = i, vals
                break
        if header_at is None:
            if not title and sheet_rows and sheet_rows[0]:
                title = clean(sheet_rows[0][0])
            continue
        ri = None
        for i, name in enumerate(header):
            # 「缴费状况(缴费人数与招录名额的比例区间)」；别把「开考比例」认进来
            if "缴费" in name or ("比例" in name and "开考" not in name):
                ri = i
                break
        if ri is None:
            continue
        ci = header.index("职位编码")
        for row in sheet_rows[header_at + 1:]:
            if len(row) <= max(ci, ri):
                continue
            code = cell_text(row[ci])
            value = cell_text(row[ri])
            if code.isdigit() and value:
                ratios[code] = value

    name = os.path.basename(path)
    cutoff = cutoff_text(name) or cutoff_text(title)
    # 报名截止后官方会出最后一份，文件名/标题带「最后一次公布」：
    # 页面上标出来，免得后面几天还在等新数据
    final = "最后一次" in name or "最后一次" in title
    return ratios, cutoff, final


def main():
    if len(sys.argv) < 2:
        print("用法: python -I build_sc_data.py <汇总表.xlsx> [原表.xlsx] [报名人数统计表.xls]")
        return 1
    xlsx_path = sys.argv[1]
    if not os.path.exists(xlsx_path):
        print("找不到文件: %s" % xlsx_path)
        return 1
    # 第二个参数可选：原表里多一列「审核单位」，补回来
    legacy_path = sys.argv[2] if len(sys.argv) > 2 else None
    review_units = load_review_units(legacy_path)
    if legacy_path:
        print("审核单位: 从原表补回 %d 行" % len(review_units))

    # 第三个参数可选：报名人数统计表。不给就在目录里找最新的那份，
    # 文件名里的「截止X月X日X点」既是挑选依据，也是页面顶部显示的统计日期
    base_dir = os.path.dirname(os.path.abspath(__file__))
    reg_arg = sys.argv[3] if len(sys.argv) > 3 else None
    if reg_arg and not os.path.exists(reg_arg):
        print("找不到报名人数统计表: %s" % reg_arg)
        return 1
    reg_path = reg_arg or find_reg_file(base_dir)
    reg_ratios, reg_cutoff, reg_final = {}, "", False
    if reg_path:
        reg_ratios, reg_cutoff, reg_final = load_reg_stats(reg_path)
        print("报名比例: %s（截至%s%s）%d 行" % (
            os.path.basename(reg_path), reg_cutoff or "日期未知",
            "，最后一次公布" if reg_final else "", len(reg_ratios)))
        if not reg_ratios:
            print("!! 统计表里没读到报名比例，检查表头是否为「职位编码 / 缴费状况」")
    else:
        print("报名比例: 目录里没有《报名人数统计表》，跳过")

    book = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)

    rows = []
    sheets_used = []
    dropped = Counter()

    for ws in book.worksheets:
        sheet_rows = list(ws.iter_rows(values_only=True))
        header_at = None
        header = None
        for i, row in enumerate(sheet_rows):
            vals = [header_key(v) for v in row]
            if "职位编码" in vals:
                header_at = i
                header = vals
                break
        if header_at is None:
            dropped["无表头"] += 1
            continue

        index = {}
        for i, name in enumerate(header):
            if not name:
                continue
            index[SOURCE_ALIASES.get(name, name)] = i

        # 这类 sheet 按类目拆了列：没放加试/体能列就说明这个系统没有这几项加试，
        # 原表 4,001 行里这些组合全是「否」。定向公务员那张是真的没列，留空。
        fill_no = ws.title != "定向公务员"

        sheet_count = 0
        for row in sheet_rows[header_at + 1:]:
            if not row or all(v is None or str(v).strip() == "" for v in row):
                continue
            values = {}
            for col in COLUMNS:
                if col in ("市州", "系统类别"):
                    continue
                pos = index.get(col)
                value = clean(row[pos]) if pos is not None and pos < len(row) else ""
                # 长文本保留换行（卡片按原文展示），其余字段折行只是排版，
                # 留着会让「考录对象」多出几个仅差换行的不同取值
                if col not in ("专业", "职位简介", "其他要求", "备注"):
                    value = value.replace("\n", "")
                values[col] = value

            code = values["职位编码"]
            # 每个 sheet 末尾的「说明：招录职位…」不是职位
            if not re.match(r"^\d+$", code):
                dropped["说明/空行"] += 1
                continue

            values["市州"] = clean(row[index["市州"]]) if "市州" in index else ""
            values["系统类别"] = system_of(ws.title, code)

            if fill_no:
                for col in ("加试专业", "加试民族语言", "加试心理测试", "体能测评"):
                    if col not in index:
                        values[col] = "否"
            # 驻地这一列定向那张也没有，但三个自治州整州都在自治范围内，
            # 按市州就能确定；其余市州的自治县（北川、峨边、马边）不猜，留空
            if "民族自治州驻地" not in index and values["市州"] in AUTONOMOUS:
                values["民族自治州驻地"] = "是"
            if review_units.get(code):
                values["审核单位"] = review_units[code]
            values["报名比例"] = reg_ratios.get(code, "")
            rows.append([values[c] for c in COLUMNS])
            sheet_count += 1

        if sheet_count:
            sheets_used.append(ws.title)

    total = len(rows)
    print("读取职位数: %d（跳过 %d 行）" % (total, sum(dropped.values())))
    print("sheet: %d 个有数据" % len(sheets_used))

    if reg_ratios:
        code_at = COLUMNS.index("职位编码")
        sys_at = COLUMNS.index("系统类别")
        missing = [row[sys_at] for row in rows if not reg_ratios.get(row[code_at])]
        print("报名比例覆盖 %d/%d 个职位，未列 %d 个%s" % (
            total - len(missing), total, len(missing),
            "（%s）" % " / ".join("%s %d" % (s, n) for s, n in Counter(missing).most_common())
            if missing else ""))
        known = {row[code_at] for row in rows}
        extra = [code for code in reg_ratios if code not in known]
        if extra:
            print("!! 统计表里有 %d 个职位编码不在职位表中: %s" % (len(extra), "、".join(extra[:8])))

    # ---- 派生词表（全部来自这份表自身）------------------------------------
    col = {name: i for i, name in enumerate(COLUMNS)}
    lei_counter = Counter()
    major_counter = Counter()
    code_to_lei = defaultdict(Counter)
    name_to_lei = defaultdict(Counter)

    for values in rows:
        raw = values[col["专业"]]
        text = flat(raw)
        leis = extract_major(raw)
        for lei in leis:
            lei_counter[lei] += 1

        # 名称 -> 类目提示：只认「专业名和类目名共享 ≥2 字前缀」的组合。
        # 同一行里光共现不能当依据（工程管理会和计算机类同格出现），
        # 但「计算机科学与技术 / 计算机类」共享前缀，是可靠的。
        names = extract_names(raw)
        for name in names:
            hits = [lei for lei in leis if common_prefix_len(name, lei[:-1]) >= 2]
            if len(hits) == 1:
                name_to_lei[name][hits[0]] += 1

        # 代码在前：「030101K法学」「0301法学」「03法学」
        for code, name in re.findall(r"(?<![0-9])([0-9]{6}[A-Z]?)([一-龥]{2,20})", text):
            major_counter[(code, name)] += 1
        for code, name in re.findall(r"(?<![0-9])([0-9]{4})([一-龥]{2,20})", text):
            major_counter[(code, name)] += 1
        for code, name in re.findall(r"(?<![0-9])(0[1-9]|1[0-4])([一-龥]{2,20})", text):
            major_counter[(code, name)] += 1
        # 名称在前：「法学（0301）」「会计（学）（1253）」
        for name, code in re.findall(r"([一-龥]{2,20})[（(]([0-9]{2,6}[A-Z]?)[）)]", text):
            major_counter[(code, name)] += 1

        # 类目归属只认紧邻写法：0809计算机类 / 03法学类 / 法学类（0301）
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
        "".join(flat(r[col["专业"]]) for r in rows), set(lei_counter))

    # ---- 列存 + 字典编码 ---------------------------------------------------
    all_columns = [[row[i] for row in rows] for i in range(len(COLUMNS))]
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

    regions = [[name, count] for name, count in Counter(r[col["市州"]] for r in rows).most_common()]
    systems = [[name, count] for name, count in Counter(r[col["系统类别"]] for r in rows).most_common()]

    payload = {
        "meta": {
            "source": os.path.basename(xlsx_path),
            "total": total,
            "sheets": len(sheets_used),
            # 报名人数统计表的截止日期与文件名；没放统计表时为空，页面不显示报名比例
            "regDate": reg_cutoff,
            "regFinal": reg_final,
            "regFile": os.path.basename(reg_path) if reg_path else "",
            "regRows": len(reg_ratios),
        },
        "H": COLUMNS,
        "D": encoded,
        "leiVocab": [[name, count] for name, count in lei_counter.most_common()],
        "majorDict": [[code, name, count] for (code, name), count in major_counter.most_common()],
        "codeToLei": {
            code: [lei for lei, _ in counter.most_common(3)]
            for code, counter in code_to_lei.items()
            if sum(counter.values()) >= 2
        },
        # 没有代码时的兜底提示：靠专业名与类目名的共同前缀判断，宁缺勿错
        "nameToLei": {
            name: [lei for lei, _ in counter.most_common(2)]
            for name, counter in name_to_lei.items()
        },
        # 省考表里推不出来的专业，借国考的「代码 → 类目」补上
        "majorClass": major_class,
        "regions": regions,
        "systems": systems,
    }

    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "sc_positions.js")

    with open(out_path, "w", encoding="utf-8") as f:
        f.write("// 由 build_sc_data.py 生成，请勿手工编辑\n")
        f.write("window.SC_DATA=")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")

    size_mb = os.path.getsize(out_path) / 1048576.0
    print("写出 %s  (%.2f MB)" % (out_path, size_mb))
    print("类目词表 %d 条，专业代码表 %d 条，类目归属映射 %d 条，国考补充 %d 条"
          % (len(payload["leiVocab"]), len(payload["majorDict"]),
             len(payload["codeToLei"]), len(payload["majorClass"])))
    print("地区: %s" % " / ".join("%s(%d)" % (n, c) for n, c in regions))
    print("系统: %s" % " / ".join("%s(%d)" % (n, c) for n, c in systems))

    if total != 4561:
        print("!! 警告: 职位数 %d 与基准 4561 不一致，请核对源表" % total)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
