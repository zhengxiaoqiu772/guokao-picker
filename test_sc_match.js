/**
 * test_sc_match.js —— sc_match.js 的验证脚本
 *
 *   node test_sc_match.js
 *
 * 数据来自 data/sc_positions.js（由 build_sc_data.py 生成）。
 * 这里的期望值是这份 2027 四川省考职位表的真实计数；源表换了要重跑
 * build_sc_data.py，再按新数字更新。
 */
'use strict';

global.window = global;
require('./data/sc_positions.js');
require('./match.js');
require('./sc_match.js');

const SC = global.SCMatch;
const DATA = global.SC_DATA;

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

/* =====================================================================
 * 一、载入
 * ===================================================================*/
section('一、数据载入');
const t0 = Date.now();
const records = SC.unpack(DATA);
const loadMs = Date.now() - t0;

check('职位总数', records.length, 4561);
check('招录总人数', records.reduce((a, r) => a + r.headcount, 0), 10158);
check('列数', DATA.H.length, 29);
check('市州数', DATA.regions.length, 24);
check('系统类别数', DATA.systems.length, 9);
console.log('  展开耗时 ' + loadMs + ' ms');

/* =====================================================================
 * 二、浏览模式：不填个人条件
 * ===================================================================*/
section('二、浏览模式');

const P = (o) => Object.assign({}, SC.DEFAULT_PROFILE, o || {});
const run = (o, opts) => SC.filterRecords(records, P(o), opts || {});

const browse = run({});
check('默认是浏览模式', browse.mode, 'browse');
check('默认列出全部 4,561 个职位', browse.stats.total, 4561);
check('默认 10,158 人', browse.stats.headcount, 10158);
check('浏览结果全部在 all 档', browse.all.every((r) => r.tier === 'all'), true);
check('浏览模式不编造匹配依据', browse.all.every((r) => r.reasons.length === 0), true);

check('市州筛选：成都 523 个', run({ cities: ['成都市'] }).stats.total, 523);
check('成都招录 1,243 人', run({ cities: ['成都市'] }).stats.headcount, 1243);
check('系统筛选：法院系统 253 个', run({ systems: ['法院系统'] }).stats.total, 253);
check('考试类别：行政执法类 1,891 个', run({ exams: ['行政执法类'] }).stats.total, 1891);
check('考录范围：本省 322 个', run({ scopes: ['本省'] }).stats.total, 322);
check('考录对象：仅限应届 1,587 个',
      run({ targets: ['应届高校毕业生'] }).stats.total, 1587);
check('考录对象：9 个按县职位合并成一项',
      run({ targets: [SC.COUNTY_CADRE_GROUP] }).stats.total, 9);
check('考录对象：单条按县写法仍能单独筛',
      run({ targets: ['面向马尔康市、金川县、小金县的优秀村（社区）干部、第一书记'] }).stats.total, 1);
check('考录对象短语：长句不原样进侧栏',
      SC.targetLabel('服务基层项目人员、四川省户籍或在四川服役的高校毕业生退役士兵，以及安排工作的退役军士和义务兵'),
      '服务基层项目人员等');
check('考录对象：两种「公安院校除外」措辞合并成 197 个',
      run({ targets: ['应届＋社会（公安除外）'] }).stats.total, 197);
check('考录对象：合并项不影响按原句单独筛',
      [run({ targets: ['应届高校毕业生（不含公安院校公安专业应届毕业生）和符合条件的社会在职、非在职人员'] }).stats.total,
       run({ targets: ['应届高校毕业生（不含公安院校公安专业应届毕业生）和符合职位要求的社会在职、非在职人员'] }).stats.total],
      [191, 6]);
check('学历要求：本科及以上 3,915 个', run({ eduReqs: ['本科及以上'] }).stats.total, 3915);
check('学位要求：学士及以上 3,821 个', run({ degreeReqs: ['学士及以上'] }).stats.total, 3821);
check('政治面貌要求：中共党员 258 个', run({ politicsReqs: ['中共党员'] }).stats.total, 258);
check('招录名额 ≥5：370 个', run({ minHeadcount: 5 }).stats.total, 370);
check('附加项：心理测试 286 个', run({ flags: ['psych'] }).stats.total, 286);
check('其他要求：限男性 1,289 个', run({ tags: ['male'] }).stats.total, 1289);
check('其他要求：参照管理 1,312 个', run({ tags: ['referenced'] }).stats.total, 1312);
check('多处筛选取交集：成都 + 法院 37 个',
      run({ cities: ['成都市'], systems: ['法院系统'] }).stats.total, 37);
check('招录名额下限叠加：成都 ≥5 人 47 个',
      run({ cities: ['成都市'], minHeadcount: 5 }).stats.total, 47);

check('定向招录 276 个，全部标了标签',
      [records.filter((r) => r.flags.directed).length,
       records.filter((r) => r.tags.indexOf('directed') >= 0).length], [276, 276]);
check('浏览模式照常列出定向招录', browse.all.some((r) => r.flags.directed), true);
check('定向招录：没有学历列', records.every((r) => !r.flags.directed || !r['学历']), true);
check('定向招录：加试、体能留空（表里没列）',
      records.filter((r) => r.flags.directed && r['加试专业'] === '' && r['体能测评'] === '').length, 276);
check('非定向的加试列已补「否」',
      records.filter((r) => !r.flags.directed && !r['加试专业']).length, 0);
check('定向招录：自治州 66 个按市州补上驻地',
      records.filter((r) => r.flags.directed && r.flags.autonomous).length, 66);
check('定向招录：非自治州不猜驻地',
      records.filter((r) => r.flags.directed && !r.flags.autonomous &&
        r['民族自治州驻地'] === '是').length, 0);
check('填了个人条件后定向招录被排除',
      run({ level: '本科' }).stats.excluded['定向招录，限特定群体'], 276);
check('定向招录不进「可报」', run({ level: '本科' }).stats.total, 3945);
check('审核单位从原表补回 76 行', records.filter((r) => r['审核单位']).length, 76);
check('系统类别含监狱、戒毒、定向',
      ['监狱系统', '戒毒系统', '定向公务员'].every((k) =>
        DATA.systems.some((e) => e[0] === k)), true);

check('浏览模式下的排除原因会记账',
      run({ cities: ['成都市'] }).stats.excluded['市州不符'], 4038);

/* =====================================================================
 * 三、个人条件：留空不排除
 * ===================================================================*/
section('三、个人条件');

check('只填学历：大专 30 个', run({ level: '大专' }).stats.total, 30);
check('只填学历：本科 3,945 个', run({ level: '本科' }).stats.total, 3945);
check('只填学历：硕士 4,285 个', run({ level: '硕士' }).stats.total, 4285);
check('学历不符计数', run({ level: '本科' }).stats.excluded['学历不符'], 340);

check('女性：排除 1,289 个限男性职位', run({ gender: '女' }).stats.total, 2996);
check('男性：排除 943 个限女性职位', run({ gender: '男' }).stats.total, 3342);

check('应届：可报 4,270 个', run({ gradStatus: 'fresh' }).stats.total, 4270);
// 旧版界面分 2025 / 2026 / 2027 三档，localStorage 里可能还存着这几个值
check('旧值 2027 仍按应届算', run({ gradStatus: '2027' }).stats.total, 4270);
check('旧值 2025 仍按应届算', run({ gradStatus: '2025' }).stats.total, 4270);
check('往届：排除 1,682 个仅限应届职位', run({ gradStatus: 'previous' }).stats.total, 2588);
check('往届（2 年基层）：可报 2,603 个',
      run({ gradStatus: 'previous2' }).stats.total, 2603);

// 「应届＋社会人员」那 155 行：身份上谁都能报，只剩公安院校应届的标签
const bothRec = records.find((r) => r['职位编码'] === '43219001');
check('找到「应届＋社会人员」样例行', !!bothRec, true);
if (bothRec) {
  check('该行不被当成仅限应届', bothRec.flags.freshOnly, false);
  check('该行标了公安院校应届除外', bothRec.flags.policeSchool, true);
  check('往届也能报该行',
        SC.matchRow(bothRec, SC.buildProfile(P({ gradStatus: 'previous' }))).ok, true);
}
check('公安院校应届除外共 292 行',
      records.filter((r) => r.flags.policeSchool).length, 292);

// 户籍地：只判「考录范围」里的本省 / 本市州
check('户籍：不填不排除', run({ hukou: '' }).stats.total, 4561);
check('户籍：四川省外，排除 322 + 94', run({ hukou: 'outside' }).stats.total, 3869);
check('四川省外同时排除两类',
      [run({ hukou: 'outside' }).stats.excluded['限本省户籍'],
       run({ hukou: 'outside' }).stats.excluded['限本市州户籍']], [322, 94]);
check('户籍：成都市，本省照收，只排 94 个其他市州',
      run({ hukou: '成都市' }).stats.total, 4191);
check('户籍：阿坝州，本州 63 个照收', run({ hukou: '阿坝州' }).stats.total, 4222);
check('户籍：凉山州', run({ hukou: '凉山州' }).stats.total, 4196);
check('只填户籍也进入「符合硬性条件」', run({ hukou: '成都市' }).mode, 'eligible');

const benRec = records.find((r) => r['考录范围'] === '本省');
check('本省：四川户籍通过', SC.scopeOk(benRec, '成都市'), true);
check('本省：四川省外不通过', SC.scopeOk(benRec, 'outside'), false);
check('本省：户籍留空不判断', SC.scopeOk(benRec, ''), true);
const cityRec = records.find((r) => r['考录范围'] === '本市州');
const otherCity = cityRec['市州'] === '阿坝州' ? '成都市' : '阿坝州';
check('本市州：本州户籍通过', SC.scopeOk(cityRec, cityRec['市州']), true);
check('本市州：别的市州不通过', SC.scopeOk(cityRec, otherCity), false);
check('全国范围：哪儿都能报', SC.scopeOk(records.find((r) => r['考录范围'] === '全国'), 'outside'), true);

check('没有法律职业资格：可报 3,777 个',
      run({ legalCert: 'none' }).stats.total, 3777);
check('只有非 A 类证书：可报 3,865 个',
      run({ legalCert: 'other' }).stats.total, 3865);
check('有 A 类证书：不排除', run({ legalCert: 'A' }).stats.total, 4285);

check('未过四级：排除 5 个要求英语的职位',
      run({ english: '无' }).stats.total, 4280);
check('已过四级：仍够不着六级岗，可报 4,280 个',
      run({ english: '四级' }).stats.total, 4280);
check('已过六级：不排除', run({ english: '六级' }).stats.total, 4285);

// 「其他要求」里的专项资格：填「没有」才排除，留空不判断
check('没有会计/审计资格：排除 44 个', run({ accountingCert: 'none' }).stats.total, 4241);
check('没有计算机资格：排除 4 个', run({ computerCert: 'none' }).stats.total, 4281);
check('没有残疾人证：排除 15 个残疾人专项', run({ disabilityCert: 'none' }).stats.total, 4270);
check('排除原因各归各的',
      [run({ accountingCert: 'none' }).stats.excluded['没有会计/审计资格'],
       run({ computerCert: 'none' }).stats.excluded['没有计算机资格'],
       run({ disabilityCert: 'none' }).stats.excluded['不是残疾人专项对象']], [44, 4, 15]);
check('三项都没有：4,222 个（三类互不重叠）',
      run({ accountingCert: 'none', computerCert: 'none', disabilityCert: 'none' }).stats.total, 4222);
check('有资格不排除', run({ accountingCert: 'has' }).stats.total, 4285);
check('留空不判断', run({ accountingCert: '', computerCert: '', disabilityCert: '' }).stats.total, 4561);
check('只填专项资格也进入「符合硬性条件」', run({ accountingCert: 'has' }).mode, 'eligible');
// 有会计资格、没有残疾人证：会计岗照收，残疾人专项仍被排掉
check('分项判断互不牵连',
      run({ accountingCert: 'has', disabilityCert: 'none' }).stats.total, 4270);

check('只填学历时进入「符合硬性条件」模式', run({ level: '本科' }).mode, 'eligible');
check('填专业后进入匹配模式',
      run({ level: '本科', majorText: '法学' }).mode, 'match');

// 筛选会写 rec.tier / rec.matchFlags，绝不能覆盖 unpack 出来的结构化 flags
const maleRec = records.find((r) => r.flags.male);
run({ gender: '女' });
check('筛选不覆盖结构化 flags', maleRec.flags.male, true);
check('匹配提示单独放在 matchFlags', Array.isArray(maleRec.matchFlags), true);

/* =====================================================================
 * 四、专业匹配
 * ===================================================================*/
section('四、专业匹配');

const lawB = run({ level: '本科', majorText: '法学', majorCodes: '030101K', classes: ['法学类'] });
check('本科法学：1,372 个', lawB.stats.total, 1372);
check('本科法学分档', [lawB.stats.byTier.exact.count, lawB.stats.byTier.class.count,
                     lawB.stats.byTier.category.count], [276, 772, 324]);

const lawM = run({ level: '硕士', degree: '硕士', majorText: '法学', classes: ['法学类'] });
check('硕士法学：1,937 个', lawM.stats.total, 1937);
check('硕士法学分档', [lawM.stats.byTier.exact.count, lawM.stats.byTier.class.count,
                     lawM.stats.byTier.category.count], [999, 0, 938]);

const cs = run({ level: '本科', majorText: '计算机科学与技术', classes: ['计算机类'] });
check('本科计算机：829 个', cs.stats.total, 829);
check('本科计算机分档', [cs.stats.byTier.exact.count, cs.stats.byTier.class.count,
                       cs.stats.byTier.category.count], [34, 471, 324]);
check('只勾计算机类：795 个', run({ level: '本科', classes: ['计算机类'] }).stats.total, 795);

// 本科/研究生分列：研究生段独有的专业，本科不应命中
const splitRec = records.find((r) => r['职位编码'] === '43210010');
check('找到本科/研究生分列的样例行', !!splitRec, true);
if (splitRec) {
  const gradOnly = '外国语言文学';
  check('本科阶段看不到研究生段专业',
        SC.matchMajor(splitRec, SC.buildProfile(P({ level: '本科', majorText: gradOnly }))).tier, null);
  const m = SC.matchMajor(splitRec,
    SC.buildProfile(P({ level: '硕士', degree: '硕士', majorText: gradOnly })));
  check('硕士阶段命中研究生段专业', m.tier, 'exact');
  check('匹配依据写明研究生阶段', m.reasons.join('').indexOf('研究生阶段') >= 0, true);
}

// 「研究生：不限」
const unlimRec = records.find((r) => r['职位编码'] === '36210007');
check('「本科：… / 研究生：不限」被识别', !!(unlimRec && unlimRec.majorUnlimited['研究生']), true);
if (unlimRec) {
  const m = SC.matchMajor(unlimRec,
    SC.buildProfile(P({ level: '硕士', degree: '硕士', majorText: '法学', classes: ['法学类'] })));
  check('研究生阶段专业不限 -> 门类档', m.tier, 'category');
  check('匹配依据写明研究生阶段不限', m.reasons[0], '专业不限（研究生阶段）');
}

// 「不含」排除项
const negRec = records.find((r) => r['职位编码'] === '36100021');
check('找到含「不含」的样例行', !!negRec, true);
if (negRec) {
  check('「工程管理」被该行的「不含工程管理」挡住',
        SC.matchMajor(negRec, SC.buildProfile(P({ level: '本科', majorText: '工程管理' }))).tier, null);
  check('「土木工程」仍可报',
        SC.matchMajor(negRec, SC.buildProfile(P({ level: '本科', majorText: '土木工程' }))).tier, 'exact');
}

// 学 / 去学：表里两写都有
check('「会计学」与「会计」按同一专业处理',
      SC.matchMajor({ major: { unlimited: false, byLevel: {
        any: { names: ['会计'], lei: [], c6: [], c4: [], c2: [] } },
        neg: [], special: false }, majorUnlimited: {} },
      SC.buildProfile(P({ level: '本科', majorText: '会计学' }))).tier, 'exact');

/* =====================================================================
 * 五、硬条件谓词
 * ===================================================================*/
section('五、硬条件谓词');

check('学历：硕士可报「本科及以上」', SC.educationOk('本科及以上', '硕士'), true);
check('学历：本科不可报「研究生」', SC.educationOk('研究生', '本科'), false);
check('学历：大专可报「专科及以上」', SC.educationOk('专科及以上', '大专'), true);
check('学历：留空不排除', SC.educationOk('研究生', ''), true);
check('学位：无学位不可报「学士及以上」', SC.degreeOk('学士及以上', '无'), false);
check('学位：硕士可报「学士及以上」', SC.degreeOk('学士及以上', '硕士'), true);
check('学位：不限对任何人都成立', SC.degreeOk('不限', '无'), true);
check('政治面貌：群众不可报「中共党员」', SC.politicsOk('中共党员', '群众'), false);
check('政治面貌：预备党员算党员', SC.politicsOk('中共党员', '中共预备党员'), true);
check('政治面貌：「不限」不排除', SC.politicsOk('不限', '群众'), true);

/* =====================================================================
 * 六、标签推断
 * ===================================================================*/
section('六、标签推断');

const disability = records.find((r) => r.tags.indexOf('disability') >= 0);
check('残疾人专项职位被识别', !!disability, true);
if (disability) {
  check('「肢体残疾三级、四级」不会被当成英语四级',
        disability.tags.indexOf('cet4'), -1);
}

const cet6 = records.find((r) => r.tags.indexOf('cet6') >= 0);
check('「大学英语六级」被识别为 cet6', !!cet6, true);
if (cet6) {
  check('六级标签不同时挂四级', cet6.tags.indexOf('cet4'), -1);
  check('六级职位的匹配依据', cet6.tags.indexOf('cet6') >= 0, true);
}

const lawA = records.find((r) => r.tags.indexOf('legalA') >= 0);
check('A 类法律职业资格被识别', !!lawA, true);
if (lawA) {
  check('A 类标签不同时挂普通法律职业资格', lawA.tags.indexOf('legal'), -1);
  check('A 类证书被算进标签选择器', run({ tags: ['legalA'] }).stats.total, 420);
}
check('只要求普通法律职业资格：88 个', run({ tags: ['legal'] }).stats.total, 88);

const acc = records.find((r) => r.tags.indexOf('accounting') >= 0);
check('会计/审计资格被识别', !!acc, true);
const ref = records.find((r) => r.tags.indexOf('referenced') >= 0);
check('「参照管理单位」被识别', !!ref, true);

const freshRec = records.find((r) => r.flags.freshOnly);
check('考录对象「仅限应届」被结构化为 freshOnly', !!freshRec, true);
check('freshOnly 共 1,682 行',
      records.filter((r) => r.flags.freshOnly).length, 1682);
const groundRec = records.find((r) => r.flags.ground2);
check('「两年以上基层工作经历」被识别', !!groundRec, true);
check('ground2 共 15 行', records.filter((r) => r.flags.ground2).length, 15);
check('公安院校应届除外被识别', records.some((r) => r.flags.policeSchool), true);

const flagRec = records.find((r) => r.flags.psych);
check('「加试心理测试」来自结构化列', !!flagRec && flagRec['加试心理测试'], '是');
check('体能测评取自结构化列',
      records.some((r) => r.flags.physical && r['体能测评'] === '是'), true);

// 结构化列写「否」，但「其他要求」明确写「加试苗语口语测试」
const miao = records.find((r) => r['职位编码'] === '36312112');
check('找到民族语言加试写反的样例行', !!miao, true);
if (miao) {
  check('「加试苗语口语测试」被补认为民族语言加试',
        miao.tags.indexOf('minorityLang') >= 0, true);
  check('该行结构化列确实写的是「否」', miao['加试民族语言'], '否');
}
check('民族语言加试共 16 行',
      records.filter((r) => r.flags.minorityLang).length, 16);
check('附加项按民族语言筛选：16 个',
      run({ flags: ['minorityLang'] }).stats.total, 16);

/* =====================================================================
 * 七、专业类目推荐
 * ===================================================================*/
section('七、专业类目推荐');

check('法学 -> 法学类',
      SC.suggestClasses('法学030101K', DATA).map((s) => s.lei), ['法学类']);
check('计算机科学与技术 -> 计算机类',
      SC.suggestClasses('计算机科学与技术', DATA).map((s) => s.lei), ['计算机类']);
check('临床医学 -> 临床医学类',
      SC.suggestClasses('临床医学', DATA).map((s) => s.lei), ['临床医学类']);

// 省考表里这俩和类目名毫无字面关系，只能靠国考的代码前缀对上
check('数据科学与大数据技术 -> 计算机类',
      SC.suggestClasses('数据科学与大数据技术', DATA).map((s) => s.lei), ['计算机类']);
check('会计学 -> 工商管理类',
      SC.suggestClasses('会计学', DATA).map((s) => s.lei), ['工商管理类']);
check('金融学 -> 金融学类（不被多候选带偏）',
      SC.suggestClasses('金融学', DATA).map((s) => s.lei), ['金融学类']);
check('推不出的专业仍然不硬猜', SC.suggestClasses('不存在的专业', DATA), []);

check('国考补充表只收单一类目',
      Object.values(DATA.majorClass).every((v) => Array.isArray(v) && v.length === 1), true);
check('国考补充表的键都是干净的专业名',
      Object.keys(DATA.majorClass).every((k) => /^[一-龥]{2,20}$/.test(k)), true);
check('补充的类目都在省考词表里',
      Object.values(DATA.majorClass).every((v) => DATA.leiVocab.some((e) => e[0] === v[0])), true);

/* =====================================================================
 * 八、检索
 * ===================================================================*/
section('八、检索');

check('搜「天府新区」命中 24 个', run({}, { search: '天府新区' }).stats.total, 24);
check('搜职位编码命中 1 个', run({}, { search: '36210007' }).stats.total, 1);
check('搜「成都」按文字命中', run({}, { search: '成都' }).stats.total > 100, true);
const miss = run({}, { search: '不存在的岗位xyz' });
check('搜不到时结果为 0', [miss.mode, miss.stats.total], ['browse', 0]);
const lawSearch = run({ level: '本科', majorText: '法学', classes: ['法学类'] }, { search: '成都' });
check('填了专业后搜索只缩小结果集',
      lawSearch.stats.total > 0 && lawSearch.stats.total < 1372, true);

/* =====================================================================
 * 九、导出
 * ===================================================================*/
section('九、导出');

const sample = records.slice(0, 3).map((r) => Object.assign({}, r, { tier: 'exact', reasons: ['测试'] }));
const csv = SC.toCSV(sample);
check('CSV 带 BOM 头', csv.charCodeAt(0), 0xFEFF);
check('CSV 表头列数', csv.split('\r\n')[0].trim().split(',').length, SC.CSV_COLUMNS.length);
check('CSV 行数（含表头）', csv.trim().split('\r\n').length, 4);

/* =====================================================================
 * 十、性能
 * ===================================================================*/
section('十、性能');

const perfProfile = P({ level: '本科', majorText: '法学', classes: ['法学类'] });
const t1 = Date.now();
for (let i = 0; i < 10; i++) SC.filterRecords(records, perfProfile, {});
const avg = (Date.now() - t1) / 10;
console.log('  单次全量筛选平均 ' + avg.toFixed(1) + ' ms（4,561 行）');
check('单次筛选 < 200ms', avg < 200, true);

/* =====================================================================
 * 汇总
 * ===================================================================*/
console.log('\n' + '─'.repeat(48));
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
process.exit(failed ? 1 : 0);
