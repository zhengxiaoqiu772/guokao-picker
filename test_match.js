/**
 * test_match.js —— match.js 的验证脚本
 *
 *   node test_match.js
 *
 * 两部分：
 *   1) 差分测试：把 match.js 的筛选结果和 oracle.py（Python 独立实现）比对，
 *      两边数字必须一致。期望值改动后重跑 python -I oracle.py 更新。
 *   2) 边界用例：手工核对过的具体情形，逐条断言。
 */
'use strict';

global.window = global;
require('./data/positions.js');
require('./match.js');

const GK = global.GKMatch;
const DATA = global.GK_DATA;

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

function section(title) {
  console.log('\n' + title);
}

/* =====================================================================
 * 载入
 * ===================================================================*/
section('一、数据载入');
const t0 = Date.now();
const records = GK.unpack(DATA);
const loadMs = Date.now() - t0;

check('职位总数', records.length, 19426);
check('列数', DATA.H.length, 26);
console.log('  展开耗时 ' + loadMs + ' ms');

/* =====================================================================
 * 二、差分测试：与 oracle.py 比对
 *    备注类规则（英语/性别）关掉，以隔离专业匹配逻辑
 * ===================================================================*/
section('二、差分测试（对照 oracle.py）');

const BASE = {
  degree: '学士', politics: '群众', years: 0, services: [],
  gender: '不限', gradYear: '2027', english: '',
  majorText: '', majorCodes: '', classes: [],
  provinces: [], levels: [], exams: [], attrs: [], categories: [],
  minHeadcount: 0, ratios: [], excludeTagKeys: [],
};

// 差分测试只比对专业与硬性条件，把备注类规则关掉以隔离变量。
// 注意别把这两个开关放进 BASE —— 那会让边界用例里的标签规则静默失效。
const ORACLE_BASE = Object.assign({}, BASE, { ruleEnglish: false, ruleGender: false });

// 期望值来自: python -I oracle.py "2027年国考职位表（全国）.xls"
const ORACLE = [
  { label: '本科·数据科学与大数据技术·计算机类',
    profile: { level: '本科', majorText: '数据科学与大数据技术', majorCodes: '080910T', classes: ['计算机类'] },
    exact: 176, cls: 2505, cat: 0 },
  { label: '本科·法学·法学类',
    profile: { level: '本科', majorText: '法学', majorCodes: '030101K', classes: ['法学类'] },
    exact: 330, cls: 1593, cat: 0 },
  { label: '本科·会计学·工商管理类',
    // 565 而不是 403：表里 162 行把「会计学」写成「会计」，本科阶段现在按同一个专业认
    profile: { level: '本科', majorText: '会计学', majorCodes: '120203K', classes: ['工商管理类'] },
    exact: 565, cls: 1048, cat: 0 },
  { label: '硕士·计算机科学与技术·计算机类',
    profile: { level: '硕士', degree: '硕士', politics: '中共党员', majorText: '计算机科学与技术', classes: ['计算机类'] },
    exact: 573, cls: 2048, cat: 0 },
  { label: '大专·无专业限定',
    profile: { level: '大专', degree: '无', majorText: '', classes: [] },
    exact: 0, cls: 0, cat: 0 },
];

for (const item of ORACLE) {
  const profile = Object.assign({}, ORACLE_BASE, item.profile);
  const res = GK.filterRecords(records, profile, {});
  check(item.label, [res.stats.byTier.exact.count, res.stats.byTier.class.count,
                     res.stats.byTier.category.count],
        [item.exact, item.cls, item.cat]);
}

/* =====================================================================
 * 三、边界用例
 * ===================================================================*/
section('三、边界用例');

// --- 3.1 「不含」排除项 ---
const negRec = records.find((r) => r['专业'].indexOf('不含监狱学') >= 0);
if (negRec) {
  check('「' + negRec['专业'] + '」排除项解析', negRec.major.neg.indexOf('监狱学') >= 0, true);

  const pPrison = GK.buildProfile(Object.assign({}, BASE, { majorText: '监狱学' }));
  const rPrison = GK.matchMajor(negRec, pPrison);
  check('监狱学不得报该职位', rPrison.tier, null);

  const pLaw = GK.buildProfile(Object.assign({}, BASE, { classes: ['法学类'] }));
  const rLaw = GK.matchMajor(negRec, pLaw);
  check('法学类可报该职位', rLaw.tier, 'class');
} else {
  console.log('  ! 未找到含「不含监狱学」的职位，跳过');
}

// --- 3.2 本科/研究生分列 ---
const splitRec = records.find((r) =>
  r['专业'].indexOf('本科') >= 0 && r['专业'].indexOf('研究生') >= 0 &&
  r.major.byLevel['研究生'] && r.major.byLevel['研究生'].names.length);
if (splitRec) {
  const gradOnly = splitRec.major.byLevel['研究生'].names[0];
  const underNames = (splitRec.major.byLevel['本科'] || { names: [] }).names;
  const inUnder = underNames.indexOf(gradOnly) >= 0;

  const pUnder = GK.buildProfile(Object.assign({}, BASE, { level: '本科', majorText: gradOnly }));
  const pGrad = GK.buildProfile(Object.assign({}, BASE, { level: '硕士', degree: '硕士', majorText: gradOnly }));

  if (!inUnder) {
    check('研究生段专业：本科不应命中（' + gradOnly + '）',
          GK.matchMajor(splitRec, pUnder).tier, null);
  }
  check('研究生段专业：硕士应命中（' + gradOnly + '）',
        GK.matchMajor(splitRec, pGrad).tier, 'exact');
  console.log('  分列样例行: ' + splitRec['专业'].slice(0, 60));
} else {
  console.log('  ! 未找到本科/研究生分列且研究生段有专业名的行，跳过');
}

// --- 3.3 硬条件谓词 ---
check('学历：硕士可报「本科及以上」', GK.educationOk('本科及以上', '硕士').ok, true);
check('学历：本科不可报「仅限硕士研究生」', GK.educationOk('仅限硕士研究生', '本科').ok, false);
check('学历：本科可报「大专或本科」', GK.educationOk('大专或本科', '本科').ok, true);
check('学历：本科不可报「硕士研究生及以上」', GK.educationOk('硕士研究生及以上', '本科').ok, false);
check('政治面貌：群众只能报「不限」', GK.politicsOk('中共党员', '群众').ok, false);
check('政治面貌：团员可报「党员或团员」', GK.politicsOk('中共党员或共青团员', '共青团员').ok, true);
check('政治面貌：预备党员算党员', GK.politicsOk('中共党员', '中共预备党员').ok, true);
check('基层年限：0 年不可报「二年」', GK.yearsOk('二年', 0).ok, false);
check('基层年限：2 年可报「二年」', GK.yearsOk('二年', 2).ok, true);
check('基层年限：5 年可报「五年以上」', GK.yearsOk('五年以上', 5).ok, true);
check('服务基层：「无限制」任何人可报', GK.serviceOk('无限制', new Set()).ok, true);
check('服务基层：缺村官经历不可报',
      GK.serviceOk('大学生村官、“三支一扶”计划', new Set(['三支一扶'])).ok, false);
check('服务基层：经历齐全可报',
      GK.serviceOk('大学生村官、“三支一扶”计划', new Set(['大学生村官', '三支一扶'])).ok, true);

// --- 3.4 学位 ---
check('学位：「与最高学历相对应」本科有学士可报', GK.degreeOk('与最高学历相对应的学位', '学士', '本科').ok, true);
check('学位：本科无学位不可报「学士」', GK.degreeOk('学士', '无', '本科').ok, false);
check('学位：硕士可报「学士」要求', GK.degreeOk('学士', '硕士', '硕士').ok, true);

// --- 3.5 备注风险标签 ---
// 挑一个「除目标标签外其余硬条件都满足」的职位，否则会被更早的硬条件短路，
// 测不到标签规则本身
const RICH = { level: '硕士', degree: '硕士', politics: '中共党员', years: 5,
               services: GK.SERVICE_KEYS.map((s) => s[0]) };

// 挑「除了待测的那条规则以外，其余条件全过」的职位：把规则一开一关，
// 结果的差别就只能来自这条规则本身，不会掺进别的条件。
//
// 判可报必须走 matchRow，不能像早先那样逐条判硬条件。matchRow 现在把
// 「专业未命中」排在备注规则**之前**（专业是正式字段，备注是从中文推断的，
// 正式字段更该先表态），所以只过硬条件、专业对不上的行会被专业先挡掉，
// 根本走不到性别/英语那两条分支，用例就测了个空。
// 这组人设能过 3,143 个职位：male 158、只要求四级 197、要求六级 271，挑样本绰绰有余。
const EASE = Object.assign({}, RICH, {
  majorText: '法学', majorCodes: '030101K', classes: ['法学类'],
});
const easeProfile = (extra) => GK.buildProfile(Object.assign({}, BASE, EASE, extra || {}));

function pickTagged(tag) {
  return records.find((r) =>
    r.tags.indexOf(tag) >= 0 && GK.matchRow(r, easeProfile()).ok);
}

// --- 3.5b 应届身份：当年届 与 择业期 是两回事 ---
// 国考把应届分两层：写「2027届高校毕业生」的只限当年毕业；
// 写「限应届高校毕业生」的按报名指南含择业期内未落实工作单位的毕业生（两年）。
const thisYear = GK.examCohortYear();
// 要在「除应届规则外全部通过」的行上比较，否则会被更早的硬条件或专业未命中短路。
// BASE 的专业是空的，这里必须把专业补上，否则一行都选不出来。
const FRESH_RAW = Object.assign({}, BASE, RICH, {
  majorText: '数据科学与大数据技术', majorCodes: '080910T', classes: ['计算机类'],
});
const at = (rec, g) => GK.matchRow(rec, GK.buildProfile(Object.assign({}, FRESH_RAW, { gradYear: g })));
const pickFreshRow = (want) => records.find((r) =>
  (want === 'cohort'
    ? (r.cohortReq.length && r.tags.indexOf('fresh') < 0)
    : (r.tags.indexOf('fresh') >= 0 && !r.cohortReq.length)) &&
  at(r, String(thisYear)).ok);

const cohortRec = pickFreshRow('cohort');
check('认出当年届（' + thisYear + '）', GK.cohortYearsOf(cohortRec['备注']), [thisYear]);
check('只限当年届：当年届可报', at(cohortRec, String(thisYear)).ok, true);
check('只限当年届：择业期内也不行', at(cohortRec, String(thisYear - 1)).why, '限' + thisYear + '届（备注）');
check('只限当年届：往届不行', at(cohortRec, 'earlier').why, '限' + thisYear + '届（备注）');

const freshRec = pickFreshRow('fresh');
check('限应届（含择业期）：当年届可报', at(freshRec, String(thisYear)).ok, true);
check('限应届（含择业期）：择业期内（上一年）可报', at(freshRec, String(thisYear - 1)).ok, true);
check('限应届（含择业期）：往届不可报', at(freshRec, 'earlier').why,
      '限应届高校毕业生（备注，含择业期）');

// 裸写「2027届高校毕业生」独句成行时也算限制（表里 6,323 行是这种写法）
check('裸写届别也算限当年届',
      GK.analyzeRemark(thisYear + '届高校毕业生;大学英语四级550分以上', '其他职位').indexOf('cohort') >= 0, true);
// 但「非2027届…」是给往届加条件，不是限制
check('「非2027届高校毕业生报考的」不算限制',
      GK.analyzeRemark('非' + thisYear + '届高校毕业生报考的,须有2年工作经历', '其他职位')
        .filter((k) => k === 'cohort' || k === 'fresh'), []);
// 一行同时出现两者时以更宽的「应届（含择业期）」为准
check('「限应届」优先于届别提及',
      GK.analyzeFreshness('限应届高校毕业生报考;' + thisYear + '届高校毕业生需通过船员适任考试').tag, 'fresh');
check('「限2027届」走届别档',
      GK.analyzeFreshness('限' + thisYear + '届毕业生报考').tag, 'cohort');
check('「2027年度」这种年度说法不算届别',
      GK.cohortYearsOf(thisYear + '年度国家金融监督管理总局考试录用公务员').length, 0);

check('「非应届高校毕业生」不算限应届',
      GK.analyzeRemark('非应届高校毕业生报考,需2年工作经历', '其他职位').indexOf('fresh') < 0, true);

// 裸的「应届高校毕业生」独立成句时就是限应届。税务系统全表 1,473 行这么写，
// 性别和应届并列、谁也不带限定动词，先前只认「限应届」时整批漏标。
check('裸写「应届高校毕业生」独句成行算限应届',
      GK.analyzeRemark('应届高校毕业生,男性,在本单位最低服务年限为5年', '其他职位').indexOf('fresh') >= 0, true);
check('裸写「应届毕业生」（不带「高校」）也算',
      GK.analyzeRemark('应届毕业生,最低服务年限5年', '其他职位').indexOf('fresh') >= 0, true);
check('「限2027年应届高校毕业生」算限应届（动词后隔了年份）',
      GK.analyzeRemark('限' + thisYear + '年应届高校毕业生,同时取得学历学位', '其他职位').indexOf('fresh') >= 0, true);
check('「该职位限招应届高校毕业生」算限应届',
      GK.analyzeRemark('该职位限招应届高校毕业生', '其他职位').indexOf('fresh') >= 0, true);
// 但同一组字换个位置意思就反了，这四条是边界，必须挡住
check('「注明本人具有应届高校毕业生身份」不算限应届',
      GK.analyzeRemark('如考生为应届高校毕业生,请在备注栏中注明本人具有应届高校毕业生身份', '其他职位')
        .indexOf('fresh') < 0, true);
check('「如考生为应届…非应届…」两身份并列不算限应届',
      GK.analyzeRemark('1.应届高校毕业生需通过英语专业八级;如不是应届高校毕业生,需专职从事翻译工作2年以上', '其他职位')
        .indexOf('fresh') < 0, true);
check('「非应届高校毕业生应持有…」不算限应届',
      GK.analyzeRemark('2,应届高校毕业生应在报名时同时具有合格证,非应届高校毕业生应持有执照', '其他职位')
        .indexOf('fresh') < 0, true);
check('「招考对象可为应届高校毕业生」不算限应届',
      GK.analyzeRemark('招考对象可为应届高校毕业生', '其他职位').indexOf('fresh') < 0, true);

// 用户报的那一行：国家税务总局湖北省税务局 南漳县税务局，备注「应届高校毕业生,男性,…」
// 职位代码不唯一，所以连部门代码一起定位。这一行是裸写句式，先前完全没标签。
const nanzhang = records.find((r) => r['职位代码'] === '300110044001' &&
                                     r['部门代码'] === '130121');
if (nanzhang) {
  const nanzhangProfile = (g) => GK.buildProfile(Object.assign({}, BASE, {
    level: '本科', majorText: '', majorCodes: '', classes: ['社会保障类'], gradYear: g,
  }));
  check('南漳县这行被打上 fresh 标签', nanzhang.tags.indexOf('fresh') >= 0, true);
  check('南漳县这行：当年届可报', GK.matchRow(nanzhang, nanzhangProfile(String(thisYear))).ok, true);
  check('南漳县这行：非应届被排除',
        GK.matchRow(nanzhang, nanzhangProfile('earlier')).why, '限应届高校毕业生（备注，含择业期）');
}
check('「在本单位最低服务年限为5年」被识别',
      GK.analyzeRemark('在本单位最低服务年限为5年(含试用期)', '其他职位').indexOf('service5') >= 0, true);
check('「服务期满,考核合格」不算最低服务期',
      GK.analyzeRemark('面向服务基层项目人员,服务期满,考核合格', '其他职位').indexOf('service5') < 0, true);
check('「限男性」被识别', GK.analyzeRemark('工作强度大,限男性', '其他职位').indexOf('male') >= 0, true);
// 税务系统的写法省略谓语，性别单独成句、前面没有「限」字。早先要求「限」字，
// 全表 3,206 行这种写法全部漏标，选「女」照常推上来（用户就是被这个坑了两次）。
check('「毕业生,男性,在本单位…」被识别为限男性',
      GK.analyzeRemark('2027届高校毕业生,男性,在本单位最低服务年限为5年', '其他职位').indexOf('male') >= 0, true);
check('「女性,在本单位…」被识别为限女性',
      GK.analyzeRemark('女性,在本单位最低服务年限为5年', '其他职位').indexOf('female') >= 0, true);
check('「配偶或子女已移居国(境)外」不算限女性',
      GK.analyzeRemark('配偶或子女已移居国(境)外', '其他职位').indexOf('female') < 0, true);
check('「女子800米跑」不算限女性',
      GK.analyzeRemark('体能测评:女子800米跑,男子1000米跑', '其他职位').indexOf('female') < 0, true);
check('「男子1000米」不算限男性',
      GK.analyzeRemark('体能测评:男子1000米跑', '其他职位').indexOf('male') < 0, true);
check('「妇女等领域知识」不算限女性',
      GK.analyzeRemark('从事妇女等领域知识工作', '其他职位').indexOf('female') < 0, true);
check('西部地区从职位分布识别',
      GK.analyzeRemark('', '西部地区和艰苦边远地区职位').indexOf('west') >= 0, true);

// 英语等级有整整一批写成阿拉伯数字，是外交部那批驻外岗位的标准句式，
// 整条备注里汉字「四级/六级」一个都没有，早先全漏标（用户报的 200110002002 就是）。
check('「大学英语4级成绩425分及以上」被识别为要求四级',
      GK.analyzeRemark('大学英语4级成绩425分及以上(网上报名时,请在备注栏注明英语水平等级及分数)',
                       '其他职位').indexOf('cet4') >= 0, true);
check('「大学英语6级成绩425分及以上」被识别为要求六级',
      GK.analyzeRemark('大学英语6级成绩425分及以上(网上报名时,请在备注栏注明英语水平等级及分数)',
                       '其他职位').indexOf('cet6') >= 0, true);
// 民航那批写的是「国际民航组织英语4级」，是飞行人员的 ICAO 等级，跟四级考试无关。
// 只认「大学英语」这个前缀就是为了把它们挡在外面；放宽到裸的「英语4级」会误伤 4 行。
check('「国际民航组织英语4级」不算要求四级',
      GK.analyzeRemark('具备现行有效飞行人员国际民航组织英语4级及以上能力,未发生过运输航空责任原因一般征候',
                       '其他职位').indexOf('cet4') < 0, true);
check('「国际民航组织英语4级」不算要求六级',
      GK.analyzeRemark('具备现行有效管制员国际民航组织英语4级及以上能力',
                       '其他职位').indexOf('cet6') < 0, true);

// --- 3.6 性别规则 ---
const maleRec = pickTagged('male');
check('存在满足硬条件的「限男性」职位', !!maleRec, true);
if (maleRec) {
  check('男性可报该「限男性」职位',
        GK.matchRow(maleRec, easeProfile({ gender: '男' })).ok, true);
  check('女性被排除出「限男性」职位',
        GK.matchRow(maleRec, easeProfile({ gender: '女' })).why, '限男性（备注）');
  check('关掉性别规则后不再排除',
        GK.matchRow(maleRec, easeProfile({ gender: '女', ruleGender: false })).ok, true);
}

// 用户实际踩到的那一行：四川天府新区税务局 一级行政执法员(一)，
// 备注「男性,在本单位最低服务年限为5年」，专业栏只有类目没有具体专业名。
// 拿它的真实字段做夹具，比拿合成字符串更能挡住退步——换个「限」字要求就又漏了。
const tfx = records.find((r) => r['职位代码'] === '300110001001' &&
                               /天府新区/.test(r['用人司局'] || ''));
if (tfx) {
  const tfxProfile = (gender) => GK.buildProfile(Object.assign({}, BASE, {
    level: '本科', majorText: '工商管理类', majorCodes: '', classes: ['工商管理类'], gender: gender,
  }));
  check('天府新区这行被打上 male 标签', tfx.tags.indexOf('male') >= 0, true);
  check('天府新区这行「男」可报', GK.matchRow(tfx, tfxProfile('男')).ok, true);
  check('天府新区这行「女」被排除',
        GK.matchRow(tfx, tfxProfile('女')).why, '限男性（备注）');
  // 同一职位的(二)写的是「女性,…」，两条互补，别把方向搞反
  // 职位代码不唯一（19,426 行只有 7,178 个码），必须连司局一起定位
  const tfx2 = records.find((r) => r['职位代码'] === '300110001002' &&
                                   /天府新区/.test(r['用人司局'] || ''));
  if (tfx2) {
    check('天府新区(二) 是限女性', tfx2.tags.indexOf('female') >= 0, true);
    check('天府新区(二)「女」可报', GK.matchRow(tfx2, tfxProfile('女')).ok, true);
    check('天府新区(二)「男」被排除',
          GK.matchRow(tfx2, tfxProfile('男')).why, '限女性（备注）');
  }
}

// 选了「女」之后，结果里不能再出现任何带 male 标签的行——这是用户看到的现象本身
const femaleProfile = GK.buildProfile(Object.assign({}, BASE, EASE, { gender: '女' }));
const maleLeaked = records.filter((r) => r.tags.indexOf('male') >= 0 &&
                                         GK.matchRow(r, femaleProfile).ok);
check('选「女」后结果里没有「限男性」职位', maleLeaked.length, 0);
check('全表确实存在大量「限男性」职位（不是标签全没打上）',
      records.filter((r) => r.tags.indexOf('male') >= 0).length > 4000, true);

// --- 3.7 省份 ---
check('省份解析：自治区', GK.provinceOf('内蒙古自治区巴彦淖尔市'), '内蒙古自治区');
check('省份解析：市县', GK.provinceOf('河北省廊坊市霸州市'), '河北省');
check('省份解析：直辖市', GK.provinceOf('北京市'), '北京市');

// --- 3.8 类目推荐 ---
const DICTS = { majorDict: DATA.majorDict, codeToLei: DATA.codeToLei };
const sugg = GK.suggestClasses('080910T', DICTS);
check('由专业代码推荐出计算机类', sugg.some((s) => s.lei === '计算机类'), true);

// 词表里有「071203T 数据科学」，早先的子串规则会把它算成命中，
// 于是给「数据科学与大数据技术」的人推荐统计学类 —— 两个专业其实不同。
const sugg2 = GK.suggestClasses('数据科学与大数据技术080910T', DICTS);
check('给了代码就不该再按子串推荐统计学类',
      sugg2.some((s) => s.lei === '统计学类'), false);
check('给了代码就只推荐计算机类', sugg2.map((s) => s.lei), ['计算机类']);

// 名字带后缀时，前缀匹配是唯一的线索，这一档要保留
const sugg3 = GK.suggestClasses('计算机科学与技术（嵌入式培养）', DICTS);
check('带后缀的专业名仍推荐计算机类', sugg3.some((s) => s.lei === '计算机类'), true);

// 多专业各按各自的证据判定，不能被最强的那个吞掉
const sugg4 = GK.suggestClasses('080910T,会计学', DICTS);
check('多专业：两个类目都要出现',
      [sugg4.some((s) => s.lei === '计算机类'), sugg4.some((s) => s.lei === '工商管理类')],
      [true, true]);

// --- 3.9 「本科生招收计算机类(0809)」这类叙述文字 ---
// 类名前挂着一截叙述文字时，只剥前缀虚词会剩下「生招收计算机类」：
// 不是类目，词表里却多出这么一条，用户勾「计算机类」这些职位就静默消失（实测 14 行）。
check('词表里不该有「生招收…」这种伪类目',
      DATA.leiVocab.some((x) => x[0].indexOf('生招收') >= 0), false);

const proseRec = records.find((r) => r['专业'].indexOf('招收计算机类') >= 0);
check('找到叙述文字写法的样例行', !!proseRec, true);
if (proseRec) {
  check('叙述文字里切出的类名是「计算机类」',
        proseRec.major.byLevel['本科'].lei, ['计算机类']);
  const pProse = GK.buildProfile(Object.assign({}, BASE, {
    level: '本科', majorText: '数据科学与大数据技术', majorCodes: '080910T', classes: ['计算机类'],
  }));
  check('勾「计算机类」后该职位可报', GK.matchMajor(proseRec, pProse).tier, 'class');
}

// --- 3.10 英语等级：留空是弃权，不是「没过四级」 ---
// 老版本这一栏默认「无」，一个选项同时表示「没取得」和「不填」。两者该有的行为刚好相反，
// 而它又是默认值，于是首屏就替用户删掉了一批要求英语的职位——用户从没做过这个声明。
check('默认画像的英语留空（弃权）', GK.DEFAULT_PROFILE.english, '');

// 样本行必须是「专业对得上、只是英语那一栏还没表态」的职位，
// 否则它先被专业挡掉，测不到英语。pickTagged 已经保证这一点。
const cet4Rec = records.find((r) =>
  r.tags.indexOf('cet4') >= 0 && r.tags.indexOf('cet6') < 0 &&
  GK.matchRow(r, easeProfile({ english: '六级' })).ok);
const cet6Rec = records.find((r) =>
  r.tags.indexOf('cet6') >= 0 &&
  GK.matchRow(r, easeProfile({ english: '六级' })).ok);
check('找到只要求四级、且其余条件都过的样例行', !!cet4Rec, true);
check('找到要求六级、且其余条件都过的样例行', !!cet6Rec, true);

// 现在样本行的唯一变量就是英语这一栏：why 空 = 放行，why 有值 = 被这条规则拦下。
const whyOf = (rec, extra) =>
  GK.matchRow(rec, easeProfile(extra)).why || '';
check('英语留空时六级岗照常可报', whyOf(cet6Rec, { english: '' }), '');
check('英语填「无」才因英语排除（六级岗）', whyOf(cet6Rec, { english: '无' }), '有英语等级要求（备注）');
check('填「四级」仍够不着六级岗', whyOf(cet6Rec, { english: '四级' }), '要求六级（备注）');
check('填「六级」够得着六级岗', whyOf(cet6Rec, { english: '六级' }), '');
check('填「四级」够得着四级岗', whyOf(cet4Rec, { english: '四级' }), '');

// 用户实际报的那一行：外交部办公厅 200110002002。备注写的是「大学英语4级成绩425分
// 及以上」，汉字「四级」一个都没有，早先整行没打标签，选「未通过四级」照样推上来。
// 这里连着走一遍完整判定，而不只是查 analyzeRemark——标签打上了却接不到规则上，
// 是另一回事。
const waijiao = records.find((r) => r['职位代码'] === '200110002002' && r['部门代码'] === '102000');
check('找到外交部 200110002002 这行', !!waijiao, true);
if (waijiao) {
  check('这行被打上 cet4 标签', waijiao.tags.indexOf('cet4') >= 0, true);
  const wjProfile = (e) => GK.buildProfile(Object.assign({}, BASE, {
    level: '本科', politics: '中共党员', years: 3, gradYear: String(thisYear),
    majorText: '应急技术与管理', majorCodes: '082902T', classes: ['安全科学与工程类'], english: e,
  }));
  check('这行：英语留空时不排除', GK.matchRow(waijiao, wjProfile('')).why || '', '');
  check('这行：选「未通过四级」被排除',
        GK.matchRow(waijiao, wjProfile('无')).why, '有英语等级要求（备注）');
  check('这行：选「已过四级」可报', GK.matchRow(waijiao, wjProfile('四级')).ok, true);
  check('这行：选「已过六级」可报', GK.matchRow(waijiao, wjProfile('六级')).ok, true);
}

// 收口：选「未通过四级」之后，全表带英文标签的职位一个都不该留在结果里
const engLeak = records.filter((r) =>
  (r.tags.indexOf('cet4') >= 0 || r.tags.indexOf('cet6') >= 0) &&
  GK.matchRow(r, easeProfile({ english: '无' })).ok);
check('选「未通过四级」后没有带英文标签的职位漏网', engLeak.length, 0);

// 汇总口径：留空应当既不排除，也不比「已过六级」多——空值就是纯弃权
const engBase = Object.assign({}, BASE, {
  level: '本科', majorText: '数据科学与大数据技术', majorCodes: '080910T', classes: ['计算机类'],
});
const engCount = (extra) => records.filter((r) =>
  GK.matchRow(r, GK.buildProfile(Object.assign({}, engBase, extra))).ok).length;
const nBlank = engCount({ english: '' });
check('英语留空 ≡ 关掉「按英语排除」', nBlank, engCount({ english: '无', ruleEnglish: false }));
check('英语留空 ≡ 填「六级」', nBlank, engCount({ english: '六级' }));
check('英语留空确实比填「无」多出职位', nBlank > engCount({ english: '无' }), true);
console.log('  英语留空 ' + nBlank + ' 个，填「无」' + engCount({ english: '无' }) +
            ' 个，差 ' + (nBlank - engCount({ english: '无' })) + ' 个');

// --- 3.11 本科阶段的专业简写：表把「会计学」写成「会计」 ---
// 本科专业目录里没有叫「会计」的专业，只有会计学（120203K）。表里有些行写成
// 「会计,财务管理,审计」，这不是另一个专业，是简写。不认这一层，同一个人
// 填「会计」和填「会计学」会看到两拨几乎不相干的结果（实测只重合 3 个）。
const shortCount = (major) => {
  const p = GK.buildProfile(Object.assign({}, BASE, {
    level: '本科', majorText: major, majorCodes: '', classes: [],
  }));
  return records.filter((r) => GK.matchRow(r, p).ok).length;
};
check('本科填「会计」= 填「会计学」', shortCount('会计'), shortCount('会计学'));
check('本科填「审计」= 填「审计学」', shortCount('审计'), shortCount('审计学'));
check('本科「会计学」确实因简写多出职位', shortCount('会计学') > 403, true);
console.log('  本科「会计」' + shortCount('会计') + ' 个，「会计学」' + shortCount('会计学') +
            ' 个；「审计」' + shortCount('审计') + ' 个，「审计学」' + shortCount('审计学') + ' 个');

// 写「会计」而不是「会计学」的那一行，现在两边都能命中
const acctRow = records.find((r) => r['专业'] === '会计,财务管理,审计' && r['学历'] === '仅限本科');
check('找到「会计,财务管理,审计」样例行', !!acctRow, true);
if (acctRow) {
  const hit = (major) => GK.matchRow(acctRow, GK.buildProfile(Object.assign({}, BASE,
    { level: '本科', majorText: major, majorCodes: '' })));
  check('填「会计」命中该行', hit('会计').ok, true);
  check('填「会计学」同样命中该行', hit('会计学').ok, true);
  check('该行仍按精准档', hit('会计学').tier, 'exact');
  check('卡片上说清表里写的是简写',
        (hit('会计学').reasons || []).join('').indexOf('该行写作') >= 0, true);
}
// 研究生那边不能一并简写：「会计（1253）」是专业学位的正式名，不是简写
check('硕士填「会计」不触发本科那套简写',
      GK.matchRow(acctRow, GK.buildProfile(Object.assign({}, BASE,
        { level: '硕士', degree: '硕士', majorText: '会计', majorCodes: '' }))).ok, false);

// --- 3.12 以「应」开头的专业名不能被当成赘语剥掉 ---
// LEAD_JUNK 里曾有裸的「应」，把应用统计削成「用统计」、应急管理削成「急管理」，
// 这些专业的人按名字搜是一个岗位都没有。
const anyNames = (text) => GK.analyzeMajor(text).byLevel.any.names;
check('「0252应用统计」解析出应用统计', anyNames('0252应用统计').indexOf('应用统计') >= 0, true);
check('「0252应用统计」不再解析出「用统计」', anyNames('0252应用统计').indexOf('用统计'), -1);
check('「应急管理」保住了首字', anyNames('应急管理').indexOf('应急管理') >= 0, true);
check('「应用心理学」保住了首字', anyNames('应用心理学').indexOf('应用心理学') >= 0, true);
// 但「专业应为X」里的「应」确实是赘语，得继续剥
check('「专业应为计算机科学与技术」仍解析出名字',
      anyNames('专业应为计算机科学与技术,软件工程').indexOf('计算机科学与技术') >= 0, true);
const appStat = GK.buildProfile(Object.assign({}, BASE, {
  level: '硕士', degree: '硕士', majorText: '应用统计', majorCodes: '', classes: [],
}));
const nAppStat = records.filter((r) => GK.matchRow(r, appStat).ok).length;
check('硕士·应用统计能搜到职位', nAppStat > 0, true);
console.log('  硕士「应用统计」修复后可报 ' + nAppStat + ' 个（修复前为 0）');

// --- 3.13 CSV 导出 ---
const sample = records.slice(0, 3).map((r) => Object.assign({}, r, { tier: 'exact', reasons: ['测试'] }));
const csv = GK.toCSV(sample);
check('CSV 带 BOM 头', csv.charCodeAt(0), 0xFEFF);
check('CSV 表头列数', csv.split('\r\n')[0].trim().split(',').length, GK.CSV_COLUMNS.length);
check('CSV 行数（含表头）', csv.trim().split('\r\n').length, 4);

/* =====================================================================
 * 四、性能
 * ===================================================================*/
section('四、性能');
const perfProfile = Object.assign({}, BASE, { level: '本科', majorText: '数据科学与大数据技术', classes: ['计算机类'] });

const t1 = Date.now();
for (let i = 0; i < 5; i++) GK.filterRecords(records, perfProfile, {});
const avg = (Date.now() - t1) / 5;
console.log('  单次全量筛选平均 ' + avg.toFixed(1) + ' ms（19,426 行）');
check('单次筛选 < 400ms', avg < 400, true);

/* =====================================================================
 * 汇总
 * ===================================================================*/
console.log('\n' + '─'.repeat(48));
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
process.exit(failed ? 1 : 0);
