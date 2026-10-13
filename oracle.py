# -*- coding: utf-8 -*-
"""
oracle.py —— 匹配逻辑的独立参考实现，只用来给 test_match.js 生成期望值。

刻意与 match.js 分开写（Excel 读取 + 分词思路独立），两边结果一致才能说明
match.js 没有写歪。这不是产品代码，改 match.js 后重跑它更新期望值即可:

    python -I oracle.py "2027年国考职位表（全国）.xls"
"""

import re
import sys
from collections import Counter, defaultdict

import xlrd

if not sys.stdout.isatty():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

COLS = [
    "部门代码", "部门名称", "用人司局", "机构性质", "招考职位", "职位属性",
    "职位分布", "职位简介", "职位代码", "机构层级", "考试类别", "招考人数",
    "专业", "学历", "学位", "政治面貌", "基层工作最低年限", "服务基层项目工作经历",
    "是否在面试阶段组织专业能力测试", "面试人员比例", "工作地点", "落户地点",
    "备注", "部门网站", "咨询电话1", "咨询电话2", "咨询电话3",
]

# 学历可行性（与 match.js 的 EDU_RULES 语义一致）
EDU_ALLOW = {
    "大专及以上": {"大专", "本科", "硕士", "博士"},
    "大专或本科": {"大专", "本科"},
    "仅限大专": {"大专"},
    "本科及以上": {"本科", "硕士", "博士"},
    "仅限本科": {"本科"},
    "本科或硕士研究生": {"本科", "硕士"},
    "硕士研究生及以上": {"硕士", "博士"},
    "仅限硕士研究生": {"硕士"},
    "仅限博士研究生": {"博士"},
}
LEVEL_RANK = {"大专": 0, "本科": 1, "硕士": 2, "博士": 3}
DEG_RANK = {"无": 0, "学士": 1, "硕士": 2, "博士": 3}
DEG_NEED = {"无要求": 0, "学士": 1, "硕士": 2, "博士": 3}
YEARS_NEED = {"无限制": 0, "一年": 1, "二年": 2, "三年": 3, "五年以上": 5}
POLITICS_ALLOW = {
    "不限": {"群众", "共青团员", "中共党员", "中共预备党员"},
    "中共党员": {"中共党员", "中共预备党员"},
    "中共党员或共青团员": {"中共党员", "共青团员", "中共预备党员"},
}

# 「本科生招收计算机类(0809)」这类写法，类名前挂着一截叙述文字，
# 只剥前缀虚词会剩下「生招收计算机类」—— 那不是类目，用户勾「计算机类」时就漏岗。
# 先切到最后一个招聘动词之后，再剥虚词。
LEAD = re.compile(r"^(?:.*(?:招收|招录|招考|面向))?(?:(?:本科|研究生|硕士|博士|专业|学历|学位|阶段|所学|以上|须|需|为|是|的|应(?=为)|限|或|和|及|与|包括|不含|除外)+)?")
TAIL = re.compile(r"(?:等专业|等学科门类|等|专业|学科门类)$")
CN = re.compile(r"^[一-龥]+$")
STOP = re.compile(r"(本科|研究生|硕士|博士|专业|学历|学位|或|和|及|的|为|须|是)")
PUNCT = str.maketrans("，、；：（）　", ",,;:() ")


def norm(t):
    return re.sub(r"\s+", "", str(t).translate(PUNCT))


def split_segments(text):
    parts = re.split(r"(本科|研究生|硕士|博士)", text)
    out, level = [], "any"
    for p in parts:
        if not p:
            continue
        if p in ("本科", "研究生", "硕士", "博士"):
            level = p
            continue
        out.append((level, p))
    return out or [("any", text)]


def is_lei(name):
    return 3 <= len(name) <= 12 and name.endswith("类") and not STOP.search(name)


def tokenize(piece):
    """一个片段 -> (类型, 值) 列表"""
    piece = TAIL.sub("", LEAD.sub("", piece))
    if not piece:
        return []
    m = re.match(r"^([0-9]{6}[A-Za-z]?)(.*)$", piece)
    if m:
        return [("c6", m.group(1).upper())] + tokenize(m.group(2))
    m = re.match(r"^([0-9]{4}[A-Za-z]?)(.*)$", piece)
    if m:
        return [("c4", m.group(1).upper())] + tokenize(m.group(2))
    m = re.match(r"^([0-9]{2})(.*)$", piece)
    if m and re.match(r"^(0[1-9]|1[0-4]|[3-9][0-9])$", m.group(1)):
        return [("c2", m.group(1))] + tokenize(m.group(2))
    if len(piece) > 24:
        return []
    if is_lei(piece):
        return [("lei", piece)]
    if CN.match(piece):
        return [("names", piece)]      # 键名必须与 tier_of 里查的一致
    return []


NEG_PAREN = re.compile(r"[([](?:[^()\[\]]*?)(?:不含|除外|不包括)(?:[^()\[\]]*?)[)\]]")
NEG_BARE = re.compile(r"不含[^;]{1,80}")


def tokenize_segment(segment):
    """按标点切片后逐个 tokenize —— 必须先切片，否则「财政学类,金融学类」会变成一个整词"""
    out = []
    for piece in re.split(r"[,;:/()\[\]{}]", segment):
        out.extend(tokenize(piece))
    return out


def analyze_major(raw):
    text = norm(raw)
    unlimited = text in ("不限", "无限制", "专业不限")
    buckets = defaultdict(lambda: defaultdict(list))
    neg = []
    special = False
    if unlimited or not text:
        return {"unlimited": unlimited, "byLevel": buckets, "neg": neg, "special": special}
    if re.search(r"除[^,;]{1,40}外", text):
        special = True
    if re.search(r"不含|除外|不包括", text) and not re.search(r"[([](?:[^()\[\]]*?)(?:不含|除外)", text):
        special = True
    for level, seg in split_segments(text):
        for neg_text in NEG_PAREN.findall(seg) + NEG_BARE.findall(seg):
            for tok in tokenize_segment(neg_text):
                neg.append(tok[1])
        positive = NEG_BARE.sub(",", NEG_PAREN.sub(",", seg))
        for tok in tokenize_segment(positive):
            buckets[level][tok[0]].append(tok[1])
    return {"unlimited": unlimited, "byLevel": buckets, "neg": neg, "special": special}


def load(path):
    book = xlrd.open_workbook(path, on_demand=True)
    rows = []
    for sheet_name in book.sheet_names():
        sheet = book.sheet_by_name(sheet_name)
        if sheet.nrows < 2 or sheet.ncols < 25:
            book.unload_sheet(sheet_name)
            continue
        for r in range(2, sheet.nrows):
            v = [norm(sheet.cell_value(r, c)) for c in range(len(COLS))]
            if v[0]:
                rows.append(v)
        book.unload_sheet(sheet_name)
    return rows


def applicable(profile, row):
    """按硬条件筛掉不适用的行，返回 None 或淘汰原因"""
    edu = EDU_ALLOW.get(row[13])
    if edu is not None and profile["level"] not in edu:
        return "学历不符"
    degree = row[14]
    if degree == "与最高学历相对应的学位":
        if DEG_RANK[profile["degree"]] < LEVEL_RANK[profile["level"]]:
            return "学位不符"
    elif degree in DEG_NEED and DEG_RANK[profile["degree"]] < DEG_NEED[degree]:
        return "学位不符"
    pol = POLITICS_ALLOW.get(row[15])
    if pol is not None and profile["politics"] not in pol:
        return "政治面貌不符"
    need = YEARS_NEED.get(row[16])
    if need is not None and profile["years"] < need:
        return "基层年限不足"
    if row[17] not in ("无限制", ""):
        return "缺少要求的基层项目经历"
    return None


def tier_of(profile, analysis):
    if analysis["unlimited"]:
        return "category"
    levels = ["any"] + ([profile["majorLevel"]] if profile["majorLevel"] in analysis["byLevel"] else [])
    merged = defaultdict(list)
    for lv in levels:
        for k, vs in analysis["byLevel"].get(lv, {}).items():
            merged[k].extend(vs)
    neg = analysis["neg"]

    hits = [c for c in profile["codes"] if c in merged["c6"] and c not in neg]
    hits += [n for n in profile["names"] if n in merged["names"] and n not in neg]
    if hits:
        return "exact"

    # 本科阶段专业名的简写：表里把「会计学」写成「会计」、把「审计学」写成「审计」。
    # 本科专业目录里没有叫「会计」的，这是表的简写，不是另一个专业。
    # 只限本科阶段：研究生那边「会计（1253）」「审计（0257）」是专业学位的正式名字。
    # 这段判定必须与 match.js 的 looseAlt() 逐字对应，两边漂移差分测试就白做了。
    if profile["majorLevel"] == "本科":
        for n in profile["names"]:
            alt = n[:-1] if n.endswith("学") else n + "学"
            if len(alt) < 2:
                continue
            if alt in merged["names"] and alt not in neg:
                return "exact"
    cls = [c for c in profile["classes"] if c in merged["lei"] and c not in neg]
    if cls:
        if all(re.search(r"(门类|大类|学科门类)$", c) for c in cls):
            return "category"
        return "class"
    return None


def main():
    if len(sys.argv) < 2:
        print("用法: python -I oracle.py <职位表.xls>")
        return 1
    rows = load(sys.argv[1])
    print("总行数: %d" % len(rows))
    assert len(rows) == 19426, "行数异常"

    profiles = [
        ("本科·数据科学与大数据技术·计算机类", {
            "level": "本科", "degree": "学士", "politics": "群众", "years": 0,
            "majorLevel": "本科", "names": ["数据科学与大数据技术"],
            "codes": ["080910T"], "classes": ["计算机类"]}),
        ("本科·法学·法学类", {
            "level": "本科", "degree": "学士", "politics": "群众", "years": 0,
            "majorLevel": "本科", "names": ["法学"], "codes": ["030101K"],
            "classes": ["法学类"]}),
        ("本科·会计学·工商管理类", {
            "level": "本科", "degree": "学士", "politics": "群众", "years": 0,
            "majorLevel": "本科", "names": ["会计学"], "codes": ["120203K"],
            "classes": ["工商管理类"]}),
        ("硕士·计算机科学与技术·计算机类", {
            "level": "硕士", "degree": "硕士", "politics": "中共党员", "years": 0,
            "majorLevel": "研究生", "names": ["计算机科学与技术"], "codes": [],
            "classes": ["计算机类"]}),
        ("大专·无专业限定", {
            "level": "大专", "degree": "无", "politics": "群众", "years": 0,
            "majorLevel": "大专", "names": [], "codes": [], "classes": []}),
    ]

    print("\n%-34s %8s %8s %8s %8s %8s" % ("画像", "精准", "专业类", "门类/不限", "合计", "淘汰-学历"))
    for label, profile in profiles:
        counts = Counter()
        edu_out = 0
        total = 0
        for row in rows:
            why = applicable(profile, row)
            if why:
                if why == "学历不符":
                    edu_out += 1
                continue
            analysis = analyze_major(row[12])
            t = tier_of(profile, analysis)
            if t:
                counts[t] += 1
                total += 1
        print("%-34s %8d %8d %8d %8d %8d" % (
            label, counts["exact"], counts["class"], counts["category"], total, edu_out))

    # 边界用例：法学类(不含监狱学)
    print("\n边界：含「不含」排除项的行")
    for row in rows:
        if "不含" in row[12] and len(row[12]) < 40:
            a = analyze_major(row[12])
            print("  专业=%s" % row[12])
            print("    排除项=%s" % sorted(set(a["neg"])))
            break
    return 0


if __name__ == "__main__":
    sys.exit(main())
