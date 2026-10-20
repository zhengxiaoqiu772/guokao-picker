/**
 * match.js —— 国考职位匹配引擎
 *
 * 纯函数，不碰 DOM。浏览器用 <script src> 加载得到 window.GKMatch；
 * Node 里 require 得到同一个对象，所以 test_match.js 能直接跑同一套逻辑。
 *
 * 设计原则：只做能说清楚依据的判定。任何拿不准的写法都降档或打标，
 * 不猜、也不替用户下结论。
 */
(function (global) {
  'use strict';

  /* =====================================================================
   * 一、文本归一化
   * ===================================================================*/

  const FULL_TO_HALF = [
    ['，', ','], ['、', ','], ['；', ';'], ['：', ':'],
    ['（', '('], ['）', ')'], ['【', '['], ['】', ']'],
    ['　', ''], [' ', ''], [' ', ''], ['\t', ''],
  ];

  function normalize(text) {
    let out = String(text == null ? '' : text);
    for (const [from, to] of FULL_TO_HALF) {
      if (out.indexOf(from) >= 0) out = out.split(from).join(to);
    }
    return out.trim();
  }

  // 片段开头的连接词，剥掉后才能还原出真正的专业/类目名
  // 「本科生招收计算机类(0809)」这类写法，类名前挂着一截叙述文字，
  // 只剥前缀虚词会剩下「生招收计算机类」—— 那不是类目，用户勾「计算机类」时就漏岗。
  // 先切到最后一个招聘动词之后，再剥虚词。
  //
  // 「应」只在紧跟「为」时才算赘语（表里有「专业应为计算机科学与技术,…」这种写法）。
  // 不能把它整个列进虚词表：汉字里以「应」开头的专业名不少，一旦无条件剥掉，
  // 应用统计→用统计、应急管理→急管理、应用心理学→用心理学，这些专业的人
  // 按名字搜是一个岗位都搜不到的（实测「应用统计」从 0 个变成 83 个）。
  // 反过来一刀切删掉「应」也不行——「专业应为X」那 20 行会全部解析不出来。
  const LEAD_JUNK = /^(?:.*(?:招收|招录|招考|面向))?(?:(?:本科|研究生|硕士|博士|专业|学历|学位|阶段|所学|以上|须|需|为|是|的|应(?=为)|限|或|和|及|与|包括|不含|除外)+)?/;
  // 片段结尾的赘语
  const TAIL_JUNK = /(?:等专业|等学科门类|等|专业|学科门类)$/;

  const CN_RE = /^[一-龥]+$/;

  function isLeiName(name) {
    if (!name || name.length < 3 || name.length > 12) return false;
    if (name.charAt(name.length - 1) !== '类') return false;
    return !/(本科|研究生|硕士|博士|专业|学历|学位|或|和|及|的|为|须|是)/.test(name);
  }

  /* =====================================================================
   * 二、专业栏分词
   * ===================================================================*/

  const LEVELS = ['本科', '研究生', '硕士', '博士'];
  const BUCKET_KEYS = ['c6', 'c4', 'c2', 'lei', 'names'];

  // 用数组而不是 Set：每行都要存桶，19,426 行乘下来 Set 的堆开销大得离谱，
  // 而每行 token 数很少（最长也就几十个），线性查找反而更快也更省。
  function newBucket() {
    return { c6: [], c4: [], c2: [], lei: [], names: [] };
  }

  function push(list, value) {
    if (list.indexOf(value) < 0) list.push(value);
  }

  function bucketEmpty(b) {
    for (const key of BUCKET_KEYS) if (b[key].length) return false;
    return true;
  }

  /**
   * 按「本科／研究生」等学历标记切段，每段带上它限定的学历层次。
   * 表里有 2000+ 行是「本科:xxx;研究生:yyy」的分列写法，不切段必然误报。
   */
  function splitSegments(text) {
    const parts = text.split(/(本科|研究生|硕士|博士)/);
    const out = [];
    let level = 'any';
    for (const part of parts) {
      if (part === '') continue;
      if (LEVELS.indexOf(part) >= 0) { level = part; continue; }
      out.push({ level: level, text: part });
    }
    if (!out.length) out.push({ level: 'any', text: text });
    return out;
  }

  // 括号内带「不含/除外/不包括」的整组，以及段内裸露的「不含…」直到分号
  const NEG_PAREN_RE = /[([](?:[^()\[\]]*?)(?:不含|除外|不包括)(?:[^()\[\]]*?)[)\]]/g;
  const NEG_BARE_RE = /不含[^;]{1,80}/g;

  /** 收集排除项文本 */
  function collectNegations(text) {
    let out = '';
    const paren = text.match(NEG_PAREN_RE);
    if (paren) out += paren.join(',');
    const bare = text.match(NEG_BARE_RE);
    if (bare) out += ',' + bare.join(',');
    return out;
  }

  /** 把排除项从原文里挖掉，剩下的才是"正面"条件，避免排除内容混进正向 token */
  function stripNegations(text) {
    return text.replace(NEG_PAREN_RE, ',').replace(NEG_BARE_RE, ',');
  }

  /** 把一个片段切成带类型的 token */
  function tokenizeInto(segmentText, bucket) {
    const pieces = segmentText.split(/[,;:/()[\]{}]/);
    for (let piece of pieces) {
      piece = piece.replace(LEAD_JUNK, '').replace(TAIL_JUNK, '');
      if (!piece) continue;

      // 剥掉一个代码后剩余部分可能还嵌着下一个代码（「0812或0775计算机科学与技术」
      // 这种 A或B 写法），所以必须递归而不是直接当名字处理
      let m = /^([0-9]{6}[A-Za-z]?)(.*)$/.exec(piece);
      if (m) {
        push(bucket.c6, m[1].toUpperCase());
        const rest = m[2].replace(LEAD_JUNK, '').replace(TAIL_JUNK, '');
        if (rest) tokenizeInto(rest, bucket);
        continue;
      }
      m = /^([0-9]{4}[A-Za-z]?)(.*)$/.exec(piece);
      if (m) {
        push(bucket.c4, m[1].toUpperCase());
        const rest = m[2].replace(LEAD_JUNK, '').replace(TAIL_JUNK, '');
        if (rest) tokenizeInto(rest, bucket);
        continue;
      }
      m = /^([0-9]{2})(.*)$/.exec(piece);
      if (m && /^(0[1-9]|1[0-4]|[3-9][0-9])$/.test(m[1])) {
        push(bucket.c2, m[1]);
        const rest = m[2].replace(LEAD_JUNK, '').replace(TAIL_JUNK, '');
        if (rest) tokenizeInto(rest, bucket);
        continue;
      }
      classifyName(piece, bucket);
    }
  }

  function classifyName(name, bucket) {
    name = name.replace(LEAD_JUNK, '').replace(TAIL_JUNK, '');
    if (!name || name.length > 24) return;
    if (isLeiName(name)) push(bucket.lei, name);
    else if (CN_RE.test(name)) push(bucket.names, name);
  }

  /**
   * 解析一行的「专业」栏。
   * @returns {{raw:string, unlimited:boolean, special:boolean,
   *            neg:Set<string>, byLevel:{any,本科,研究生}}}
   */
  function analyzeMajor(raw) {
    const text = normalize(raw);
    const result = {
      raw: String(raw == null ? '' : raw),
      unlimited: /^(不限|无限制|专业不限)$/.test(text),
      special: false,
      neg: [],
      byLevel: { any: newBucket() },
    };
    if (result.unlimited || !text) return result;

    // 「除X外…」是反义结构，做不了可靠判定，只标记让人复核
    if (/除[^,;]{1,40}外/.test(text)) result.special = true;
    if (/不含|除外|不包括/.test(text) && !/[([](?:[^()\[\]]*?)(?:不含|除外)/.test(text)) {
      result.special = true;
    }

    for (const seg of splitSegments(text)) {
      // 桶按需创建：绝大多数行没有学历分列，只留一个 any 桶
      let bucket = result.byLevel[seg.level];
      if (!bucket) bucket = result.byLevel[seg.level] = newBucket();

      const negText = collectNegations(seg.text);
      if (negText) {
        const negBucket = newBucket();
        tokenizeInto(negText, negBucket);
        for (const key of BUCKET_KEYS) {
          for (const v of negBucket[key]) push(result.neg, v);
        }
      }
      tokenizeInto(stripNegations(seg.text), bucket);
    }
    return result;
  }

  /* =====================================================================
   * 三、备注风险标签
   * 正则都是从这份表的真实措辞里总结出来的，括号里是实测命中量。
   * ===================================================================*/

  const TAG_DEFS = [
    // 「应届」在国考里是两层意思，不能当一回事：
    //   写「2027届高校毕业生」的，只限当年毕业的人；
    //   写「应届高校毕业生」的，按报名指南含择业期内（两年）未落实工作单位的毕业生。
    // 两条都由 analyzeFreshness 判定，所以这里 re 留空，不走下面的通用正则循环。
    { key: 'cohort', label: '限当年应届', tone: 'hard', re: null,
      desc: '备注写明「2027届高校毕业生」，只限当年毕业的应届生' },               // 7708
    { key: 'fresh', label: '限应届（含择业期）', tone: 'hard', re: null,
      desc: '备注写明「限应届高校毕业生」，择业期内未落实工作单位的毕业生也算' },   // 3939
    // 性别：认「男性 / 女性」两个词，**不能要求「限」字**。
    // 税务系统的标准写法是「2027届高校毕业生,男性,在本单位最低服务年限为5年」——
    // 性别单独成句、省略谓语，全表 3,206 行这么写，一个「限」字也没有。
    // 早先写成 /限男性/，只认到 1,084 行，另外 3,206 行里选了「女」照样推上来，
    // 用户报了两次才发现（四川天府新区税务局 300110001001 备注就是「男性,在本单位…」）。
    // 反过来放宽到「男性」很安全：全表没有一行出现「不限男性」「不适合男性」，
    // 也没有「适合男性」这类软措辞；而「子女」「妇女」「男子1000米(男)体能项目」
    // 这些噪声都不含「性」字，自然被挡在外面（放宽后仍剩 273 行含男/女字但不打标，全是噪声）。
    { key: 'male', label: '限男性', tone: 'hard',
      desc: '备注写明男性', re: /男性/ },                                        // 4290
    { key: 'female', label: '限女性', tone: 'hard',
      desc: '备注写明女性', re: /女性/ },                                        // 3563
    // 英语等级：汉字写法（四级/六级）之外，还有一整批写成阿拉伯数字的
    // 「大学英语4级成绩425分及以上」——外交部、中联部那批驻外岗位的标准句式，
    // 共 22 行，汉字写法一个都没有，早先全漏标（用户报的 200110002002 就是）。
    // 只认「大学英语」这个前缀，不认裸的「英语4级」：民航系统有一批
    // 「具备国际民航组织英语4级及以上能力」，那是飞行人员的 ICAO 英语等级，
    // 跟四级考试毫无关系，4 行，全部是飞行员/管制员岗。放宽到裸的「英语4级」
    // 会把这 4 行误判成要求四级。
    { key: 'cet6', label: '要求六级', tone: 'hard',
      desc: '备注要求英语六级', re: /六级|大学英语\s*6\s*级/ },                  // 1998
    { key: 'cet4', label: '要求四级', tone: 'hard',
      desc: '备注要求英语四级', re: /四级|大学英语\s*4\s*级/ },                  // 2895
    { key: 'hukou', label: '户籍/生源', tone: 'warn',
      desc: '备注含户籍或生源地限制', re: /户籍|生源地|生源/ },                    // 543
    { key: 'service5', label: '最低服务期', tone: 'warn',
      desc: '在本单位最低服务年限（多为 5 年）',
      re: /最低服务年限为?[0-9一二三四五]+年|最低服务期[为]?[0-9一二三四五]*年/ },  // ~14000
    { key: 'physical', label: '体能/体检', tone: 'warn',
      desc: '需体能测评或特殊体检标准', re: /体能|体检/ },                          // 1850
  ];

  const TAG_BY_KEY = {};
  for (const def of TAG_DEFS) TAG_BY_KEY[def.key] = def;

  /* ---------------------------------------------------------------------
   * 应届身份：两个层次
   *   届别限制 —— 备注里正向提到「20XX届高校毕业生」。表里 6,323 行甚至只写这一句、
   *              不带任何限定动词，但备注栏通篇都是要求，独句成行就等于「本职位面向该届」。
   *   应届限制 —— 备注里写「限应届…」。这一种按报名指南含择业期，比届别宽。
   * 一行同时出现两者时以更宽的「应届」为准：那些行写的是
   * 「限应届高校毕业生报考；…；2027届高校毕业生需通过无限航区三副考试」，
   * 后一句是给 2027 届附加的条件，不是把范围收窄到 2027 届。
   * 「非2027届高校毕业生报考的须…」是给往届生加条件，不是限制，用否定前瞻挡掉。
   * -------------------------------------------------------------------*/
  // 限定动词后面允许隔一个年份：「限2027年应届高校毕业生」也算限应届。
  // 「该职位限招」也是漏的写法之一，一并补上。
  const LIMIT_VERB = '(?:仅限|限招|仅招录|本职位限招|本岗位限招|该职位限招|招考对象为|招录对象为|限)';
  const FRESH_LIMIT_RE = new RegExp(LIMIT_VERB + '[0-9]{0,4}年?应届');

  // 裸的「应届高校毕业生」：备注栏通篇都是要求，独立成句就等于「本职位面向应届」。
  // 税务系统的标准句式是「应届高校毕业生,男性,在本单位最低服务年限为5年」——
  // 性别和应届并列，谁也不带限定动词。先前只认「限应届」，全表 1,473 行这批
  // 全部漏标，往届生照样能看到（用户报的 300110044001 就是）。
  //
  // 但同样几个字，换个位置意思就反了，所以必须卡在「独立成句」上：
  //   「4.如考生为应届高校毕业生,请在备注栏中注明本人具有应届高校毕业生身份,
  //    如考生为非应届高校毕业生,要求具有2年以上金融业机构从业经历」——1,312 行这种，
  //   两种身份都能报，只是各自附加条件不同，绝不是限应届。这句里的「应届高校毕业生」
  //   跟在「具有」后面，不是句首，自然进不来（其中 1,300 行另有真限制，照样会被
  //   上面的动词式认出来；真正只靠这句话的 12 行，全是这种两身份并列的条件句）。
  //   「非应届高校毕业生报考…」——说的是往届，句首是「非」不是「应届」。
  // 要求「应届」前面是行首、标点或序号，再加上下面那道「同句不得出现『非应届』」的闸。
  const FRESH_BARE_RE = /(?:^|[,;。、\s]|[0-9]+[.．])应届(?:高校)?毕业生/;
  // 「应届…需 X；非应届…需 Y」是两种身份各自的条件，不是把范围收到应届。
  // 实测全表只有 2 行走这个岔（id=71 英语翻译岗、id=18419 空管岗），
  // 且**没有一行**同时命中上面的动词式，所以这道闸不可能误伤真限制。
  const FRESH_NEG_RE = /非应届|不是应届/;

  const COHORT_RE = /(?<!非)20([0-9]{2})届/g;

  /** 一份备注里正向出现的届别（可能多个），非应届写法不计入 */
  function cohortYearsOf(remark) {
    const text = String(remark == null ? '' : remark);
    if (!/届/.test(text)) return [];
    const years = [];
    COHORT_RE.lastIndex = 0;
    let m;
    while ((m = COHORT_RE.exec(text))) {
      const y = 2000 + Number(m[1]);
      if (y >= 2020 && y <= 2040 && years.indexOf(y) < 0) years.push(y);
    }
    return years;
  }

  /**
   * 判定一行属于哪一档应届限制。
   * @returns {{tag:string|null, years:number[]}}
   */
  function analyzeFreshness(remark) {
    const text = String(remark == null ? '' : remark);
    if (FRESH_LIMIT_RE.test(text)) return { tag: 'fresh', years: [] };
    if (FRESH_BARE_RE.test(text) && !FRESH_NEG_RE.test(text)) return { tag: 'fresh', years: [] };
    const years = cohortYearsOf(text);
    if (years.length) return { tag: 'cohort', years: years };
    return { tag: null, years: [] };
  }

  /** 备注栏 + 职位分布 一起判定风险标签 */
  function analyzeRemark(remark, jobDistribution) {
    const text = String(remark == null ? '' : remark);
    const tags = [];
    for (const def of TAG_DEFS) {
      if (def.re && def.re.test(text)) tags.push(def.key);
    }
    const fresh = analyzeFreshness(text);
    if (fresh.tag) tags.push(fresh.tag);
    // 「西部地区和艰苦边远地区职位」是结构化字段，比正则可靠
    if (String(jobDistribution || '').indexOf('西部') >= 0) tags.push('west');
    return tags;
  }

  const EXTRA_TAGS = {
    west: { key: 'west', label: '西部/艰苦边远', tone: 'warn',
            desc: '职位分布标注为西部地区和艰苦边远地区职位' },
  };

  // 届别是 unpack 时从数据里认出来的，所以这两个标签的文字要现算，不能写死在 TAG_DEFS 里
  function tagLabel(key) {
    if (key === 'cohort') return '限' + EXAM_COHORT_YEAR + '届（当年应届）';
    return (TAG_BY_KEY[key] || EXTRA_TAGS[key] || { label: key }).label;
  }

  function tagDesc(key) {
    if (key === 'cohort') {
      return '备注写明「' + EXAM_COHORT_YEAR + '届高校毕业生」，只限当年毕业的应届生';
    }
    return (TAG_BY_KEY[key] || EXTRA_TAGS[key] || { desc: '' }).desc;
  }

  /* =====================================================================
   * 四、硬性条件判定
   * ===================================================================*/

  const EDU_RULES = {
    '大专及以上': ['大专', '本科', '硕士', '博士'],
    '大专或本科': ['大专', '本科'],
    '仅限大专': ['大专'],
    '本科及以上': ['本科', '硕士', '博士'],
    '仅限本科': ['本科'],
    '本科或硕士研究生': ['本科', '硕士'],
    '硕士研究生及以上': ['硕士', '博士'],
    '仅限硕士研究生': ['硕士'],
    '仅限博士研究生': ['博士'],
  };

  const POLITICS_RULES = {
    '不限': ['群众', '共青团员', '中共党员', '中共预备党员'],
    '中共党员': ['中共党员', '中共预备党员'],
    '中共党员或共青团员': ['中共党员', '中共预备党员', '共青团员'],
  };

  const YEARS_RULES = { '无限制': 0, '一年': 1, '二年': 2, '三年': 3, '五年以上': 5 };

  const SERVICE_KEYS = [
    ['大学生村官', /大学生村官/],
    ['特岗计划', /特设岗位|特岗/],
    ['三支一扶', /三支一扶/],
    ['西部计划', /西部计划/],
    ['退役士兵', /退役士兵/],
  ];

  // 学位按「等级 ≥ 要求」判定：硕士学位持有人当然也满足「学士」要求
  const DEGREE_NEED = { '无要求': 0, '学士': 1, '硕士': 2, '博士': 3 };
  const DEGREE_RANK = { '无': 0, '学士': 1, '硕士': 2, '博士': 3 };
  const LEVEL_RANK = { '大专': 0, '本科': 1, '硕士': 2, '博士': 3 };

  function educationOk(rowEdu, userLevel) {
    const allowed = EDU_RULES[rowEdu];
    if (!allowed) return { ok: true, unknown: true };   // 未知取值不拦，交给人看
    return { ok: allowed.indexOf(userLevel) >= 0 };
  }

  function politicsOk(rowPolitics, userPolitics) {
    const allowed = POLITICS_RULES[rowPolitics];
    if (!allowed) return { ok: true, unknown: true };
    return { ok: allowed.indexOf(userPolitics) >= 0 };
  }

  function yearsOk(rowYears, userYears) {
    const need = YEARS_RULES[rowYears];
    if (need === undefined) return { ok: true, unknown: true };
    return { ok: userYears >= need };
  }

  function degreeOk(rowDegree, userDegree, userLevel) {
    if (rowDegree === '与最高学历相对应的学位') {
      // 要求「与最高学历相对应」，即学历和学位都拿到了
      return { ok: DEGREE_RANK[userDegree] >= LEVEL_RANK[userLevel] };
    }
    const need = DEGREE_NEED[rowDegree];
    if (need === undefined) return { ok: true, unknown: true };
    return { ok: DEGREE_RANK[userDegree] >= need };
  }

  /** 服务基层项目：职位要求集必须被用户拥有集覆盖 */
  function serviceOk(rowService, userServiceSet) {
    if (!rowService || rowService === '无限制') return { ok: true, required: [] };
    const required = [];
    for (const [name, re] of SERVICE_KEYS) {
      if (re.test(rowService)) required.push(name);
    }
    if (!required.length) return { ok: true, unknown: true, required: [] };
    const ok = required.every((r) => userServiceSet.has(r));
    return { ok: ok, required: required };
  }

  function provinceOf(location) {
    const text = String(location || '');
    const provinces = global.GK_DATA ? global.GK_DATA.provinces : [];
    for (const p of provinces) {
      if (text.indexOf(p) === 0) return p;
    }
    const m = /^(.{2,4}?(?:省|市|自治区|特别行政区))/.exec(text);
    return m ? m[1] : (text.slice(0, 6) || '未知');
  }

  /* =====================================================================
   * 五、专业分级匹配
   * ===================================================================*/

  const TIERS = {
    exact:    { key: 'exact',    label: '精准命中',        stamp: '精准',
                desc: '专业名称或 6 位专业代码直接命中' },
    class:    { key: 'class',    label: '专业类命中',      stamp: '类合',
                desc: '命中你勾选的专业类目' },
    category: { key: 'category', label: '门类命中 · 专业不限', stamp: '门类',
                desc: '门类级命中或专业不限，建议人工确认' },
    // 专业栏空着时的纯文字检索。它不是一个匹配档位——不构成「你能报」的判断，
    // 只是把表里符合关键词的行捞出来，所以单列一档，界面上也不用朱砂印章。
    search:   { key: 'search',   label: '按名称检索',      stamp: '检索',
                desc: '部门、职位、代码、地点、专业栏与备注' },
  };

  /**
   * 用户输入的专业名/代码 -> 自动推断可选类目（给界面做推荐）
   *
   * 证据分三档，每个输入片段只采信它手上最强的那一档：
   *   0 用户直接给了代码 —— 最可靠
   *   1 专业名与词表完全一致
   *   2 词表名是输入的前缀（「计算机科学与技术（嵌入式培养）」这类带后缀的写法）
   *
   * 分档是必须的：不分档时，输入「数据科学与大数据技术080910T」会同时推荐
   * 计算机类和统计学类 —— 因为词表里有「071203T 数据科学」，被当作子串命中。
   * 但「数据科学」（理学·统计学类）和「数据科学与大数据技术」（工学·计算机类）
   * 是两个专业，把用户带到统计学类去是错的。用户自己给了 080910T，就听代码的。
   */
  function suggestClasses(input, dicts) {
    const found = new Map();
    const text = normalize(input);
    if (!text) return [];

    for (const token of text.split(/[,;:/]/).filter(Boolean)) {
      const cands = new Map();
      const add = (lei, from, code, rank) => {
        const cur = cands.get(lei);
        if (!cur || rank < cur.rank) cands.set(lei, { lei: lei, from: from, code: code, rank: rank });
      };
      const byPrefix = (code, from, rank) => {
        for (const lei of dicts.codeToLei[code.slice(0, 4)] || []) add(lei, from, code, rank);
      };

      // 0 档：代码
      const codes6 = token.match(/[0-9]{6}[A-Za-z]?/g) || [];
      for (const code of codes6) byPrefix(code, token, 0);
      if (!codes6.length) {
        for (const code of token.match(/[0-9]{4}/g) || []) byPrefix(code, token, 0);
      }

      // 1/2 档：按专业名，先把代码从片段里摘掉
      const bare = token.replace(/[0-9]{4,6}[A-Za-z]?/g, '');
      if (bare) {
        for (const [code, name] of dicts.majorDict) {
          if (name === bare) byPrefix(code, name, 1);
          else if (name.length >= 4 && bare.indexOf(name) === 0) byPrefix(code, name, 2);
        }
      }

      if (!cands.size) continue;
      let best = Infinity;
      cands.forEach((c) => { if (c.rank < best) best = c.rank; });
      cands.forEach((c) => { if (c.rank === best) found.set(c.lei, c); });
    }
    return [...found.values()];
  }

  /**
   * 判定单个职位的专业匹配档位。
   * @returns {{tier:string|null, reasons:string[], flags:string[]}}
   */
  function matchMajor(rec, profile) {
    const a = rec.major;
    const reasons = [];
    const flags = [];

    if (a.unlimited) {
      return { tier: 'category', reasons: ['专业不限'], flags: [] };
    }

    // 用户学历层次 -> 该看哪些段。大专只能看「未分层次」的部分
    const buckets = [a.byLevel.any];
    const levelBucket = a.byLevel[profile.majorLevel];
    if (levelBucket) buckets.push(levelBucket);

    const has = (key, value) => {
      for (const b of buckets) if (b[key].indexOf(value) >= 0) return true;
      return false;
    };
    const isNeg = (token) => a.neg.indexOf(token) >= 0;

    /**
     * 本科阶段专业名的简写。表里有些行把「会计学」写成「会计」、「审计学」写成「审计」：
     * 本科专业目录里没有叫「会计」的，这是表的简写，不是另一个专业。
     * 不认这一层，填「会计」和填「会计学」是两拨互不相干的结果——实测只有 3 个重合，
     * 而本科·会计学的人本来该能看到 565 个。
     *
     * 只限本科阶段（用户指定的范围）。研究生那边「会计（1253）」「审计（0257）」
     * 是专业学位的正式名字，不是简写，所以不能一并处理——按 majorLevel 卡住就够了。
     *
     * 早先还多加了一道「该段没有代码才认」的闸，理由是怕把 1253会计 误并进来。
     * 实测那道闸只挡住了本该匹配的行（会计 403 vs 会计学 565），去掉之后两边
     * 严丝合缝地相等，一行假阳性都没多，所以拆了。
     * @returns {string|null} 表里实际写的那个简写名
     */
    function looseAlt(name) {
      if (profile.majorLevel !== '本科') return null;
      const alt = name.charAt(name.length - 1) === '学'
        ? name.slice(0, -1)          // 会计学 -> 会计
        : name + '学';                // 会计   -> 会计学
      if (alt.length < 2) return null;
      for (const b of buckets) if (b.names.indexOf(alt) >= 0) return alt;
      return null;
    }

    // 一档：专业名 / 6 位代码
    let exactHits = [];
    const looseHits = [];                       // {from: 用户写的, to: 表里写的}
    for (const code of profile.codes) if (has('c6', code)) exactHits.push(code);
    for (const name of profile.names) {
      if (has('names', name)) { exactHits.push(name); continue; }
      const alt = looseAlt(name);
      if (alt) { exactHits.push(alt); looseHits.push({ from: name, to: alt }); }
    }
    const exactBlocked = exactHits.filter(isNeg);
    exactHits = exactHits.filter((t) => !isNeg(t));
    if (exactHits.length) {
      const suffix = profile.majorLevel === '大专' ? '' : '（' + profile.majorLevel + '阶段）';
      reasons.push('命中专业' + suffix + '：' + exactHits.slice(0, 4).join(' / '));
      // 把「表里写的是简写」讲明白，否则用户会疑惑自己填的是「会计学」，
      // 这行怎么报了个「会计」上来
      if (looseHits.length) {
        reasons.push('该行写作「' + looseHits.map((h) => h.to).join('、') +
                     '」，与你填的「' + looseHits.map((h) => h.from).join('、') +
                     '」在本科阶段视为同一专业');
      }
      if (a.special) flags.push('专业栏含「除…外」等特殊限定，需人工确认');
      return { tier: 'exact', reasons: reasons, flags: flags };
    }

    // 二档：勾选的专业类目
    let classHits = [];
    let catHits = [];
    for (const cls of profile.classes) {
      if (!has('lei', cls)) continue;
      if (isNeg(cls)) continue;
      if (/(门类|大类|学科门类)$/.test(cls)) catHits.push(cls);
      else classHits.push(cls);
    }
    if (classHits.length) {
      reasons.push('命中专业类目：' + classHits.slice(0, 4).join(' / '));
      if (a.special) flags.push('专业栏含「除…外」等特殊限定，需人工确认');
      return { tier: 'class', reasons: reasons, flags: flags };
    }
    if (catHits.length) {
      reasons.push('命中门类：' + catHits.join(' / '));
      flags.push('门类级匹配范围较宽，需人工确认');
      return { tier: 'category', reasons: reasons, flags: flags };
    }

    // 被排除项挡掉的情况要说明，否则用户会以为是漏匹配
    if (exactBlocked.length) {
      return { tier: null, reasons: [],
               flags: ['命中的「' + exactBlocked[0] + '」被该职位的排除条件排除'],
               blocked: true };
    }
    if (a.special) {
      return { tier: null, reasons: [], flags: ['专业栏含特殊限定，本工具不做判定'], blocked: true };
    }
    return { tier: null, reasons: [], flags: flags };
  }

  /* =====================================================================
   * 六、整行判定
   * ===================================================================*/

  /**
   * 当年应届的届别 = 这份职位表所属的考试年度。
   * 不写死：unpack() 时按备注里正向出现最多的那个届别定下来，换一份新表不用改代码。
   * 这里的 2027 只是「还没 unpack 就调 buildProfile」时的兜底（测试里有这种用法）。
   */
  let EXAM_COHORT_YEAR = 2027;
  const COHORT_SPAN = 2;                  // 国家规定的择业期：两年

  const DEFAULT_PROFILE = {
    level: '本科',                          // 大专 / 本科 / 硕士 / 博士
    degree: '学士',                         // 无 / 学士 / 硕士 / 博士
    politics: '群众',                       // 群众 / 共青团员 / 中共党员 / 中共预备党员
    years: 0,                               // 基层工作年限：0/1/2/3/5
    services: [],                           // 服务基层项目
    gender: '不限',                         // 不限 / 男 / 女
    gradYear: '2027',                       // 毕业年份：2027 / 2026 / 2025 / 'earlier'
    // 英语默认留空，表示「没填」而不是「没过四级」。空值是弃权，不排除任何职位；
    // 一旦填成「无」就是在断言自己没通过四级，那些职位才该被排除。
    english: '',                            // '' 未填 / 无 / 四级 / 六级
    majorText: '',
    majorCodes: '',
    classes: [],
    provinces: [],
    levels: [],                             // 机构层级
    exams: [],                              // 考试类别
    attrs: [],                              // 职位属性
    categories: [],                         // 招录类别
    minHeadcount: 0,
    ratios: [],
    excludeTagKeys: [],                     // 用户显式勾选要排除的标签
    onlyCohort: false,                      // 只看备注明确限当年届的职位
    ruleFresh: true,                        // 往届时排除「仅限应届」
    ruleGender: true,                       // 按性别排除
    ruleEnglish: true,                      // 按英语等级排除
  };

  /** 把界面上的画像整理成匹配用的 token 集合 */
  function buildProfile(raw) {
    const p = Object.assign({}, DEFAULT_PROFILE, raw || {});
    p.servicesSet = new Set(p.services || []);
    p.provinceSet = new Set(p.provinces || []);
    p.levelSet = new Set(p.levels || []);
    p.examSet = new Set(p.exams || []);
    p.attrSet = new Set(p.attrs || []);
    p.categorySet = new Set(p.categories || []);
    p.ratioSet = new Set(p.ratios || []);
    p.tagSet = new Set(p.excludeTagKeys || []);

    // 毕业年份：四位数字，或 'earlier'（已过择业期）。0 表示不适用应届身份，
    // 两条应届规则都过不了，正是往届该有的结果。
    const gy = String(p.gradYear == null ? '' : p.gradYear);
    p.gradYearNum = /^[0-9]{4}$/.test(gy) ? Number(gy) : 0;
    p.withinLeeway = p.gradYearNum > 0 &&
      p.gradYearNum >= EXAM_COHORT_YEAR - COHORT_SPAN && p.gradYearNum <= EXAM_COHORT_YEAR;

    p.majorLevel = p.level === '本科' ? '本科'
                 : (p.level === '硕士' || p.level === '博士') ? '研究生'
                 : '大专';

    const names = normalize(p.majorText).split(/[,;:\/]/).filter(Boolean);
    const codes = [];
    for (const code of normalize(p.majorCodes).match(/[0-9]{6}[A-Za-z]?/g) || []) {
      codes.push(code.toUpperCase());
    }
    // 专业名里如果自带 6 位代码也一并算上
    for (const code of normalize(p.majorText).match(/[0-9]{6}[A-Za-z]?/g) || []) {
      codes.push(code.toUpperCase());
    }
    p.names = names.filter((n) => !/^[0-9]+$/.test(n));
    p.codes = [...new Set(codes)];
    p.classes = (p.classes || []).slice();
    return p;
  }

  /**
   * 判定一行。返回 {ok, tier, reasons, flags, reasonExcluded}
   */
  function matchRow(rec, profile) {
    const flags = [];

    // --- 硬条件：不满足直接出局 ---
    const edu = educationOk(rec['学历'], profile.level);
    if (!edu.ok) return { ok: false, why: '学历不符' };
    const deg = degreeOk(rec['学位'], profile.degree, profile.level);
    if (!deg.ok) return { ok: false, why: '学位不符' };
    const pol = politicsOk(rec['政治面貌'], profile.politics);
    if (!pol.ok) return { ok: false, why: '政治面貌不符' };
    const yr = yearsOk(rec['基层工作最低年限'], profile.years);
    if (!yr.ok) return { ok: false, why: '基层年限不足' };
    const sv = serviceOk(rec['服务基层项目工作经历'], profile.servicesSet);
    if (!sv.ok) return { ok: false, why: '缺少要求的基层项目经历' };

    // --- 地区 ---
    if (profile.provinceSet.size && !profile.provinceSet.has(rec.province)) {
      return { ok: false, why: '地区不符' };
    }
    if (profile.levelSet.size && !profile.levelSet.has(rec['机构层级'])) {
      return { ok: false, why: '机构层级不符' };
    }
    if (profile.examSet.size && !profile.examSet.has(rec['考试类别'])) {
      return { ok: false, why: '考试类别不符' };
    }
    if (profile.attrSet.size && !profile.attrSet.has(rec['职位属性'])) {
      return { ok: false, why: '职位属性不符' };
    }
    if (profile.categorySet.size && !profile.categorySet.has(rec['招录类别'])) {
      return { ok: false, why: '招录类别不符' };
    }
    if (profile.ratioSet.size && !profile.ratioSet.has(rec['面试人员比例'])) {
      return { ok: false, why: '面试比例不符' };
    }
    if (profile.minHeadcount && rec.headcount < profile.minHeadcount) {
      return { ok: false, why: '招考人数不足' };
    }

    // --- 专业分级 ---
    // 排在备注规则前面：专业是职位表里的正式字段，备注规则是从中文里推断的，
    // 正式字段更该先表态。顺序只影响「第一个不满足的原因」算在谁头上，不影响
    // ok / 不 ok，但算错会直接说谎：19,426 行里绝大多数是专业对不上，若先判备注，
    // 顶部就会报「已按备注排除 7,182 个限2027届的职位」，而其中绝大部分人本来就报不了，
    // 用户实际损失的远小于这个数。
    const major = matchMajor(rec, profile);
    if (!major.tier) {
      return { ok: false, why: '专业未命中', flags: major.flags };
    }

    // --- 备注风险标签（依据备注，可开关，始终提示来源）---
    const tagSet = new Set(rec.tags);

    // 「只看限当年届」是用户显式收窄，不挂在 ruleFresh 上——关掉「按应届身份排除」
    // 也照样生效。只认 cohort 这一档：备注写「限应届高校毕业生」的按报名指南
    // 含择业期（2025—2027 届），写「2027届高校毕业生」的才只收当年那一届；
    // 完全不提应届的职位更是谁都收，三者不能混为一谈。
    if (profile.onlyCohort) {
      const need = rec.cohortReq || [];
      const onlyThisCohort = need.length > 0 && !tagSet.has('fresh') &&
        need.every(function (y) { return y === EXAM_COHORT_YEAR; });
      if (!onlyThisCohort) {
        return { ok: false, why: '不在「仅限' + EXAM_COHORT_YEAR + '届」范围' };
      }
    }

    if (profile.ruleFresh) {
      // 「限2027届高校毕业生」只认当年那届；「限应届高校毕业生」认择业期内两年
      const need = rec.cohortReq || [];
      if (need.length && need.indexOf(profile.gradYearNum) < 0) {
        return { ok: false, why: '限' + need.join('、') + '届（备注）' };
      }
      if (tagSet.has('fresh') && !profile.withinLeeway) {
        return { ok: false, why: '限应届高校毕业生（备注，含择业期）' };
      }
    }
    if (profile.ruleGender) {
      if (profile.gender === '女' && tagSet.has('male')) return { ok: false, why: '限男性（备注）' };
      if (profile.gender === '男' && tagSet.has('female')) return { ok: false, why: '限女性（备注）' };
    }
    if (profile.ruleEnglish) {
      // 英语留空表示没填，两个分支都不进——不能用它去排除任何职位。
      // 卡片那边会给要求英语的职位打 ⚠，提示用户自己核对。
      if (profile.english === '无' && (tagSet.has('cet4') || tagSet.has('cet6'))) {
        return { ok: false, why: '有英语等级要求（备注）' };
      }
      if (profile.english === '四级' && tagSet.has('cet6')) {
        return { ok: false, why: '要求六级（备注）' };
      }
    }
    for (const key of profile.tagSet) {
      if (tagSet.has(key)) return { ok: false, why: '按你的筛选排除「' + tagLabel(key) + '」' };
    }

    return {
      ok: true,
      tier: major.tier,
      reasons: major.reasons,
      flags: flags.concat(major.flags || []),
    };
  }

  /* =====================================================================
   * 七、批量筛选 + 统计
   * ===================================================================*/

  const SORTERS = {
    headcount: (a, b) => b.headcount - a.headcount,
    dept: (a, b) => a['部门名称'].localeCompare(b['部门名称'], 'zh'),
    place: (a, b) => a.province.localeCompare(b.province, 'zh'),
    tier: (a, b) => tierRank(a.tier) - tierRank(b.tier),
  };

  function tierRank(tier) {
    return tier === 'exact' ? 0 : tier === 'class' ? 1 : 2;
  }

  /**
   * @param {Array} records 已展开的职位对象
   * @param {Object} rawProfile 界面上的条件
   * @param {Object} [opts] {search, sort, offset, limit}
   */
  function filterRecords(records, rawProfile, opts) {
    opts = opts || {};
    const profile = buildProfile(rawProfile);
    const search = normalize(opts.search || '');

    // 专业栏空着时，本来一行的匹配档位都判不出来（19,426 行里只有 7 行专业不限），
    // 结果必然是 0。但「想按名字找某个岗位」跟「我能不能报」是两件事：
    // 只要搜了东西，就退回纯文字检索——扫全表、不套任何报考条件，
    // 免得人为了搜一个部门名还得先编一个专业出来。
    const noMajor = !profile.names.length && !profile.codes.length && !profile.classes.length;
    const searchOnly = !!search && noMajor;

    // 六位纯数字按「完整代码」找，不按子串：部门代码 102000（外交部）是
    // 职位代码 300110200001 中间的一段，按子串会连带捞出 39 个别的部门。
    // 但职位代码是 12 位，人常常只记得前六位，所以前缀命中照样算。
    const sixDigit = /^[0-9]{6}$/.test(search);
    const codeBoundary = sixDigit
      ? new RegExp('(^|[^0-9])' + search + '([^0-9]|$)') : null;
    const hit = (rec) => {
      const hay = rec._searchText;
      if (!hay) return false;
      if (!codeBoundary) return hay.indexOf(search) >= 0;
      return String(rec['部门代码']) === search ||
             String(rec['职位代码']).indexOf(search) === 0 ||
             codeBoundary.test(hay);
    };

    const groups = searchOnly ? { search: [] } : { exact: [], class: [], category: [] };
    const excluded = {};
    let totalHeadcount = 0;

    for (const rec of records) {
      if (searchOnly) {
        if (!hit(rec)) continue;
        rec.tier = 'search';
        rec.reasons = [];
        rec.flags = [];
        groups.search.push(rec);
        totalHeadcount += rec.headcount;
        continue;
      }
      const r = matchRow(rec, profile);
      if (!r.ok) {
        excluded[r.why] = (excluded[r.why] || 0) + 1;
        continue;
      }
      if (search && !hit(rec)) continue;
      rec.tier = r.tier;
      rec.reasons = r.reasons;
      rec.flags = r.flags;
      const bucket = groups[r.tier] || (groups[r.tier] = []);
      bucket.push(rec);
      totalHeadcount += rec.headcount;
    }

    const order = SORTERS[opts.sort] || SORTERS.tier;
    for (const key of Object.keys(groups)) groups[key].sort(order);

    const all = searchOnly
      ? groups.search
      : groups.exact.concat(groups.class, groups.category);
    const byTier = (key) => {
      const list = groups[key] || [];
      return { count: list.length, headcount: sumHead(list) };
    };
    const stats = {
      total: all.length,
      headcount: totalHeadcount,
      byTier: {
        exact: byTier('exact'),
        class: byTier('class'),
        category: byTier('category'),
        search: byTier('search'),
      },
      provinces: topCounts(all, (r) => r.province),
      levels: topCounts(all, (r) => r['机构层级']),
      exams: topCounts(all, (r) => r['考试类别']),
      depts: topCounts(all, (r) => r['部门名称']),
      tags: topCounts(
        all.reduce((acc, r) => acc.concat(r.tags), []),
        (t) => tagLabel(t)
      ),
      excluded: excluded,
    };
    return { mode: searchOnly ? 'search' : 'match', groups: groups, all: all, stats: stats };
  }

  function sumHead(list) {
    let n = 0;
    for (const r of list) n += r.headcount;
    return n;
  }

  function topCounts(list, keyFn, limit) {
    const map = new Map();
    for (const item of list) {
      const key = keyFn(item);
      if (key == null || key === '') continue;
      map.set(key, (map.get(key) || 0) + 1);
    }
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit || 12)
      .map(([name, count]) => ({ name: name, count: count }));
  }

  /* =====================================================================
   * 八、数据展开
   * 把 build_data.py 产出的列存 / 字典编码结构还原成对象数组，并预计算
   * 专业分词、风险标签、省份、搜索串。
   * ===================================================================*/

  function unpack(data) {
    const columns = {};
    data.H.forEach((name, i) => {
      const col = data.D[i];
      columns[name] = col.d ? col.i.map((k) => col.d[k]) : col.v;
    });

    const n = data.meta.total;
    const records = new Array(n);
    const cohortTally = new Map();          // 届别 -> 出现行数，用来认当年届
    for (let i = 0; i < n; i++) {
      const rec = { id: i };
      for (const name of data.H) rec[name] = columns[name][i];
      rec.headcount = parseInt(rec['招考人数'], 10) || 0;
      rec.province = provinceOf(rec['工作地点']);
      rec.major = analyzeMajor(rec['专业']);
      // 极少数行把专业代码写在备注里（4 行），补进分词结果，避免漏匹配
      if (rec['备注'].indexOf('栏中代码为') >= 0) {
        const extra = analyzeMajor(rec['备注']);
        for (const key of BUCKET_KEYS) {
          for (const v of extra.byLevel.any[key]) push(rec.major.byLevel.any[key], v);
        }
      }
      rec.tags = analyzeRemark(rec['备注'], rec['职位分布']);
      rec.cohortReq = cohortYearsOf(rec['备注']);
      for (const y of rec.cohortReq) cohortTally.set(y, (cohortTally.get(y) || 0) + 1);
      // 部门代码也进搜索文本：卡片上现在两个代码并排显示，看到就能搜；
      // 何况职位代码全表复用（19,426 行只有 7,178 个不同值），
      // 单靠职位代码搜出来的往往不止一个部门。
      rec._searchText = normalize([
        rec['部门名称'], rec['部门代码'], rec['用人司局'], rec['招考职位'], rec['职位代码'],
        rec['工作地点'], rec['专业'], rec['备注'],
      ].join('\u0001'));
      records[i] = rec;
    }

    // 出现最多的那个届别就是本次考试的当年届（2027 届 7,708 行，其余都是零散提及）。
    // 用众数而不是最大值，免得备注里冒出一个孤零零的 2035 就把整表判错。
    let bestYear = 0;
    let bestCount = 0;
    cohortTally.forEach((count, year) => {
      if (count > bestCount || (count === bestCount && year > bestYear)) {
        bestYear = year;
        bestCount = count;
      }
    });
    if (bestYear) EXAM_COHORT_YEAR = bestYear;

    return records;
  }

  /* =====================================================================
   * 九、导出
   * ===================================================================*/

  const CSV_COLUMNS = [
    '部门代码', '部门名称', '用人司局', '招考职位', '职位代码', '招考人数',
    '机构层级', '考试类别', '职位属性', '专业', '学历', '学位', '政治面貌',
    '基层工作最低年限', '服务基层项目工作经历', '工作地点', '落户地点', '备注',
    '咨询电话1', '匹配档位', '匹配依据',
  ];

  function toCSV(records) {
    const escape = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\n\r]/.test(s) ? '"' + s.split('"').join('""') + '"' : s;
    };
    const lines = [CSV_COLUMNS.join(',')];
    for (const rec of records) {
      const row = CSV_COLUMNS.map((col) => {
        if (col === '匹配档位') return TIERS[rec.tier] ? TIERS[rec.tier].label : '';
        if (col === '匹配依据') return (rec.reasons || []).join('；');
        return rec[col];
      });
      lines.push(row.map(escape).join(','));
    }
    // 带 BOM，Excel 打开不乱码
    return '﻿' + lines.join('\r\n');
  }

  /* =====================================================================
   * 导出接口
   * ===================================================================*/

  const api = {
    normalize: normalize,
    analyzeMajor: analyzeMajor,
    analyzeRemark: analyzeRemark,
    provinceOf: provinceOf,
    educationOk: educationOk,
    politicsOk: politicsOk,
    yearsOk: yearsOk,
    degreeOk: degreeOk,
    serviceOk: serviceOk,
    matchMajor: matchMajor,
    matchRow: matchRow,
    buildProfile: buildProfile,
    filterRecords: filterRecords,
    unpack: unpack,
    suggestClasses: suggestClasses,
    topCounts: topCounts,
    toCSV: toCSV,
    tagLabel: tagLabel,
    tagDesc: tagDesc,
    cohortYearsOf: cohortYearsOf,
    analyzeFreshness: analyzeFreshness,
    // 现取而不是导出值：EXAM_COHORT_YEAR 要等 unpack 扫完数据才定下来
    examCohortYear: function () { return EXAM_COHORT_YEAR; },
    leewayYears: function () {
      const out = [];
      for (let y = EXAM_COHORT_YEAR - COHORT_SPAN; y <= EXAM_COHORT_YEAR; y++) out.push(y);
      return out;
    },
    TIERS: TIERS,
    TAG_DEFS: TAG_DEFS,
    EXTRA_TAGS: EXTRA_TAGS,
    EDU_RULES: EDU_RULES,
    POLITICS_RULES: POLITICS_RULES,
    YEARS_RULES: YEARS_RULES,
    SERVICE_KEYS: SERVICE_KEYS,
    DEGREE_NEED: DEGREE_NEED,
    DEGREE_RANK: DEGREE_RANK,
    LEVEL_RANK: LEVEL_RANK,
    DEFAULT_PROFILE: DEFAULT_PROFILE,
    CSV_COLUMNS: CSV_COLUMNS,
  };

  global.GKMatch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
