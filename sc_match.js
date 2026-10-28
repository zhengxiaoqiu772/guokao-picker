/**
 * sc_match.js —— 四川省考职位匹配与浏览引擎
 *
 * 纯函数，不碰 DOM。和国考的 match.js 分开写，因为两份表的字段不一样：
 * 四川省考没有「基层工作最低年限」，应往届写在「考录对象」里，性别、证书
 * 写在「其他要求」里，专业栏又常写成「本科：…／研究生：…」两层。
 *
 * 复用 match.js 的只有文本归一化和专业栏分词（GKMatch.analyzeMajor）——
 * 那是两份表里唯一形状相同的东西。判定规则全部在这里重写。
 *
 * 设计原则和国考一致：不填的条件一律不排除。省考职位只有 4,001 个，
 * 浏览全部职位是正常用法，不像国考那样「不填专业必然是 0」。
 */
(function (global) {
  'use strict';

  const GK = global.GKMatch;

  /* =====================================================================
   * 一、常量与标签
   * ===================================================================*/

  const LEVEL_RANK = { '大专': 0, '本科': 1, '硕士': 2, '博士': 3 };
  const DEGREE_RANK = { '无': 0, '学士': 1, '硕士': 2, '博士': 3 };

  // 「其他要求」里的硬条件：先结构化，再从结构化结果生成标签。
  // 正则只认明确写法，不猜言外之意。
  const TAG_DEFS = [
    { key: 'male', label: '限男性', tone: 'hard',
      desc: '「其他要求」写明限男性' },
    { key: 'female', label: '限女性', tone: 'hard',
      desc: '「其他要求」写明限女性' },
    { key: 'softmale', label: '较适合男性', tone: 'warn',
      desc: '备注写「较适合男性」，是提示不是硬性限制' },
    { key: 'softfemale', label: '较适合女性', tone: 'warn',
      desc: '备注写「较适合女性」，是提示不是硬性限制' },
    { key: 'legalA', label: '法律职业资格A类', tone: 'hard',
      desc: '要求取得 A 类《法律职业资格证书》' },
    { key: 'legal', label: '法律职业资格', tone: 'hard',
      desc: '要求取得《法律职业资格证书》，未限定 A 类' },
    { key: 'accounting', label: '会计/审计资格', tone: 'warn',
      desc: '要求会计、审计专业技术资格或注册会计师' },
    { key: 'computer', label: '计算机资格', tone: 'warn',
      desc: '要求计算机技术与软件资格或计算机等级考试证书' },
    { key: 'disability', label: '残疾人专项', tone: 'hard',
      desc: '要求持有效《中华人民共和国残疾人证》，通常是定向岗位' },
    { key: 'vision', label: '特殊视力标准', tone: 'warn',
      desc: '执行公务员录用体检特殊标准中的矫正视力标准' },
    { key: 'specialPolice', label: '加试特警技能', tone: 'warn',
      desc: '需加试特警专业技能测试' },
    { key: 'cet6', label: '要求英语六级', tone: 'hard',
      desc: '要求大学英语六级、专业英语四级或英语专业八级' },
    { key: 'cet4', label: '要求英语四级', tone: 'hard',
      desc: '要求大学英语四级' },
    { key: 'hukou', label: '户籍/生源', tone: 'warn',
      desc: '「其他要求」或备注含户籍、生源地限制' },
    { key: 'service5', label: '最低服务期', tone: 'warn',
      desc: '注明最低服务期或最低服务年限' },
    { key: 'bachelor', label: '本科阶段专业要求', tone: 'warn',
      desc: '对本科阶段所学专业或学历学位另有要求' },
    { key: 'referenced', label: '参照管理', tone: 'info',
      desc: '参照公务员法管理单位' },
    { key: 'freshOnly', label: '限应届（含择业期）', tone: 'hard',
      desc: '考录对象只写应届高校毕业生，社会人员不能报' },
    { key: 'ground2', label: '需2年基层经历', tone: 'hard',
      desc: '考录对象为两年以上基层工作经历人员' },
    { key: 'policeSchool', label: '公安院校应届除外', tone: 'warn',
      desc: '应届高校毕业生中排除公安院校公安专业应届毕业生' },
    { key: 'physical', label: '体能测评', tone: 'warn',
      desc: '需开展体能测评' },
    { key: 'psych', label: '心理测试', tone: 'warn',
      desc: '笔试加试心理素质测试' },
    { key: 'specialSubject', label: '专业科目加试', tone: 'warn',
      desc: '笔试加试专业科目' },
    { key: 'minorityLang', label: '少数民族语言加试', tone: 'warn',
      desc: '笔试加试少数民族语言' },
    { key: 'autonomous', label: '民族自治州/县驻地', tone: 'warn',
      desc: '单位驻地在少数民族自治州、自治县' },
  ];

  const TAG_BY_KEY = {};
  for (const def of TAG_DEFS) TAG_BY_KEY[def.key] = def;

  // 卡片上的标签顺序：硬条件在前，环境提示在后
  const TAG_ORDER = [
    'male', 'female', 'legalA', 'legal', 'disability', 'cet6', 'cet4',
    'freshOnly', 'ground2', 'accounting', 'computer', 'vision', 'specialPolice',
    'policeSchool', 'hukou', 'service5', 'bachelor',
    'physical', 'psych', 'specialSubject', 'minorityLang', 'autonomous',
    'softmale', 'softfemale', 'referenced',
  ];

  const TARGET_LABELS = {
    '应届高校毕业生': '仅限应届',
    '应届高校毕业生和符合条件的社会在职、非在职人员': '应届＋社会人员',
    '应届高校毕业生（不含公安院校公安专业应届毕业生）': '仅限应届（公安院校应届除外）',
    '应届高校毕业生（不含公安院校公安专业应届毕业生）和符合条件的社会在职、非在职人员':
      '应届＋社会（公安院校应届除外）',
    '两年以上基层工作经历的人员': '两年以上基层经历',
  };

  const FLAG_FIELDS = {
    physical: '体能测评',
    specialSubject: '加试专业',
    minorityLang: '加试民族语言',
    psych: '加试心理测试',
    autonomous: '民族自治州驻地',
  };

  const TIERS = {
    exact: { key: 'exact', label: '精准命中', stamp: '精准',
             desc: '专业名称、专业代码或所属一级学科直接命中' },
    class: { key: 'class', label: '专业类命中', stamp: '类合',
             desc: '命中你勾选的专业类目' },
    category: { key: 'category', label: '门类命中 · 专业不限', stamp: '门类',
                desc: '门类级命中或该职位专业不限，建议人工确认' },
    eligible: { key: 'eligible', label: '符合硬性条件', stamp: '条件',
                desc: '学历、学位、政治面貌等已判断；专业未填，未判断' },
    all: { key: 'all', label: '全部职位', stamp: '浏览',
           desc: '未填个人条件，按职位要求浏览' },
  };

  /** 户籍地选「四川省外」时存这个值；其余情况存市州名（或空 = 不判断） */
  const HUKOU_OUTSIDE = 'outside';

  const DEFAULT_PROFILE = {
    // 我的条件：全部默认留空 = 不排除
    level: '', degree: '', politics: '', gender: '', gradStatus: '',
    hukou: '', legalCert: '', accountingCert: '', computerCert: '',
    disabilityCert: '', english: '',
    majorText: '', majorCodes: '', classes: [],

    // 浏览筛选：职位要求
    cities: [], systems: [], exams: [], scopes: [], targets: [],
    eduReqs: [], degreeReqs: [], politicsReqs: [],
    minHeadcount: 0, flags: [], tags: [],
  };

  /* =====================================================================
   * 二、文本与记录
   * ===================================================================*/

  function flat(text) {
    return String(text == null ? '' : text).replace(/\r?\n/g, '');
  }

  function addTag(list, key) {
    if (list.indexOf(key) < 0) list.push(key);
  }

  /** 从「其他要求」「备注」「考录对象」和几个结构化列里读出全部标签 */
  function analyzeFlags(rec) {
    const text = (rec['其他要求'] || '') + '||' + (rec['备注'] || '');
    const target = rec['考录对象'] || '';
    const cet6 = /英语六级|大学英语(?:六级|6级)|专业英语四级|英语专业[四八]级|CET-?6/i.test(text);
    const cet4 = !cet6 && /英语四级|大学英语(?:四级|4级)|CET-?4/i.test(text);
    return {
      male: /限男性/.test(text),
      female: /限女性/.test(text),
      softmale: /较适合男性/.test(text),
      softfemale: /较适合女性/.test(text),
      // 「取得A类《法律职业资格证书》」和「A类法律职业资格证书」两种写法
      legalA: /A类[^；;，,。]{0,10}法律职业资格|法律职业资格[^；;，,。]{0,6}A类/.test(text),
      legal: /法律职业资格/.test(text),
      accounting: /会计（审计）|会计\(审计\)|会计专业技术资格|注册会计师/.test(text),
      computer: /计算机技术与软件专业技术资格|计算机等级考试/.test(text),
      disability: /残疾人证|残疾类型/.test(text),
      vision: /矫正视力/.test(text),
      specialPolice: /特警专业技能/.test(text),
      cet4: cet4,
      cet6: cet6,
      hukou: /户籍|生源/.test(text),
      service5: /最低服务期|最低服务年限/.test(text),
      bachelor: /本科阶段|本科为普通高等学校/.test(text),
      referenced: /参照管理/.test(rec['备注'] || ''),
      // 考录对象是结构化字段，比从「其他要求」里猜可靠
      freshOnly: /应届/.test(target) && !/社会在职|社会人员/.test(target),
      ground2: /基层工作经历/.test(target),
      policeSchool: /公安院校/.test(target),
      physical: rec['体能测评'] === '是',
      psych: rec['加试心理测试'] === '是',
      specialSubject: rec['加试专业'] === '是',
      // 结构化列有漏写：6 行的「加试民族语言」写「否」，但「其他要求」明确
      // 写着「加试苗语/彝语口语测试」。两处任一成立即可。
      minorityLang: rec['加试民族语言'] === '是' ||
        /加试[^；;。]{0,10}(?:苗语|彝语|藏语|羌语|民族语言|口语测试)/.test(rec['其他要求'] || ''),
      autonomous: rec['民族自治州驻地'] === '是',
    };
  }

  function tagsOf(flags) {
    const tags = [];
    for (const key of TAG_ORDER) {
      // A 类证书一定也是「法律职业资格」，两条都挂会显得像两个不同的门槛
      if (key === 'legal' && flags.legalA) continue;
      if (flags[key]) addTag(tags, key);
    }
    return tags;
  }

  /** 某个学历层次的分段是不是只写了「不限」（如「研究生：不限」） */
  function isUnlimitedBucket(b) {
    return !!(b && b.names.length === 1 && b.names[0] === '不限' &&
              !b.lei.length && !b.c6.length && !b.c4.length && !b.c2.length);
  }

  function unlimitedLevels(major) {
    const out = {};
    for (const level of Object.keys(major.byLevel)) {
      if (isUnlimitedBucket(major.byLevel[level])) out[level] = true;
    }
    return out;
  }

  /* =====================================================================
   * 三、专业匹配
   * ===================================================================*/

  /**
   * 专业名的等效写法：「会计学」与「会计」、「会计（学）」在表里是同一种东西。
   * 只改一个「学」字，长度不足 2 的不动（否则「法学」会变成「法」）。
   */
  function altName(name) {
    if (name.length < 3) return null;
    const alt = name.charAt(name.length - 1) === '学'
      ? name.slice(0, -1)
      : name + '学';
    return alt.length >= 2 ? alt : null;
  }

  /**
   * 判定一个职位的专业档位。
   * @returns {{tier:string|null, reasons:string[], flags:string[]}}
   */
  function matchMajor(rec, profile) {
    const a = rec.major;
    const reasons = [];
    const flags = [];

    if (a.unlimited) return { tier: 'category', reasons: ['专业不限'], flags: [] };
    // 「本科：法学类 研究生：不限」——研究生阶段不设专业限制
    if (rec.majorUnlimited[profile.majorLevel]) {
      const label = profile.majorLevel === '研究生' ? '研究生阶段' : profile.majorLevel + '阶段';
      return { tier: 'category', reasons: ['专业不限（' + label + '）'], flags: [] };
    }

    const buckets = [a.byLevel.any];
    if (a.byLevel[profile.majorLevel]) buckets.push(a.byLevel[profile.majorLevel]);
    const has = (key, value) => {
      for (const b of buckets) if (b[key].indexOf(value) >= 0) return true;
      return false;
    };
    const isNeg = (token) => a.neg.indexOf(token) >= 0;

    // ---- 一档：专业名 / 代码 / 所属一级学科 ----
    const nameHits = [];
    const codeHits = [];
    const looseHits = [];
    for (const name of profile.names) {
      if (has('names', name)) { nameHits.push(name); continue; }
      const alt = altName(name);
      if (alt && has('names', alt)) {
        nameHits.push(alt);
        looseHits.push({ from: name, to: alt });
      }
    }
    for (const code of profile.codes6) if (has('c6', code)) codeHits.push(code);
    // 用户填 6 位代码、表里只列 4 位一级学科：030101K 属于 0301
    for (const code of profile.codes6) {
      const prefix = code.slice(0, 4);
      if (has('c4', prefix)) codeHits.push(prefix);
    }
    // 用户填 4 位代码、表里列的是具体专业：0301 覆盖 030101K
    for (const b of buckets) {
      for (const code of b.c6) {
        if (profile.codes4.indexOf(code.slice(0, 4)) >= 0) codeHits.push(code);
      }
      for (const code of b.c4) {
        if (profile.codes4.indexOf(code) >= 0) codeHits.push(code);
      }
    }

    const blocked = nameHits.concat(codeHits).filter(isNeg);
    const liveNames = nameHits.filter((t) => !isNeg(t));
    const liveCodes = codeHits.filter((t) => !isNeg(t));
    if (liveNames.length || liveCodes.length) {
      if (liveNames.length) {
        const label = profile.majorLevel === '大专' ? '专业名称' : profile.majorLevel + '阶段专业名称';
        reasons.push('命中' + label + '：' + liveNames.slice(0, 4).join(' / '));
      }
      if (liveCodes.length) {
        reasons.push('命中专业代码：' + Array.from(new Set(liveCodes)).slice(0, 4).join(' / '));
      }
      if (looseHits.length) {
        reasons.push('该行写作「' + looseHits.map((h) => h.to).join('、') +
                     '」，与你填的「' + looseHits.map((h) => h.from).join('、') +
                     '」按同一专业处理');
      }
      if (a.special) flags.push('专业栏含「除…外」等特殊限定，需人工确认');
      return { tier: 'exact', reasons: reasons, flags: flags };
    }

    // ---- 二档：勾选的专业类目 ----
    const classHits = [];
    const catHits = [];
    for (const cls of profile.classes) {
      if (!has('lei', cls) || isNeg(cls)) continue;
      if (/(门类|大类|学科门类)$/.test(cls)) catHits.push(cls);
      else classHits.push(cls);
    }
    if (classHits.length) {
      reasons.push('命中专业类目：' + classHits.slice(0, 4).join(' / '));
      if (a.special) flags.push('专业栏含「除…外」等特殊限定，需人工确认');
      return { tier: 'class', reasons: reasons, flags: flags };
    }

    // ---- 三档：门类 / 专业不限 ----
    for (const code of profile.codes2) {
      for (const b of buckets) {
        if (b.c2.indexOf(code) >= 0) catHits.push(code);
        for (const c of b.c6.concat(b.c4)) if (c.slice(0, 2) === code) catHits.push(code);
      }
    }
    if (catHits.length) {
      reasons.push('命中门类代码：' + Array.from(new Set(catHits)).join(' / '));
      flags.push('门类级匹配范围较宽，需人工确认');
      return { tier: 'category', reasons: reasons, flags: flags };
    }

    if (blocked.length) {
      return { tier: null, reasons: [],
               flags: ['命中的「' + blocked[0] + '」被该职位的排除条件排除'], blocked: true };
    }
    if (a.special) {
      return { tier: null, reasons: [], flags: ['专业栏含特殊限定，本工具不做判定'], blocked: true };
    }
    return { tier: null, reasons: [], flags: flags };
  }

  /* =====================================================================
   * 四、硬性条件
   * ===================================================================*/

  function educationOk(rowEdu, userLevel) {
    if (!userLevel) return true;
    const rank = LEVEL_RANK[userLevel];
    if (rowEdu === '专科及以上') return rank >= 0;
    if (rowEdu === '本科及以上') return rank >= 1;
    if (rowEdu === '研究生') return rank >= 2;
    return true;                                  // 未知取值不拦
  }

  function degreeOk(rowDegree, userDegree) {
    if (!userDegree) return true;
    const need = { '不限': 0, '学士及以上': 1, '硕士及以上': 2, '博士': 3 }[rowDegree];
    if (need === undefined) return true;
    return DEGREE_RANK[userDegree] >= need;
  }

  function politicsOk(rowPolitics, userPolitics) {
    if (!userPolitics) return true;
    if (rowPolitics === '不限') return true;
    if (rowPolitics === '中共党员') {
      return userPolitics === '中共党员' || userPolitics === '中共预备党员';
    }
    return true;
  }

  /**
   * 省考的「考录对象」只写「应届高校毕业生」，从不写届别，所以三届在规则上完全等价，
   * 界面只留「应届」一档。国考那种「限 2027 届 vs 限应届」的分法在这里没有对应字段。
   * 2025 / 2026 / 2027 仍认，是为了读旧版 localStorage 里存下的值。
   */
  /**
   * 「考录范围」只有三种值：全国 / 本省 / 本市州（3,585 / 322 / 94）。
   * 后两种是户籍限制，公告口径写的是「本省户籍或生源」，这里只按户籍判断；
   * 生源不在工具里建模，户籍不在四川而生源在四川的，卡片上无从体现，得自己核对。
   * 户籍地留空 = 不判断，和别的项一致。
   */
  function scopeOk(rec, hukou) {
    if (!hukou) return true;
    const scope = rec['考录范围'] || '全国';
    if (scope === '本省') return hukou !== HUKOU_OUTSIDE;
    if (scope === '本市州') return hukou === rec['市州'];
    return true;
  }

  function isFreshStatus(status) {
    return status === 'fresh' || status === '2027' || status === '2026' || status === '2025';
  }

  /** 判定一行。返回 {ok, why?, tier?, reasons?, flags?} */
  function matchRow(rec, profile) {
    if (!educationOk(rec['学历'], profile.level)) return { ok: false, why: '学历不符' };
    if (!degreeOk(rec['学位'], profile.degree)) return { ok: false, why: '学位不符' };
    if (!politicsOk(rec['政治面貌'], profile.politics)) {
      return { ok: false, why: '政治面貌不符' };
    }

    if (profile.gender === '男' && rec.flags.female) return { ok: false, why: '限女性' };
    if (profile.gender === '女' && rec.flags.male) return { ok: false, why: '限男性' };

    // 考录对象：应届 / 社会人员 / 两年基层经历
    if (profile.gradStatus) {
      if (rec.flags.ground2 && profile.gradStatus !== 'previous2') {
        return { ok: false, why: '需两年以上基层工作经历' };
      }
      if (rec.flags.freshOnly && !isFreshStatus(profile.gradStatus)) {
        return { ok: false, why: '限应届高校毕业生' };
      }
    }

    // 考录范围：本省 / 本市州
    if (!scopeOk(rec, profile.hukou)) {
      return { ok: false, why: rec['考录范围'] === '本市州' ? '限本市州户籍' : '限本省户籍' };
    }

    // 法律职业资格：留空 = 不判断；没有证书时，要求证书的职位直接排除
    if (profile.legalCert === 'none' && rec.flags.legal) {
      return { ok: false, why: '没有法律职业资格' };
    }
    if (profile.legalCert === 'other' && rec.flags.legalA) {
      return { ok: false, why: '没有A类法律职业资格' };
    }

    // 「其他要求」里的专项资格：留空 = 不判断；选「没有」时排除要求它的职位
    if (profile.accountingCert === 'none' && rec.flags.accounting) {
      return { ok: false, why: '没有会计/审计资格' };
    }
    if (profile.computerCert === 'none' && rec.flags.computer) {
      return { ok: false, why: '没有计算机资格' };
    }
    if (profile.disabilityCert === 'none' && rec.flags.disability) {
      return { ok: false, why: '不是残疾人专项对象' };
    }

    if (profile.english === '无' && (rec.flags.cet4 || rec.flags.cet6)) {
      return { ok: false, why: '要求英语等级' };
    }
    if (profile.english === '四级' && rec.flags.cet6) {
      return { ok: false, why: '要求英语六级' };
    }

    if (profile.majorActive) {
      const major = matchMajor(rec, profile);
      if (!major.tier) {
        return { ok: false, why: '专业未命中', flags: major.flags };
      }
      return { ok: true, tier: major.tier, reasons: major.reasons,
               flags: major.flags || [] };
    }
    return { ok: true, flags: [] };
  }

  /* =====================================================================
   * 五、画像与筛选
   * ===================================================================*/

  function buildProfile(raw) {
    const p = Object.assign({}, DEFAULT_PROFILE, raw || {});
    p.citySet = new Set(p.cities || []);
    p.systemSet = new Set(p.systems || []);
    p.examSet = new Set(p.exams || []);
    p.scopeSet = new Set(p.scopes || []);
    p.targetSet = new Set(p.targets || []);
    p.eduReqSet = new Set(p.eduReqs || []);
    p.degreeReqSet = new Set(p.degreeReqs || []);
    p.politicsReqSet = new Set(p.politicsReqs || []);
    p.flagSet = new Set(p.flags || []);
    p.tagSet = new Set(p.tags || []);

    // 专业按学历层次分段看。我的学历没填时按本科处理 —— 这是绝大多数人的情况，
    // 界面上会提示「未填学历时专业按本科阶段匹配」。
    p.majorLevel = p.level === '大专' ? '大专'
      : (p.level === '硕士' || p.level === '博士') ? '研究生'
      : '本科';
    p.majorLevelAssumed = !p.level;

    const names = GK.normalize(flat(p.majorText)).split(/[,;:/]/).filter(Boolean);
    p.names = names.filter((n) => !/^[0-9]+$/.test(n));

    const codeText = GK.normalize(flat((p.majorCodes || '') + ' ' + (p.majorText || '')));
    const codes6 = [];
    const codes4 = [];
    const codes2 = [];
    for (const m of codeText.match(/[0-9]{6}[A-Za-z]?/g) || []) {
      const code = m.toUpperCase();
      codes6.push(code);
      codes4.push(code.slice(0, 4));
      codes2.push(code.slice(0, 2));
    }
    for (const m of codeText.match(/(?<![0-9])[0-9]{4}(?![0-9])/g) || []) {
      codes4.push(m);
      codes2.push(m.slice(0, 2));
    }
    for (const m of codeText.match(/(?<![0-9])[0-9]{2}(?![0-9])/g) || []) {
      // 只认学科门类码 01–14，年份、比例之类的两位数不算
      if (/^(0[1-9]|1[0-4])$/.test(m)) codes2.push(m);
    }
    p.codes6 = Array.from(new Set(codes6));
    p.codes4 = Array.from(new Set(codes4));
    p.codes2 = Array.from(new Set(codes2));
    p.classes = (p.classes || []).slice();
    p.majorActive = !!(p.names.length || p.codes6.length || p.classes.length);
    return p;
  }

  /** 除浏览筛选外，是否填了任何「我的条件」 */
  function personalActive(p) {
    return !!(p.level || p.degree || p.politics || p.gender || p.gradStatus ||
              p.hukou || p.legalCert || p.english || p.majorActive ||
              p.accountingCert || p.computerCert || p.disabilityCert);
  }

  const SORTERS = {
    region: (a, b) => a['市州'].localeCompare(b['市州'], 'zh') ||
                      a['招录机关'].localeCompare(b['招录机关'], 'zh'),
    dept: (a, b) => a['招录机关'].localeCompare(b['招录机关'], 'zh'),
    headcount: (a, b) => b.headcount - a.headcount,
    code: (a, b) => String(a['职位编码']).localeCompare(String(b['职位编码'])),
    tier: (a, b) => tierRank(a.tier) - tierRank(b.tier),
  };

  function tierRank(tier) {
    return tier === 'exact' ? 0 : tier === 'class' ? 1 : 2;
  }

  function filterRecords(records, rawProfile, opts) {
    opts = opts || {};
    const p = buildProfile(rawProfile);
    const search = GK.normalize(flat(opts.search || ''));
    const browseOnly = !personalActive(p);
    const groups = { all: [], exact: [], class: [], category: [], eligible: [] };
    const excluded = {};
    let totalHeadcount = 0;

    for (const rec of records) {
      // ---- 浏览筛选：职位本身的要求 ----
      let why = null;
      if (p.citySet.size && !p.citySet.has(rec['市州'])) why = '市州不符';
      else if (p.systemSet.size && !p.systemSet.has(rec['系统类别'])) why = '系统类别不符';
      else if (p.examSet.size && !p.examSet.has(rec['考试类别'])) why = '考试类别不符';
      else if (p.scopeSet.size && !p.scopeSet.has(rec['考录范围'])) why = '考录范围不符';
      else if (p.targetSet.size && !p.targetSet.has(rec['考录对象'])) why = '考录对象不符';
      else if (p.eduReqSet.size && !p.eduReqSet.has(rec['学历'])) why = '学历要求不符';
      else if (p.degreeReqSet.size && !p.degreeReqSet.has(rec['学位'])) why = '学位要求不符';
      else if (p.politicsReqSet.size && !p.politicsReqSet.has(rec['政治面貌'])) why = '政治面貌要求不符';
      else if (p.minHeadcount && rec.headcount < p.minHeadcount) why = '招录名额不足';
      else if (p.flagSet.size) {
        // 用 unpack 时结构化出来的 flags，而不是再查一遍列：
        // 民族语言在列里漏写时，flags 已经从「其他要求」补上了
        for (const key of p.flagSet) {
          if (!rec.flags[key]) { why = '缺少指定附加项'; break; }
        }
      }
      if (!why && p.tagSet.size) {
        for (const key of p.tagSet) {
          if (rec.tags.indexOf(key) < 0) { why = '缺少指定标签'; break; }
        }
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
      // 不能写回 rec.flags —— 那是 unpack 出来的结构化事实（限男/限女/证书），
      // 这里的是匹配过程中产生的提示，两者重名会把事实覆盖掉
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
    const all = groups.exact.concat(groups.class, groups.category, groups.eligible, groups.all);
    const byTier = (key) => {
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
          exact: byTier('exact'), class: byTier('class'), category: byTier('category'),
          eligible: byTier('eligible'), all: byTier('all'),
        },
        regions: GK.topCounts(all, (r) => r['市州']),
        systems: GK.topCounts(all, (r) => r['系统类别']),
        exams: GK.topCounts(all, (r) => r['考试类别']),
        tags: GK.topCounts(
          all.reduce((acc, r) => acc.concat(r.tags), []),
          (t) => tagLabel(t)
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

  /**
   * 用户输入的专业名/代码 -> 可勾选的类目。
   * 这份表里 6 位代码只出现在法学那 357 行，所以代码不是主要线索，
   * 专业名与类目名的共同前缀（计算机科学与技术 -> 计算机类）反而更常用。
   */
  function suggestClasses(input, dicts) {
    const found = new Map();
    const text = GK.normalize(flat(input));
    if (!text) return [];

    const add = (cands, lei, from, rank) => {
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
            for (const lei of dicts.codeToLei[code.slice(0, 4)] || []) add(cands, lei, name, 1);
          } else if (name.length >= 4 && bare.indexOf(name) === 0) {
            for (const lei of dicts.codeToLei[code.slice(0, 4)] || []) add(cands, lei, name, 2);
          }
        }
        for (const lei of (dicts.nameToLei || {})[bare] || []) add(cands, lei, bare, 2);
        // 国考码表补充：这类专业名和类目名没有共同前缀（数据科学与大数据技术 / 计算机类），
        // 只能靠代码前缀对上号
        for (const lei of (dicts.majorClass || {})[bare] || []) add(cands, lei, bare, 2);
        // 最后兜底：专业名与「类目名去掉类字」共享前缀
        for (const [lei] of dicts.leiVocab) {
          const stem = lei.slice(0, -1);
          if (stem.length >= 2 && bare.indexOf(stem) === 0) add(cands, lei, bare, 3);
        }
      }

      if (!cands.size) continue;
      let best = Infinity;
      cands.forEach((c) => { if (c.rank < best) best = c.rank; });
      cands.forEach((c) => { if (c.rank === best) found.set(c.lei, c); });
    }
    return Array.from(found.values());
  }

  /* =====================================================================
   * 七、数据展开
   * ===================================================================*/

  function unpack(data) {
    const columns = {};
    data.H.forEach((name, i) => {
      const col = data.D[i];
      columns[name] = col.d ? col.i.map((k) => col.d[k]) : col.v;
    });

    const n = data.meta.total;
    const records = new Array(n);
    for (let i = 0; i < n; i++) {
      const rec = { id: i };
      for (const name of data.H) rec[name] = columns[name][i];
      rec.headcount = parseInt(rec['招录名额'], 10) || 0;
      rec.major = GK.analyzeMajor(flat(rec['专业']));
      rec.majorUnlimited = unlimitedLevels(rec.major);
      rec.flags = analyzeFlags(rec);
      rec.tags = tagsOf(rec.flags);
      rec._searchText = GK.normalize(flat([
        rec['职位编码'], rec['市州'], rec['系统类别'], rec['招录机关'], rec['内设机构'],
        rec['职位名称'], rec['考试类别'], rec['职位简介'], rec['拟任职务'],
        rec['专业'], rec['学历'], rec['学位'], rec['考录对象'],
        rec['其他要求'], rec['备注'], rec['咨询电话'],
      ].join('\u0001')));
      records[i] = rec;
    }
    return records;
  }

  /* =====================================================================
   * 八、导出与标签文案
   * ===================================================================*/

  const CSV_COLUMNS = [
    '职位编码', '市州', '系统类别', '招录机关', '内设机构', '职位名称',
    '考试类别', '拟任职务', '招录名额', '考录范围', '考录对象', '学历', '学位',
    '专业', '政治面貌', '其他要求', '体能测评', '加试专业', '加试民族语言',
    '加试心理测试', '民族自治州驻地', '咨询电话', '备注', '匹配档位', '匹配依据',
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
    buildProfile: buildProfile,
    personalActive: personalActive,
    matchRow: matchRow,
    scopeOk: scopeOk,
    HUKOU_OUTSIDE: HUKOU_OUTSIDE,
    matchMajor: matchMajor,
    filterRecords: filterRecords,
    suggestClasses: suggestClasses,
    analyzeFlags: analyzeFlags,
    tagsOf: tagsOf,
    unlimitedLevels: unlimitedLevels,
    educationOk: educationOk,
    degreeOk: degreeOk,
    politicsOk: politicsOk,
    toCSV: toCSV,
    tagLabel: tagLabel,
    tagDesc: tagDesc,
    TIERS: TIERS,
    TAG_DEFS: TAG_DEFS,
    TARGET_LABELS: TARGET_LABELS,
    FLAG_FIELDS: FLAG_FIELDS,
    CSV_COLUMNS: CSV_COLUMNS,
    DEFAULT_PROFILE: DEFAULT_PROFILE,
  };

  global.SCMatch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
