/**
 * sy_match.js —— 事业单位岗位匹配与浏览引擎
 *
 * 纯函数，不碰 DOM。和 sc_match.js 分开写，因为两份表的字段差别很大：
 *
 *   * 省考有「考录对象」结构化列，事业单位把能不能报写在「招聘范围」整句里
 *     （部属公费师范生 / 优师计划 / 三支一扶 / 西部计划 / 退役军人 /
 *       定向医学生 / 残疾人），这里拆成身份标签来判断。
 *   * 省考的学历、学位分两列，事业单位写成一句话（大学本科学历及以上，
 *     并取得相应学士及以上学位），构建时已拆成 学历要求 / 学位要求。
 *   * 省考专业栏分「本科：/研究生：」，事业单位还多一层「大专：」，所以
 *     专业解析要自己按大专 / 本科 / 研究生切段（GK.analyzeMajor 只认前两者）。
 *   * 年龄是「1987年11月19日及以后出生」这样的截止日期，现在只随卡片展示，
 *     页面不再收出生日期，也不按年龄排除。
 *
 * 设计原则和省考一致：不填的条件一律不排除。全省汇总表 7,821 个职位里
 * 绝大多数写「面向全国招聘」，只有一百多个限定了招聘对象、户籍或基层项目，
 * 不填身份时照样全部列出。
 */
(function (global) {
  'use strict';

  const GK = global.GKMatch;

  /* =====================================================================
   * 一、常量与标签
   * ===================================================================*/

  const LEVEL_RANK = { '大专': 0, '本科': 1, '硕士': 2, '博士': 3 };
  const DEGREE_RANK = { '无': 0, '学士': 1, '硕士': 2, '博士': 3 };
  // 教师资格证的学段：高学段可以报低学段岗位（高中证能报小学岗）
  const CERT_RANK = { '小学': 1, '初中': 2, '高中': 3 };

  /** 招聘范围里可能出现的身份。key 同时用作勾选值、标签键和筛选值 */
  const IDENTITY_DEFS = [
    { key: 'teacherPublic', label: '部属公费师范生',
      desc: '招聘范围限部属公费师范生' },
    { key: 'teacherPlan', label: '优师计划师范生',
      desc: '招聘范围限优师计划师范生' },
    { key: 'sanZhi', label: '“三支一扶”服务期满',
      desc: '招聘范围限“三支一扶”服务期满且考核合格人员' },
    { key: 'xiBu', label: '“西部计划”服务期满',
      desc: '招聘范围限“西部计划”服务期满且考核合格的志愿者' },
    { key: 'veteran', label: '退役军人',
      desc: '招聘范围限退役军人（含退役大学生士兵）' },
    { key: 'veteranStudent', label: '退役大学生士兵',
      desc: '招聘范围限退役大学生士兵，通常还要求服现役满 5 年' },
    { key: 'medical', label: '定向医学生',
      desc: '招聘范围限定向医学生，通常需签订定向培养及就业协议' },
    { key: 'disabled', label: '残疾人',
      desc: '招聘范围限持有效《残疾人证》的残疾人专项岗位' },
    { key: 'ruralDoctor', label: '优秀大学生乡村医生',
      desc: '招聘范围限优秀大学生乡村医生专项计划人员' },
    { key: 'partySecretary', label: '村（社区）党组织书记',
      desc: '招聘范围限现任村（社区）党组织书记' },
  ];

  const IDENTITY_KEYS = IDENTITY_DEFS.map(function (d) { return d.key; });
  const IDENTITY_BY_KEY = {};
  for (const def of IDENTITY_DEFS) IDENTITY_BY_KEY[def.key] = def;

  const TAG_DEFS = IDENTITY_DEFS.concat([
    { key: 'certHigh', label: '要求高中教师资格证', tone: 'hard',
      desc: '需取得与报考岗位相应学科高中教师资格证' },
    { key: 'certMid', label: '初中及以上教师资格证', tone: 'hard',
      desc: '需取得与报考岗位相应学科初中及以上教师资格证' },
    { key: 'certPrimary', label: '小学及以上教师资格证', tone: 'hard',
      desc: '需取得与报考岗位相应学科小学及以上教师资格证' },
    { key: 'certOther', label: '其他教师资格证要求', tone: 'hard',
      desc: '要求中职等教师资格证，或只写「相应种类」，需看原文核对' },
    { key: 'fresh2026', label: '限2026届应届毕业生', tone: 'hard',
      desc: '招聘范围限 2026 届普通高等教育应届毕业生' },
    { key: 'hukouProvince', label: '限四川省户籍', tone: 'hard',
      desc: '招聘范围要求具有四川省户籍' },
    { key: 'hukouCity', label: '限本市州户籍', tone: 'hard',
      desc: '招聘范围要求具有本市（州）户籍' },
    { key: 'hukouCounty', label: '限本县市区户籍', tone: 'hard',
      desc: '招聘范围要求具有本县（市、区）户籍' },
    { key: 'localVeteran', label: '限本地入伍/户籍/安置', tone: 'info',
      desc: '退役军人岗位还要求本地兵役机关批准入伍、本地户籍或本地安置' },
    { key: 'rangeUnknown', label: '招聘范围见公告正文', tone: 'info',
      desc: '招聘范围写「详见公告正文」，本工具不做判断' },
    { key: 'provinceService', label: '限全省基层服务', tone: 'info',
      desc: '招聘范围要求已在四川省完成基层服务' },
    { key: 'cityService', label: '限本市基层服务', tone: 'info',
      desc: '招聘范围要求已在本市（州）完成基层服务' },
    { key: 'countyService', label: '限本县基层服务', tone: 'info',
      desc: '招聘范围要求已在某个县（市、区）完成基层服务' },
  ]);

  const TAG_BY_KEY = {};
  for (const def of TAG_DEFS) TAG_BY_KEY[def.key] = def;

  const TAG_ORDER = [
    'teacherPublic', 'teacherPlan', 'medical', 'disabled',
    'ruralDoctor', 'partySecretary',
    'veteran', 'veteranStudent', 'sanZhi', 'xiBu',
    'fresh2026', 'hukouProvince', 'hukouCity', 'hukouCounty',
    'localVeteran', 'rangeUnknown',
    'certHigh', 'certMid', 'certPrimary', 'certOther',
    'countyService', 'cityService', 'provinceService',
  ];

  const TIERS = {
    exact: { key: 'exact', label: '精准命中', stamp: '精准',
             desc: '专业名称或专业代码直接命中' },
    class: { key: 'class', label: '专业类命中', stamp: '类合',
             desc: '命中你勾选的专业类目' },
    category: { key: 'category', label: '门类命中 · 专业不限', stamp: '门类',
                desc: '专业不限、门类级命中或该学历层次不限专业，建议人工确认' },
    eligible: { key: 'eligible', label: '符合硬性条件', stamp: '条件',
                desc: '学历、学位、教师资格证、招聘范围等已判断；年龄与专业未判断' },
    all: { key: 'all', label: '全部岗位', stamp: '浏览',
           desc: '未填个人条件，按岗位要求浏览' },
  };

  /** 「基层服务地」里代表四川省内其他地区 / 四川省外的两个值 */
  const PLACE_OTHER = '__other__';
  const PLACE_OUTSIDE = '__outside__';

  const DEFAULT_PROFILE = {
    // 我的条件：全部默认留空 = 不排除
    level: '', degree: '', cert: '',
    majorText: '', majorCodes: '', classes: [],
    identities: [], servicePlace: '',

    // 浏览筛选：职位本身的要求
    city: '', counties: [], jobCats: [], exams: [], ranges: [],
    eduReqs: [], degreeReqs: [], certReqs: [], services: [],
    areaTags: [], minHeadcount: 0,
  };

  /* =====================================================================
   * 二、文本与招聘范围
   * ===================================================================*/

  function flat(text) {
    return String(text == null ? '' : text).replace(/\r?\n/g, '');
  }

  function addTag(list, key) {
    if (list.indexOf(key) < 0) list.push(key);
  }

  /** 「限已在三台县完成基层服务」里的地点 -> 统一写法 */
  function normalizeArea(area) {
    const s = String(area == null ? '' : area).trim();
    if (!s) return '';
    if (s === '本省' || s === '四川省') return 'province';
    // 「本县（市、区）」里有个顿号，不能按顿号切句，否则会断成「本县（市」
    if (s.indexOf('本县') === 0) return 'county';
    return s;
  }

  /**
   * 招聘范围里某个基层项目要求的地域。
   * 一句话里常并排列着三支一扶和西部计划，各取「该词之前最近一处」的限已在地点；
   * 只按「；」分句，因为「本县（市、区）」本身含顿号。
   */
  function areaFor(text, word) {
    const t = String(text == null ? '' : text);
    const at = t.indexOf(word);
    if (at < 0) return '';
    const re = /限已在([^；;]+?)完成基层服务/g;
    let found = '';
    let m;
    while ((m = re.exec(t)) !== null) {
      if (m.index > at) break;
      found = m[1];
    }
    if (found) return normalizeArea(found);
    // 项目词写在要求之前时，退而取其后最近的一处
    const after = /限已在([^；;]+?)完成基层服务/.exec(t.slice(at));
    return after ? normalizeArea(after[1]) : '';
  }

  function analyzeRange(text) {
    const t = String(text == null ? '' : text).trim();

    // 先认出「这行到底有没有限制」。全省表 7,540 行写「面向全国招聘」，
    // 85 行写「面向全国」，61 行写「无」，这些都不限对象、也不限户籍。
    const fresh2026 = /2026届/.test(t) && /应届毕业生/.test(t);
    const hukouProvince = /限本省户籍/.test(t);
    const hukouCity = /限本市州户籍/.test(t);
    const hukouCounty = /限本县[（(]?[^，；。]{0,8}户籍/.test(t);
    const localVeteran = /兵役机关/.test(t);
    const partySecretary = /党组织书记/.test(t);
    const ruralDoctor = /优秀大学生乡村医生/.test(t);

    // 「面向 2026 届应届毕业生（含三支一扶、退役后 1 年内…）」这一行
    // 括号里的项目只是「视同应届」的几种情形，不是三支一扶专项岗；
    // 认成三支一扶会让不该报的人通过，所以这一类只保留应届标签。
    const ids = fresh2026 ? {} : {
      teacherPublic: t.indexOf('部属公费师范生') >= 0,
      teacherPlan: t.indexOf('优师计划师范生') >= 0,
      sanZhi: t.indexOf('三支一扶') >= 0,
      xiBu: t.indexOf('西部计划') >= 0,
      // 「退役大学生士兵」不含「退役军人」四个字，两条各认各的
      veteran: t.indexOf('退役军人') >= 0,
      veteranStudent: t.indexOf('退役大学生士兵') >= 0,
      medical: t.indexOf('定向医学生') >= 0,
      disabled: t.indexOf('残疾人') >= 0,
      ruralDoctor: ruralDoctor,
      partySecretary: partySecretary,
    };
    const hasIdentity = Object.keys(ids).some(function (key) { return ids[key]; });

    return Object.assign({
      restricted: hasIdentity || fresh2026 || hukouProvince ||
        hukouCity || hukouCounty || localVeteran,
      unknown: /详见公告正文/.test(t),
      fresh2026: fresh2026,
      hukouProvince: hukouProvince,
      hukouCity: hukouCity,
      hukouCounty: hukouCounty,
      localVeteran: localVeteran,
      sanZhiArea: areaFor(t, '三支一扶'),
      xiBuArea: areaFor(t, '西部计划'),
      sanZhiKind: 'any',
      xiBuKind: 'any',
    }, ids);
  }

  /**
   * 基层服务地要求分成四类：
   *   province   全省（四川省 / 本省）
   *   county     「本县（市、区）」，跟着职位所在县走
   *   countyName 指名某个县（如江油市、三台县）
   *   cityName   指名某个市州（如绵阳市）
   * 江油市是县级市，不能按「市」字认成市州，所以先查 countyCity 表。
   */
  function areaKind(area, countyCity) {
    if (!area) return 'any';
    if (area === 'province') return 'province';
    if (area === 'county') return 'county';
    if (countyCity[area]) return 'countyName';
    return 'cityName';
  }

  function areaLabel(area, rec) {
    if (area === 'province') return '四川省';
    if (area === 'county') return rec['县市区'];
    return area;
  }

  function rangeHit(rec, key) {
    // 浏览筛选里勾「退役军人」时把退役大学生士兵也算进来：
    // 后者是前者的子集，分开列会让人以为退役军人报不了那些岗
    if (key === 'veteran') return rec.range.veteran || rec.range.veteranStudent;
    return !!rec.range[key];
  }

  function tagsOf(rec) {
    const tags = [];
    for (const key of IDENTITY_KEYS) if (rec.range[key]) addTag(tags, key);
    if (rec.range.fresh2026) addTag(tags, 'fresh2026');
    if (rec.range.hukouProvince) addTag(tags, 'hukouProvince');
    if (rec.range.hukouCity) addTag(tags, 'hukouCity');
    if (rec.range.hukouCounty) addTag(tags, 'hukouCounty');
    if (rec.range.localVeteran) addTag(tags, 'localVeteran');
    if (rec.range.unknown) addTag(tags, 'rangeUnknown');
    const cert = rec['教资要求'];
    if (cert === '高中') addTag(tags, 'certHigh');
    else if (cert === '初中及以上') addTag(tags, 'certMid');
    else if (cert === '小学及以上') addTag(tags, 'certPrimary');
    else if (cert === '其他') addTag(tags, 'certOther');
    for (const kind of [rec.range.sanZhiKind, rec.range.xiBuKind]) {
      if (kind === 'province') addTag(tags, 'provinceService');
      else if (kind === 'county' || kind === 'countyName') addTag(tags, 'countyService');
      else if (kind === 'cityName') addTag(tags, 'cityService');
    }
    return TAG_ORDER.filter(function (key) { return tags.indexOf(key) >= 0; });
  }

  /* =====================================================================
   * 三、专业匹配
   * ===================================================================*/

  const SY_LEVELS = {
    '大专': '大专', '专科': '大专', '本科': '本科',
    '研究生': '研究生', '硕士': '研究生', '博士': '研究生',
  };
  const BUCKET_KEYS = ['c6', 'c4', 'c2', 'lei', 'names'];

  function emptyBucket() {
    return { c6: [], c4: [], c2: [], lei: [], names: [], unlimited: false };
  }

  function trimMajor(text) {
    return GK.normalize(text).replace(/^[\s:：,，;；]+|[\s:：,，;；]+$/g, '');
  }

  /** 「不限专业」是这份表最常见的写法；国考那种「专业不限」也一起认 */
  function isUnlimitedPhrase(text) {
    return /^(不限|不限专业|专业不限|无限制)$/.test(trimMajor(text));
  }

  /**
   * 按大专 / 本科 / 研究生切段解析专业栏。
   * GK.analyzeMajor 只按本科 / 研究生 / 硕士 / 博士切段，大专段会落进 any 桶，
   * 于是大专学历的人会看到本科专业也“命中”。这里自己切，再借它的分词。
   */
  function analyzeMajorSY(raw) {
    const text = GK.normalize(raw);
    const result = {
      raw: String(raw == null ? '' : raw),
      unlimited: false,
      special: false,
      neg: [],
      byLevel: {},
    };
    if (!text) return result;
    if (isUnlimitedPhrase(text)) {
      result.unlimited = true;
      return result;
    }

    const parts = String(raw == null ? '' : raw)
      .split(/(大专|专科|本科|研究生|硕士|博士)/);
    const segs = [];
    let level = 'any';
    for (const part of parts) {
      if (!part) continue;
      if (SY_LEVELS[part]) { level = SY_LEVELS[part]; continue; }
      segs.push({ level: level, text: part });
    }
    if (!segs.length) segs.push({ level: 'any', text: String(raw || '') });

    for (const seg of segs) {
      const clean = trimMajor(seg.text);
      if (!clean) continue;
      if (isUnlimitedPhrase(clean)) {
        const b = result.byLevel[seg.level] ||
          (result.byLevel[seg.level] = emptyBucket());
        b.unlimited = true;
        continue;
      }
      const a = GK.analyzeMajor(seg.text);
      if (a.unlimited) {
        const b = result.byLevel[seg.level] ||
          (result.byLevel[seg.level] = emptyBucket());
        b.unlimited = true;
        continue;
      }
      const bucket = result.byLevel[seg.level] ||
        (result.byLevel[seg.level] = emptyBucket());
      for (const key of BUCKET_KEYS) {
        for (const value of a.byLevel.any[key] || []) {
          if (bucket[key].indexOf(value) < 0) bucket[key].push(value);
        }
      }
      for (const value of a.neg) {
        if (result.neg.indexOf(value) < 0) result.neg.push(value);
      }
      if (a.special) result.special = true;
    }
    return result;
  }

  function unlimitedLevels(major) {
    const out = {};
    for (const level of Object.keys(major.byLevel)) {
      if (major.byLevel[level].unlimited) out[level] = true;
    }
    return out;
  }

  function altName(name) {
    if (name.length < 3) return null;
    const alt = name.charAt(name.length - 1) === '学'
      ? name.slice(0, -1)
      : name + '学';
    return alt.length >= 2 ? alt : null;
  }

  function matchMajor(rec, profile) {
    const a = rec.major;
    const reasons = [];
    const flags = [];

    if (a.unlimited) return { tier: 'category', reasons: ['专业不限'], flags: [] };

    const own = a.byLevel[profile.majorLevel];
    if (own && own.unlimited) {
      const label = profile.majorLevel === '研究生'
        ? '研究生阶段' : profile.majorLevel + '阶段';
      return { tier: 'category', reasons: ['专业不限（' + label + '）'], flags: [] };
    }

    const buckets = [];
    if (a.byLevel.any) buckets.push(a.byLevel.any);
    if (own) buckets.push(own);
    if (!buckets.length) {
      return {
        tier: null, reasons: [],
        flags: ['专业栏没有列出' + profile.majorLevel + '层次，需人工核对'],
        blocked: true,
      };
    }

    const has = function (key, value) {
      for (const b of buckets) if (b[key].indexOf(value) >= 0) return true;
      return false;
    };
    const isNeg = function (token) { return a.neg.indexOf(token) >= 0; };

    // ---- 一档：专业名 / 代码 ----
    const nameHits = [];
    const codeHits = [];
    const looseHits = [];
    for (const name of profile.names) {
      if (has('names', name)) { nameHits.push(name); continue; }
      const alt = altName(name);
      if (alt && has('names', alt)) {
        nameHits.push(alt);
        looseHits.push({ from: name, to: alt });
        continue;
      }
      // 表里把「学科教学（语文）」拆成「学科教学」「语文」两个词，
      // 用户填的是带括号的全名时，两个词都在才算命中
      const paren = /^(.+?)\((.+?)\)$/.exec(name);
      if (paren && has('names', paren[1]) && has('names', paren[2])) {
        nameHits.push(name);
      }
    }
    // 只有完整的 6 位代码算精准命中。4 位代码是专业类，
    // 不能因为同前缀就认定成同一个专业（045103 语文 ≠ 045104 数学）
    for (const code of profile.codes6) {
      if (has('c6', code)) codeHits.push(code);
    }

    const blocked = nameHits.concat(codeHits).filter(isNeg);
    const liveNames = nameHits.filter(function (t) { return !isNeg(t); });
    const liveCodes = codeHits.filter(function (t) { return !isNeg(t); });
    if (liveNames.length || liveCodes.length) {
      if (liveNames.length) {
        const label = profile.majorLevel === '大专'
          ? '专业名称' : profile.majorLevel + '阶段专业名称';
        reasons.push('命中' + label + '：' + liveNames.slice(0, 4).join(' / '));
      }
      if (liveCodes.length) {
        reasons.push('命中专业代码：' +
          Array.from(new Set(liveCodes)).slice(0, 4).join(' / '));
      }
      if (looseHits.length) {
        reasons.push('该行写作「' + looseHits.map(function (h) { return h.to; }).join('、') +
          '」，与你填的「' + looseHits.map(function (h) { return h.from; }).join('、') +
          '」按同一专业处理');
      }
      if (a.special) flags.push('专业栏含「除…外」等特殊限定，需人工确认');
      return { tier: 'exact', reasons: reasons, flags: flags };
    }

    // ---- 二档：勾选的专业类目 / 专业类代码 ----
    const classHits = [];
    const classCodeHits = [];
    const catHits = [];
    for (const cls of profile.classes) {
      if (!has('lei', cls) || isNeg(cls)) continue;
      if (/(门类|大类|学科门类)$/.test(cls)) catHits.push(cls);
      else classHits.push(cls);
    }
    for (const b of buckets) {
      // 行里写的是 4 位类代码：用户的专业（6 位前缀或直接填的 4 位）落在这个类里
      for (const code of b.c4) {
        if (profile.codes4.indexOf(code) >= 0) classCodeHits.push(code);
      }
      // 用户直接填了 4 位类代码：行里列出的 6 位专业属于这个类
      for (const code of b.c6) {
        const prefix = code.slice(0, 4);
        if (profile.codes4Explicit.indexOf(prefix) >= 0) classCodeHits.push(prefix);
      }
    }
    if (classHits.length || classCodeHits.length) {
      if (classHits.length) {
        reasons.push('命中专业类目：' + classHits.slice(0, 4).join(' / '));
      }
      if (classCodeHits.length) {
        reasons.push('命中专业类代码：' +
          Array.from(new Set(classCodeHits)).slice(0, 4).join(' / '));
      }
      if (a.special) flags.push('专业栏含「除…外」等特殊限定，需人工确认');
      return { tier: 'class', reasons: reasons, flags: flags };
    }

    // ---- 三档：门类代码 / 专业不限 ----
    for (const code of profile.codes2) {
      for (const b of buckets) {
        if (b.c2.indexOf(code) >= 0) catHits.push(code);
        for (const c of b.c6.concat(b.c4)) {
          if (c.slice(0, 2) === code) catHits.push(code);
        }
      }
    }
    if (catHits.length) {
      reasons.push('命中门类代码：' +
        Array.from(new Set(catHits)).join(' / '));
      flags.push('门类级匹配范围较宽，需人工确认');
      return { tier: 'category', reasons: reasons, flags: flags };
    }

    if (blocked.length) {
      return {
        tier: null, reasons: [],
        flags: ['命中的「' + blocked[0] + '」被该职位的排除条件排除'],
        blocked: true,
      };
    }
    if (a.special) {
      return {
        tier: null, reasons: [],
        flags: ['专业栏含特殊限定，本工具不做判定'],
        blocked: true,
      };
    }
    return { tier: null, reasons: [], flags: flags };
  }

  /* =====================================================================
   * 四、硬性条件
   * ===================================================================*/

  function educationOk(rec, level) {
    if (!level) return true;
    const need = { '大专及以上': 0, '本科及以上': 1, '研究生及以上': 2 }[rec['学历要求']];
    if (need === undefined) return true;
    return LEVEL_RANK[level] >= need;
  }

  function degreeOk(rec, degree) {
    if (!degree) return true;
    const need = { '不限': 0, '学士及以上': 1, '硕士及以上': 2, '博士': 3 }[rec['学位要求']];
    if (need === undefined) return true;
    return DEGREE_RANK[degree] >= need;
  }

  function certOk(rec, cert) {
    if (!cert) return true;
    // 表里写的是「初中及以上」「小学及以上」，去掉后缀再查学段
    const needText = String(rec['教资要求'] || '').replace(/及以上$/, '');
    // 「其他」是中职 / 相应种类 / 相应学科学段这类没法按学段排序的要求：
    // 没有证的人肯定不行；有证的人不知道够不够，放进来让他看原文。
    if (needText === '其他') return cert !== '无';
    const need = CERT_RANK[needText] || 0;
    if (!need) return true;                       // 岗位不要求教师资格证
    if (cert === '无') return false;
    return (CERT_RANK[cert] || 0) >= need;
  }

  /** 基层服务地是否覆盖职位要求的范围。没填服务地时只提示、不排除 */
  function serviceAreaOk(kind, name, rec, p) {
    if (kind === 'any') return { ok: true };
    const place = p.servicePlace;
    if (!place) return { ok: true, unknown: true };
    if (kind === 'province') {
      return { ok: place !== PLACE_OUTSIDE };
    }
    if (place === PLACE_OTHER || place === PLACE_OUTSIDE) return { ok: false };
    if (kind === 'county') return { ok: place === rec['县市区'] };
    if (kind === 'countyName') return { ok: place === name };
    // cityName：用户选的服务地必须属于这个市州
    return { ok: (p.countyCity[place] || '') === name || place === name };
  }

  /**
   * 招聘范围判定。一行可能有好几个并列分支（退役军人；本县三支一扶；
   * 本县西部计划），命中任意一个就算在范围内。
   */
  function matchRange(rec, p) {
    if (!p.rangeActive) return { ok: true, flags: [] };
    // 「面向全国招聘」「面向全国」「无」不挑人，勾了身份也照样能报。
    // 只有一百多个岗位真的限了对象或户籍。
    if (!rec.range.restricted) {
      return {
        ok: true,
        flags: rec.range.unknown
          ? ['招聘范围写「详见公告正文」，请查原公告确认'] : [],
      };
    }
    const ids = p.identitySet;
    const has = function (key) { return ids.has(key); };
    const flags = [];
    const pushFlag = function (text) {
      if (flags.indexOf(text) < 0) flags.push(text);
    };
    const hasIdentityReq = IDENTITY_KEYS.some(function (key) {
      return rec.range[key] === true;
    });
    // 只限户籍、不限身份的岗位，勾任何身份都不该被排除：退役军人、残疾人
    // 同样可能有本地户籍。这里只提示，让人自己核对。
    if (!hasIdentityReq && !rec.range.fresh2026) {
      return {
        ok: true,
        flags: ['招聘范围限户籍，本工具不判断户籍，请自行核对'],
      };
    }
    const veteran = has('veteran') || has('veteranStudent');

    const programOk = function (kind, name, program) {
      const a = serviceAreaOk(kind, name, rec, p);
      if (a.ok && a.unknown) {
        pushFlag('未填基层服务地，未判断是否已在「' + areaLabel(name, rec) +
          '」完成' + program + '服务');
      }
      return a.ok;
    };

    let ok = false;
    if (rec.range.teacherPublic && has('teacherPublic')) ok = true;
    if (!ok && rec.range.teacherPlan && has('teacherPlan')) ok = true;
    if (!ok && rec.range.medical && has('medical')) ok = true;
    if (!ok && rec.range.disabled && has('disabled')) ok = true;
    if (!ok && rec.range.ruralDoctor && has('ruralDoctor')) ok = true;
    if (!ok && rec.range.partySecretary && has('partySecretary')) ok = true;
    if (!ok && rec.range.veteran && veteran) {
      ok = true;
      pushFlag('退役军人的入伍地 / 户籍 / 安置地要求见「招聘范围」原文，需自行核对');
    }
    if (!ok && rec.range.veteranStudent && has('veteranStudent')) {
      ok = true;
      pushFlag('退役大学生士兵的入伍地 / 户籍 / 安置地要求见「招聘范围」原文，需自行核对');
    }
    if (!ok && rec.range.sanZhi && has('sanZhi')) {
      ok = programOk(rec.range.sanZhiKind, rec.range.sanZhiArea, '“三支一扶”');
    }
    if (!ok && rec.range.xiBu && has('xiBu')) {
      ok = programOk(rec.range.xiBuKind, rec.range.xiBuArea, '“西部计划”');
    }
    if (!ok && rec.range.fresh2026 &&
        (has('sanZhi') || has('xiBu') || has('veteran') ||
         has('veteranStudent'))) {
      ok = true;
      pushFlag('该岗位面向 2026 届应届毕业生（含服务期满 2 年内的基层项目人员、' +
        '退役后 1 年内的应征入伍人员），请核对毕业年份和项目期满时间');
    }
    if (ok && (rec.range.hukouProvince || rec.range.hukouCity ||
               rec.range.hukouCounty)) {
      pushFlag('招聘范围还有户籍要求，本工具不判断户籍，请自行核对');
    }
    return { ok: ok, flags: flags };
  }

  /** 判定一行。返回 {ok, why?, tier?, reasons?, flags?} */
  function matchRow(rec, p) {
    if (!educationOk(rec, p.level)) return { ok: false, why: '学历不符' };
    if (!degreeOk(rec, p.degree)) return { ok: false, why: '学位不符' };
    if (!certOk(rec, p.cert)) {
      return { ok: false, why: rec['教资要求'] === '不限'
        ? '教师资格证不符' : '要求' + rec['教资要求'] + '教师资格证' };
    }

    const range = matchRange(rec, p);
    if (!range.ok) return { ok: false, why: '不在招聘范围内' };

    const flags = range.flags.slice();
    if (p.cert && rec['教资要求'] !== '不限') {
      flags.push('教师资格证的学科须与报考岗位一致，请自行核对');
    }

    if (p.majorActive) {
      const major = matchMajor(rec, p);
      if (!major.tier) {
        return { ok: false, why: '专业未命中', flags: major.flags };
      }
      return {
        ok: true, tier: major.tier, reasons: major.reasons,
        flags: flags.concat(major.flags || []),
      };
    }
    return { ok: true, flags: flags };
  }

  /* =====================================================================
   * 五、画像与筛选
   * ===================================================================*/

  function buildProfile(raw) {
    const p = Object.assign({}, DEFAULT_PROFILE, raw || {});
    p.city = p.city || '';
    p.countySet = new Set(p.counties || []);
    p.jobCatSet = new Set(p.jobCats || []);
    p.examSet = new Set(p.exams || []);
    p.rangeSet = new Set(p.ranges || []);
    p.eduReqSet = new Set(p.eduReqs || []);
    p.degreeReqSet = new Set(p.degreeReqs || []);
    p.certReqSet = new Set(p.certReqs || []);
    p.serviceSet = new Set(p.services || []);
    p.areaTagSet = new Set(p.areaTags || []);
    p.identitySet = new Set(p.identities || []);

    p.majorLevel = p.level === '大专' ? '大专'
      : (p.level === '硕士' || p.level === '博士') ? '研究生'
      : '本科';
    p.majorLevelAssumed = !p.level;

    const names = GK.normalize(flat(p.majorText))
      .split(/[,;:/]/).filter(Boolean);
    p.names = names.filter(function (n) { return !/^[0-9]+$/.test(n); });

    const codeText = GK.normalize(flat((p.majorCodes || '') + ' ' +
      (p.majorText || '')));
    const codes6 = [];
    const codes4 = [];
    const codes4Explicit = [];
    const codes2 = [];
    for (const m of codeText.match(/[0-9]{6}[A-Za-z]?/g) || []) {
      const code = m.toUpperCase();
      codes6.push(code);
      codes4.push(code.slice(0, 4));
      codes2.push(code.slice(0, 2));
    }
    for (const m of codeText.match(/(?<![0-9])[0-9]{4}(?![0-9])/g) || []) {
      codes4.push(m);
      codes4Explicit.push(m);
      codes2.push(m.slice(0, 2));
    }
    for (const m of codeText.match(/(?<![0-9])[0-9]{2}(?![0-9])/g) || []) {
      if (/^(0[1-9]|1[0-4])$/.test(m)) codes2.push(m);
    }
    p.codes6 = Array.from(new Set(codes6));
    p.codes4 = Array.from(new Set(codes4));
    p.codes4Explicit = Array.from(new Set(codes4Explicit));
    p.codes2 = Array.from(new Set(codes2));
    p.classes = (p.classes || []).slice();
    p.majorActive = !!(p.names.length || p.codes6.length || p.classes.length);
    p.rangeActive = p.identitySet.size > 0;
    p.countyCity = p.countyCity || {};
    return p;
  }

  /** 除浏览筛选外，是否填了任何「我的条件」 */
  function personalActive(p) {
    return !!(p.level || p.degree || p.cert || p.rangeActive ||
              p.majorActive);
  }

  const byRegion = function (a, b) {
    return a['县市区'].localeCompare(b['县市区'], 'zh') ||
      a['招聘单位'].localeCompare(b['招聘单位'], 'zh');
  };

  // 缴费人数是字符串列；统计表里没有的岗位（教育类）当无穷大
  function paidCount(r) {
    const v = r['缴费人数'];
    if (v === '' || v == null) return Infinity;
    const n = Number(v);
    return isNaN(n) ? Infinity : n;
  }

  // 两个方向都把「未统计」放最后：不能只靠 Infinity 相减，反向排序时它会被翻到最前
  function paidOrder(a, b, desc) {
    const av = paidCount(a);
    const bv = paidCount(b);
    const am = av === Infinity ? 1 : 0;
    const bm = bv === Infinity ? 1 : 0;
    if (am || bm) return am - bm;
    return desc ? bv - av : av - bv;
  }

  const SORTERS = {
    region: byRegion,
    dept: function (a, b) { return a['招聘单位'].localeCompare(b['招聘单位'], 'zh'); },
    headcount: function (a, b) { return b.headcount - a.headcount; },
    // 同一人数再按县市区排，免得几十个 0 人乱序
    paid: function (a, b) { return paidOrder(a, b, false) || byRegion(a, b); },
    paidDesc: function (a, b) { return paidOrder(a, b, true) || byRegion(a, b); },
    code: function (a, b) { return String(a['岗位编码']).localeCompare(String(b['岗位编码'])); },
    tier: function (a, b) { return tierRank(a.tier) - tierRank(b.tier); },
  };

  function tierRank(tier) {
    return tier === 'exact' ? 0 : tier === 'class' ? 1 : 2;
  }

  function filterRecords(records, rawProfile, opts) {
    opts = opts || {};
    const p = buildProfile(rawProfile);
    // 基层服务地只用在招聘范围判断上，县 -> 市州的对照表从当前数据现建
    if (!Object.keys(p.countyCity).length) {
      for (const rec of records) {
        if (rec['县市区']) p.countyCity[rec['县市区']] = rec['市州'];
      }
    }
    const search = GK.normalize(flat(opts.search || ''));
    const scope = opts.scope || '';
    const browseOnly = !personalActive(p);
    const groups = { all: [], exact: [], class: [], category: [], eligible: [] };
    const excluded = {};
    let totalHeadcount = 0;

    for (const rec of records) {
      if (scope && rec['市州'] !== scope) continue;
      // 市州是县市区的上一级：先按市收窄，再在剩下的县里勾选。
      // 它和 scope 一样只决定检索范围，不算「被筛掉」，不进 excluded 统计。
      if (p.city && rec['市州'] !== p.city) continue;

      // ---- 浏览筛选：职位本身的要求 ----
      let why = null;
      if (p.countySet.size && !p.countySet.has(rec['县市区'])) why = '县市区不符';
      else if (p.jobCatSet.size && !p.jobCatSet.has(rec['岗位类别'])) why = '岗位类别不符';
      else if (p.examSet.size && !p.examSet.has(rec['考试科目'])) why = '考试科目不符';
      else if (p.eduReqSet.size && !p.eduReqSet.has(rec['学历要求'])) why = '学历要求不符';
      else if (p.degreeReqSet.size && !p.degreeReqSet.has(rec['学位要求'])) why = '学位要求不符';
      else if (p.certReqSet.size && !p.certReqSet.has(rec['教资要求'])) why = '教师资格证要求不符';
      else if (p.serviceSet.size && !p.serviceSet.has(rec['服务期年数'])) why = '最低服务期不符';
      else if (p.minHeadcount && rec.headcount < p.minHeadcount) why = '招聘名额不足';
      else if (p.areaTagSet.size) {
        let hit = false;
        for (const key of p.areaTagSet) {
          if (rec.tags.indexOf(key) >= 0) { hit = true; break; }
        }
        if (!hit) why = '基层服务地不符';
      }
      else if (p.rangeSet.size) {
        let hit = false;
        for (const key of p.rangeSet) {
          if (rangeHit(rec, key)) { hit = true; break; }
        }
        if (!hit) why = '招聘对象不符';
      }
      if (why) { excluded[why] = (excluded[why] || 0) + 1; continue; }

      // ---- 我的条件 ----
      const r = matchRow(rec, p);
      if (!r.ok) {
        excluded[r.why] = (excluded[r.why] || 0) + 1;
        continue;
      }
      if (search && (!rec._searchText || rec._searchText.indexOf(search) < 0)) continue;

      rec.reasons = r.reasons || [];
      // 不能写回 rec.flags —— 那是结构化事实，这里存匹配过程产生的提示
      rec.matchFlags = r.flags || [];
      if (p.majorActive) {
        rec.tier = r.tier;
        groups[r.tier].push(rec);
      } else if (browseOnly) {
        rec.tier = 'all';
        groups.all.push(rec);
      } else {
        rec.tier = 'eligible';
        groups.eligible.push(rec);
      }
      totalHeadcount += rec.headcount;
    }

    const order = SORTERS[opts.sort] || SORTERS.tier;
    for (const key of Object.keys(groups)) groups[key].sort(order);

    const mode = p.majorActive ? 'match' : (browseOnly ? 'browse' : 'eligible');
    const all = groups.exact.concat(groups.class, groups.category,
      groups.eligible, groups.all);
    const byTier = function (key) {
      const list = groups[key] || [];
      return { count: list.length, headcount: sumHead(list) };
    };

    return {
      mode: mode,
      groups: groups,
      all: all,
      stats: {
        total: all.length,
        headcount: totalHeadcount,
        byTier: {
          exact: byTier('exact'), class: byTier('class'),
          category: byTier('category'), eligible: byTier('eligible'),
          all: byTier('all'),
        },
        counties: GK.topCounts(all, function (r) { return r['县市区']; }),
        jobCats: GK.topCounts(all, function (r) { return r['岗位类别']; }),
        exams: GK.topCounts(all, function (r) { return r['考试科目']; }),
        tags: GK.topCounts(
          all.reduce(function (acc, r) { return acc.concat(r.tags); }, []),
          function (t) { return tagLabel(t); }
        ),
        excluded: excluded,
      },
    };
  }

  function sumHead(list) {
    let n = 0;
    for (const r of list) n += r.headcount;
    return n;
  }

  /* =====================================================================
   * 六、专业类目推荐
   * ===================================================================*/

  function suggestClasses(input, dicts) {
    const found = new Map();
    const text = GK.normalize(flat(input));
    if (!text) return [];

    const add = function (cands, lei, from, rank) {
      const cur = cands.get(lei);
      if (!cur || rank < cur.rank) cands.set(lei, { lei: lei, from: from, rank: rank });
    };

    for (const token of text.split(/[,;:/]/).filter(Boolean)) {
      const cands = new Map();
      const bare = token.replace(/[0-9]{2,6}[A-Za-z]?/g, '');

      for (const code of token.match(/[0-9]{6}[A-Za-z]?/g) || []) {
        for (const lei of dicts.codeToLei[code.slice(0, 4)] || []) add(cands, lei, code, 0);
      }
      for (const code of token.match(/(?<![0-9])[0-9]{4}(?![0-9])/g) || []) {
        for (const lei of dicts.codeToLei[code] || []) add(cands, lei, code, 0);
      }
      if (bare) {
        for (const [code, name] of dicts.majorDict) {
          if (name === bare) {
            for (const lei of dicts.codeToLei[code.slice(0, 4)] || []) {
              add(cands, lei, name, 1);
            }
          } else if (name.length >= 4 && bare.indexOf(name) === 0) {
            for (const lei of dicts.codeToLei[code.slice(0, 4)] || []) {
              add(cands, lei, name, 2);
            }
          }
        }
        for (const lei of (dicts.nameToLei || {})[bare] || []) add(cands, lei, bare, 2);
        for (const lei of (dicts.majorClass || {})[bare] || []) add(cands, lei, bare, 2);
        const prefixed = [];
        for (const [lei] of dicts.leiVocab) {
          const stem = lei.slice(0, -1);
          if (stem.length >= 2 && bare.indexOf(stem) === 0) {
            prefixed.push({ lei: lei, stem: stem });
          }
        }
        for (const c of prefixed) {
          const longer = prefixed.some(function (o) {
            return o.stem.length > c.stem.length && o.stem.indexOf(c.stem) === 0;
          });
          if (!longer) add(cands, c.lei, bare, 3);
        }
      }

      if (!cands.size) continue;
      let best = Infinity;
      cands.forEach(function (c) { if (c.rank < best) best = c.rank; });
      cands.forEach(function (c) { if (c.rank === best) found.set(c.lei, c); });
    }
    return Array.from(found.values());
  }

  /* =====================================================================
   * 七、数据展开
   * ===================================================================*/

  function unpack(data) {
    const columns = {};
    data.H.forEach(function (name, i) {
      const col = data.D[i];
      columns[name] = col.d ? col.i.map(function (k) { return col.d[k]; }) : col.v;
    });

    const n = data.meta.total;
    const records = new Array(n);
    for (let i = 0; i < n; i++) {
      const rec = { id: i };
      for (const name of data.H) rec[name] = columns[name][i];
      rec.headcount = parseInt(rec['招聘名额'], 10) || 0;
      records[i] = rec;
    }

    const countyCity = {};
    for (const rec of records) {
      if (rec['县市区']) countyCity[rec['县市区']] = rec['市州'];
    }

    for (const rec of records) {
      rec.major = analyzeMajorSY(rec['专业']);
      rec.majorUnlimited = unlimitedLevels(rec.major);
      rec.range = analyzeRange(rec['招聘范围']);
      rec.range.sanZhiKind = areaKind(rec.range.sanZhiArea, countyCity);
      rec.range.xiBuKind = areaKind(rec.range.xiBuArea, countyCity);
      rec.tags = tagsOf(rec);
      rec._searchText = GK.normalize(flat([
        rec['岗位编码'], rec['市州'], rec['县市区'], rec['招聘单位'],
        rec['岗位名称'], rec['岗位类别及等级'], rec['招聘范围'],
        rec['专业'], rec['学历学位'], rec['职称资格'], rec['公共科目'],
        rec['备注'], rec['咨询电话'],
      ].join('\u0001')));
    }
    return records;
  }

  /* =====================================================================
   * 八、导出与文案
   * ===================================================================*/

  const CSV_COLUMNS = [
    '岗位编码', '市州', '县市区', '招聘单位', '岗位名称', '岗位类别及等级',
    '招聘名额', '缴费人数', '招聘范围', '学历学位', '专业', '职称资格',
    '公共科目', '最低服务期', '年龄', '咨询电话', '备注', '匹配档位', '匹配依据',
  ];

  function toCSV(records) {
    const escape = function (v) {
      const s = String(v == null ? '' : v);
      return /[",\n\r]/.test(s) ? '"' + s.split('"').join('""') + '"' : s;
    };
    const lines = [CSV_COLUMNS.join(',')];
    for (const rec of records) {
      const row = CSV_COLUMNS.map(function (col) {
        if (col === '匹配档位') return TIERS[rec.tier] ? TIERS[rec.tier].label : '';
        if (col === '匹配依据') return (rec.reasons || []).join('；');
        return rec[col];
      });
      lines.push(row.map(escape).join(','));
    }
    return '﻿' + lines.join('\r\n');
  }

  function tagLabel(key) {
    return (TAG_BY_KEY[key] || { label: key }).label;
  }

  function tagDesc(key) {
    return (TAG_BY_KEY[key] || { desc: '' }).desc;
  }

  /* =====================================================================
   * 导出接口
   * ===================================================================*/

  const api = {
    unpack: unpack,
    analyzeMajor: analyzeMajorSY,
    analyzeRange: analyzeRange,
    tagsOf: tagsOf,
    buildProfile: buildProfile,
    personalActive: personalActive,
    matchRow: matchRow,
    matchMajor: matchMajor,
    matchRange: matchRange,
    educationOk: educationOk,
    degreeOk: degreeOk,
    certOk: certOk,
    rangeHit: rangeHit,
    filterRecords: filterRecords,
    suggestClasses: suggestClasses,
    toCSV: toCSV,
    tagLabel: tagLabel,
    tagDesc: tagDesc,
    TIERS: TIERS,
    TAG_DEFS: TAG_DEFS,
    IDENTITY_DEFS: IDENTITY_DEFS,
    IDENTITY_KEYS: IDENTITY_KEYS,
    CSV_COLUMNS: CSV_COLUMNS,
    DEFAULT_PROFILE: DEFAULT_PROFILE,
    PLACE_OTHER: PLACE_OTHER,
    PLACE_OUTSIDE: PLACE_OUTSIDE,
  };

  global.SYMatch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
