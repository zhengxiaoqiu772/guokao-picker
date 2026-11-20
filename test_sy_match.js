/**
 * test_sy_match.js —— sy_match.js 的验证脚本
 *
 *   node test_sy_match.js
 *
 * 数据来自 data/sy_positions.js（由 build_sy_data.py 从全省汇总表生成）。
 * 期望值是 2026 年下半年四川事业单位岗位汇总表的真实计数；源表换了要重跑
 * build_sy_data.py，再按新数字更新。
 */
'use strict';

global.window = global;
require('./data/sy_positions.js');
require('./match.js');
require('./sy_match.js');

const SY = global.SYMatch;
const DATA = global.SY_DATA;

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.log('  ✗ ' + name + '\n      期望 ' + JSON.stringify(expected) +
                '\n      实际 ' + JSON.stringify(actual));
  }
}

function section(title) { console.log('\n' + title); }

const P = (o) => Object.assign({}, SY.DEFAULT_PROFILE, o || {});
const run = (o, opts) => SY.filterRecords(records, P(o), opts || {});
const count = (fn) => records.filter(fn).length;

/* =====================================================================
 * 一、载入
 * ===================================================================*/
section('一、数据载入');
const t0 = Date.now();
const records = SY.unpack(DATA);
const loadMs = Date.now() - t0;

check('岗位总数', records.length, 7821);
check('招聘总人数', records.reduce((a, r) => a + r.headcount, 0), 10878);
check('列数', DATA.H.length, 37);
check('来源文件', DATA.meta.sources,
  ['20日9点】26下四川事业单位岗位汇总表.xlsx']);
check('城市（含省直属）', DATA.meta.cities.length, 22);
check('区县条目数（按市州分开计）', DATA.counties.length, 202);

check('各市州规模', DATA.meta.cities.map((c) => [c.name, c.count, c.headcount, c.counties]), [
  ['省直属', 395, 550, 0],
  ['成都市', 2061, 3394, 24],
  ['广元市', 578, 693, 8],
  ['凉山州', 505, 768, 18],
  ['内江市', 428, 513, 8],
  ['宜宾市', 401, 482, 12],
  ['德阳市', 356, 464, 8],
  ['巴中市', 323, 434, 7],
  ['雅安市', 252, 289, 9],
  ['达州市', 250, 346, 8],
  ['绵阳市', 228, 306, 11],
  ['阿坝州', 220, 261, 12],
  ['南充市', 215, 371, 7],
  ['眉山市', 210, 245, 8],
  ['遂宁市', 205, 295, 5],
  ['攀枝花市', 194, 276, 6],
  ['乐山市', 193, 239, 8],
  ['泸州市', 182, 210, 7],
  ['甘孜州', 176, 192, 17],
  ['自贡市', 176, 205, 6],
  ['广安市', 144, 162, 7],
  ['资阳市', 129, 183, 6],
]);
console.log('  展开耗时 ' + loadMs + ' ms');

check('每行都有岗位编码', count((r) => r['岗位编码']), 7821);
check('每行都有招聘范围', count((r) => r['招聘范围']), 7821);
check('省直属没有县市区', count((r) => r['市州'] === '省直属' && !r['县市区']), 395);

// 招聘范围：绝大多数面向全国，真正受限的只有 128 个
check('受限岗位', count((r) => r.range.restricted), 128);
check('「详见公告正文」岗位', count((r) => r.range.unknown), 7);
check('不限对象岗位', count((r) => !r.range.restricted && !r.range.unknown), 7686);
check('「面向全国招聘」不算受限',
  SY.analyzeRange('面向全国招聘').restricted, false);
check('「无」不算受限', SY.analyzeRange('无').restricted, false);
check('「详见公告正文」只标记、不算受限',
  [SY.analyzeRange('详见公告正文').restricted,
    SY.analyzeRange('详见公告正文').unknown], [false, true]);

check('户籍限制统计', {
  province: count((r) => r.range.hukouProvince),
  city: count((r) => r.range.hukouCity),
  county: count((r) => r.range.hukouCounty),
  localVeteran: count((r) => r.range.localVeteran),
  fresh2026: count((r) => r.range.fresh2026),
}, { province: 1, city: 82, county: 18, localVeteran: 7, fresh2026: 1 });

/* =====================================================================
 * 二、浏览模式：不填个人条件
 * ===================================================================*/
section('二、浏览模式');
const b = run({});
check('模式', b.mode, 'browse');
check('岗位数', b.stats.total, 7821);
check('招聘人数', b.stats.headcount, 10878);
check('档位分组只有 all', [b.groups.exact.length, b.groups.class.length,
  b.groups.category.length, b.groups.eligible.length, b.groups.all.length],
  [0, 0, 0, 0, 7821]);

check('岗位类别分布', b.stats.jobCats, [
  { name: '专业技术', count: 6737 },
  { name: '管理', count: 1068 },
  { name: '工勤技能', count: 16 },
]);
check('考试科目分布', b.stats.exams, [
  { name: '综合类', count: 3345 },
  { name: '卫生类', count: 2279 },
  { name: '教育类', count: 2197 },
]);

check('学历要求分布', ['大专及以上', '本科及以上', '研究生及以上'].map((v) =>
  [v, count((r) => r['学历要求'] === v)]), [
  ['大专及以上', 465], ['本科及以上', 5321], ['研究生及以上', 2035],
]);
check('学位要求分布', ['不限', '学士及以上', '硕士及以上', '博士'].map((v) =>
  [v, count((r) => r['学位要求'] === v)]), [
  ['不限', 1273], ['学士及以上', 4514], ['硕士及以上', 1883], ['博士', 151],
]);
check('教资要求分布', ['不限', '小学及以上', '初中及以上', '高中', '其他'].map((v) =>
  [v, count((r) => r['教资要求'] === v)]), [
  ['不限', 5738], ['小学及以上', 508], ['初中及以上', 477],
  ['高中', 860], ['其他', 238],
]);
check('5 年服务期', count((r) => r['服务期年数'] === '5') > 5000, true);
check('6 年服务期', count((r) => r['服务期年数'] === '6'), 342);

/* =====================================================================
 * 三、浏览筛选：只按岗位要求收窄
 * ===================================================================*/
section('三、浏览筛选');
const santa = count((r) => r['县市区'] === '三台县');
check('县市区 = 三台县', run({ counties: ['三台县'] }).stats.total, santa);
check('三台县不为零', santa > 0, true);

// 市州是县市区的上一级：先选市，候选区县就只剩这个市的
const chengduCounty = DATA.counties.find((e) => e[2] === '成都市' && e[0] !== '市本级')[0];
check('市州 = 成都市', run({ city: '成都市' }).stats.total,
  count((r) => r['市州'] === '成都市'));
check('市州 = 省直属', run({ city: '省直属' }).stats.total,
  count((r) => r['市州'] === '省直属'));
check('市州 + 县市区', run({ city: '成都市', counties: [chengduCounty] }).stats.total,
  count((r) => r['市州'] === '成都市' && r['县市区'] === chengduCounty));
check('市州 + 县市区不为零',
  run({ city: '成都市', counties: [chengduCounty] }).stats.total > 0, true);
check('市州与当前范围一致', run({ city: '成都市' }, { scope: '成都市' }).stats.total,
  count((r) => r['市州'] === '成都市'));
check('市州与当前范围冲突', run({ city: '广元市' }, { scope: '成都市' }).stats.total, 0);
check('市州不算「被筛掉」', run({ city: '资阳市' }).stats.excluded['市州不符'] || 0, 0);
check('考试科目 = 教育类', run({ exams: ['教育类'] }).stats.total, 2197);
check('考试科目 = 卫生类', run({ exams: ['卫生类'] }).stats.total, 2279);
check('岗位类别 = 管理', run({ jobCats: ['管理'] }).stats.total, 1068);
check('岗位类别 = 工勤技能', run({ jobCats: ['工勤技能'] }).stats.total, 16);
check('学历要求 = 大专及以上', run({ eduReqs: ['大专及以上'] }).stats.total, 465);
check('学位要求 = 不限', run({ degreeReqs: ['不限'] }).stats.total, 1273);
check('教资要求 = 高中', run({ certReqs: ['高中'] }).stats.total, 860);
check('教资要求 = 其他', run({ certReqs: ['其他'] }).stats.total, 238);
check('最低服务期 = 5 年',
  run({ services: ['5'] }).stats.total, count((r) => r['服务期年数'] === '5'));
check('招聘名额 ≥ 5', run({ minHeadcount: 5 }).stats.total, 202);

check('浏览筛选不改个人条件模式',
  run({ counties: ['三台县'], exams: ['教育类'] }).mode, 'browse');
check('浏览筛选命中人数',
  run({ counties: ['三台县'], exams: ['教育类'] }).stats.headcount,
  records.filter((r) => r['县市区'] === '三台县' && r['考试科目'] === '教育类')
    .reduce((a, r) => a + r.headcount, 0));

/* =====================================================================
 * 四、招聘对象与身份
 * ===================================================================*/
section('四、招聘对象与身份');
const browseIdentity = {};
const personalIdentity = {};
SY.IDENTITY_DEFS.forEach((d) => {
  browseIdentity[d.key] = run({ ranges: [d.key] }).stats.total;
  personalIdentity[d.key] = run({ identities: [d.key] }).stats.total;
});
check('按招聘对象浏览', browseIdentity, {
  teacherPublic: 9, teacherPlan: 0, sanZhi: 0, xiBu: 0,
  veteran: 7, veteranStudent: 2, medical: 0, disabled: 5,
  ruralDoctor: 3, partySecretary: 4,
});
// 不限对象的 7,693 个（含 7 个「详见公告正文」）+ 只限户籍的 99 个始终保留；
// 其余按身份逐个放行。fresh2026 那 1 行对基层项目 / 退役军人身份放行。
// 勾「退役军人」不含只写「退役大学生士兵」的 2 个岗（要另勾退役大学生士兵）；
// 反过来勾「退役大学生士兵」也放行普通退役军人岗。
check('按我的身份判断', personalIdentity, {
  teacherPublic: 7801, teacherPlan: 7792, sanZhi: 7793, xiBu: 7793,
  veteran: 7798, veteranStudent: 7800, medical: 7792, disabled: 7797,
  ruralDoctor: 7795, partySecretary: 7796,
});

// 「面向全国招聘」的岗位不受身份勾选影响
const openRec = records.find((r) => r['招聘范围'] === '面向全国招聘');
check('不限对象的岗位，勾身份也不会被排除',
  SY.matchRow(openRec, SY.buildProfile(P({ identities: ['disabled'] }))).ok, true);
check('不限对象的岗位没有身份标签',
  openRec.tags.filter((t) => SY.IDENTITY_KEYS.indexOf(t) >= 0), []);

// 只限户籍、不限身份的岗位，勾任何身份都应保留，只提示核对
const hukouRec = records.find((r) => r.range.hukouCity);
const hukouMatch = SY.matchRange(hukouRec,
  SY.buildProfile(P({ identities: ['veteran'] })));
check('只限户籍的岗位不按身份排除', hukouMatch.ok, true);
check('只限户籍的岗位给出提示', hukouMatch.flags.length > 0, true);
check('限本市州户籍标签', hukouRec.tags.indexOf('hukouCity') >= 0, true);

// 2026 届应届那一行括号里有「三支一扶」「退役」，不能被误认成专项岗
const fresh = records.find((r) => r.range.fresh2026);
check('应届行不误判三支一扶', !!fresh.range.sanZhi, false);
check('应届行不误判西部计划', !!fresh.range.xiBu, false);
check('应届行标记为受限', fresh.range.restricted, true);
check('应届行标签', fresh.tags.indexOf('fresh2026') >= 0, true);

check('三支一扶 + 不填服务地',
  run({ identities: ['sanZhi'], servicePlace: '' }).stats.total, 7793);
check('三支一扶 + 省外',
  run({ identities: ['sanZhi'], servicePlace: '__outside__' }).stats.total, 7793);
check('基层服务地筛选在新型岗位表里为空',
  run({ areaTags: ['countyService'] }).stats.total, 0);

/* =====================================================================
 * 五、硬性条件
 * ===================================================================*/
section('五、硬性条件');
check('大专学历', run({ level: '大专' }).stats.total, 465);
check('本科学历', run({ level: '本科' }).stats.total, 5786);
check('硕士学历', run({ level: '硕士' }).stats.total, 7821);
check('博士学历', run({ level: '博士' }).stats.total, 7821);

check('大专被学历要求排除', run({ level: '大专' }).stats.excluded['学历不符'], 7356);
check('本科被研究生岗位排除', run({ level: '本科' }).stats.excluded['学历不符'], 2035);

check('学位无', run({ degree: '无' }).stats.total, 1273);
check('学士学位', run({ degree: '学士' }).stats.total, 5787);
check('硕士学位', run({ degree: '硕士' }).stats.total, 7670);
check('博士学位', run({ degree: '博士' }).stats.total, 7821);

check('没有教师资格证', run({ cert: '无' }).stats.total, 5738);
check('小学教师资格证', run({ cert: '小学' }).stats.total, 6484);
check('初中教师资格证', run({ cert: '初中' }).stats.total, 6961);
check('高中教师资格证', run({ cert: '高中' }).stats.total, 7821);

check('填了条件但没填专业 = eligible',
  run({ level: '本科' }).mode, 'eligible');
check('eligible 模式下专业命中数仍为 0',
  run({ level: '本科' }).stats.byTier.exact.count, 0);
check('personalActive：空条件', SY.personalActive(SY.buildProfile(P({}))), false);
check('personalActive：只勾浏览筛选',
  SY.personalActive(SY.buildProfile(P({ counties: ['三台县'] }))), false);
check('personalActive：填学历',
  SY.personalActive(SY.buildProfile(P({ level: '本科' }))), true);

/* =====================================================================
 * 六、专业匹配
 * ===================================================================*/
section('六、专业匹配');

const hanyu = run({ level: '本科', majorText: '汉语言文学', majorCodes: '050101' });
check('本科 汉语言文学有结果', hanyu.stats.total > 0, true);
check('本科 汉语言文学有精准命中', hanyu.stats.byTier.exact.count > 0, true);
check('本科 汉语言文学分档合计',
  hanyu.stats.byTier.exact.count + hanyu.stats.byTier.class.count +
  hanyu.stats.byTier.category.count, hanyu.stats.total);

const comp = run({ level: '硕士', majorText: '计算机科学与技术', majorCodes: '0812' });
check('硕士 计算机科学与技术有精准命中',
  comp.stats.byTier.exact.count > 0, true);

const one = records.find((r) => r['岗位编码'] === '201002002001');
check('单个岗位：硕士计算机科学与技术精准',
  SY.matchRow(one, SY.buildProfile(P({
    level: '硕士', majorText: '计算机科学与技术', majorCodes: '0812',
  }))).tier, 'exact');
check('单个岗位：本科被研究生要求挡住',
  SY.matchRow(one, SY.buildProfile(P({
    level: '本科', majorText: '计算机科学与技术', majorCodes: '080901',
  }))).why, '学历不符');

const chineseTeacher = records.find((r) => r['岗位编码'] === '202026001001');
check('单个岗位：学科教学（语文）精准',
  SY.matchRow(chineseTeacher, SY.buildProfile(P({
    level: '硕士', majorText: '学科教学（语文）', majorCodes: '045103',
  }))).tier, 'exact');
check('单个岗位：初中证不够（要求高中）',
  SY.matchRow(chineseTeacher, SY.buildProfile(P({
    level: '硕士', cert: '初中', majorText: '学科教学（语文）',
  }))).ok, false);
check('单个岗位：高中证可报',
  SY.matchRow(chineseTeacher, SY.buildProfile(P({
    level: '硕士', cert: '高中', majorText: '学科教学（语文）',
  }))).ok, true);

const psych = records.find((r) => r['岗位编码'] === '205047001001');
check('单个岗位：本科心理学精准',
  SY.matchRow(psych, SY.buildProfile(P({
    level: '本科', majorText: '心理学', majorCodes: '071101',
  }))).tier, 'exact');
check('专业栏按本科 / 研究生分层',
  !!(psych.major.byLevel['本科'] && psych.major.byLevel['研究生']), true);

const clinical = records.find((r) => r['岗位编码'] === '220197003002');
check('单个岗位：本科临床医学精准',
  SY.matchRow(clinical, SY.buildProfile(P({
    level: '本科', majorText: '临床医学', majorCodes: '100201K',
  }))).tier, 'exact');

const anyMajor = records.find((r) => r['岗位编码'] === '217118003001');
check('专业不限的岗位落到门类',
  SY.matchRow(anyMajor, SY.buildProfile(P({
    level: '本科', majorText: '汉语言文学', majorCodes: '050101',
  }))).tier, 'category');
check('专业不限的岗位被识别', count((r) => r.major.unlimited) > 0, true);

const otherCert = records.find((r) => r['岗位编码'] === '212002001001');
check('中职教师资格证归到「其他」', otherCert['教资要求'], '其他');
check('没有证不能报中职岗',
  SY.certOk(otherCert, '无'), false);
check('有证可报中职岗（需人工核对学段）',
  SY.certOk(otherCert, '高中'), true);

check('专业类目词表', DATA.leiVocab.length > 100, true);
const suggested = SY.suggestClasses('计算机科学与技术', DATA);
check('suggestClasses 能推出计算机类',
  suggested.some((x) => x.lei.indexOf('计算机') === 0), true);
check('suggestClasses 推不出时返回空',
  SY.suggestClasses('不存在的专业', DATA), []);

/* =====================================================================
 * 七、搜索、范围、排序
 * ===================================================================*/
section('七、搜索与范围');
check('搜索岗位编码', run({}, { search: '201002002001' }).stats.total, 1);
check('搜索不存在的词', run({}, { search: '不存在的词' }).stats.total, 0);
// 比只看成都市多 30 个：省直属岗位的单位名称 / 备注里也写了「成都市」
check('搜索「成都市」', run({}, { search: '成都市' }).stats.total, 2091);
check('只看成都市', run({}, { scope: '成都市' }).stats.total, 2061);
check('只看绵阳市', run({}, { scope: '绵阳市' }).stats.total, 228);
check('只看凉山州', run({}, { scope: '凉山州' }).stats.total, 505);
check('只看省直属', run({}, { scope: '省直属' }).stats.total, 395);
check('四川全省', run({}, { scope: '' }).stats.total, 7821);

check('按招聘名额降序', (() => {
  const list = run({}, { sort: 'headcount' }).all.map((r) => r.headcount);
  return list.every((n, i) => i === 0 || list[i - 1] >= n);
})(), true);
check('按县市区排序', (() => {
  const list = run({}, { sort: 'region' }).all.map((r) => r['县市区']);
  return list.every((n, i) => i === 0 || list[i - 1].localeCompare(n, 'zh') <= 0);
})(), true);

/* =====================================================================
 * 八、导出与性能
 * ===================================================================*/
section('八、导出与性能');
const csvRun = run({ level: '硕士', majorText: '计算机科学与技术', majorCodes: '0812' });
const csv = SY.toCSV(csvRun.all);
check('CSV 表头', csv.split('\r\n')[0].replace(/^﻿/, ''),
  SY.CSV_COLUMNS.join(','));
check('CSV 行数（表头 + 结果）', csv.split('\r\n').length, csvRun.all.length + 1);
check('CSV 带匹配档位', csv.indexOf('精准命中') >= 0, true);

const t1 = Date.now();
for (let i = 0; i < 30; i++) {
  run({ level: '本科', majorText: '汉语言文学', classes: [] });
}
const avg = (Date.now() - t1) / 30;
check('单次完整筛选 < 80ms', avg < 80, true);
console.log('  平均每次 ' + avg.toFixed(2) + ' ms');

/* ===================================================================*/
console.log('\n' + (failed ? '✗ ' : '✓ ') + passed + ' 项通过，' + failed + ' 项失败');
if (failed) process.exit(1);
