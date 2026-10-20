/**
 * app.js —— 界面状态、渲染、收藏对比、统计、导出
 *
 * 数据文件（data/positions.js）是后注入的：先把载入遮罩画出来，再挂 <script>，
 * 否则 4.6MB 的同步脚本会阻塞首屏，用户只看到白屏。
 */
(function () {
  'use strict';

  const GK = window.GKMatch;
  const $ = function (id) { return document.getElementById(id); };
  const STORE_KEY = 'gk2027.state.v1';
  const SAVED_KEY = 'gk2027.saved.v1';
  // 存档格式版本。没有这个字段的都是 v1（英语默认值是「无」的那一版），
  // restore 里据此把 v1 的英语值迁移过来；写入时打上新版本，迁移就只发生一次。
  const STORE_VERSION = 2;
  const CAP_STEP = 200;          // 每个档位一次渲染多少张卡，点「显示更多」再加一档
  const reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let records = null;
  let DATA = null;
  let lastResult = null;
  let firstRender = true;
  const saved = new Set();

  const state = {
    profile: null,
    sort: 'tier',
    search: '',
    tierFilter: 'all',
    onlySaved: false,
    distTab: 'provinces',
    caps: { exact: CAP_STEP, class: CAP_STEP, category: CAP_STEP },
  };

  /* ===================================================================
   * 小工具
   * ===================================================================*/

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /** 在专业栏原文里标红命中的词。必须先切片再转义，否则实体的 & 会错位。 */
  function highlight(raw, tokens) {
    const text = String(raw == null ? '' : raw);
    const list = (tokens || []).filter(Boolean).sort(function (a, b) { return b.length - a.length; });
    if (!list.length) return esc(text);
    const re = new RegExp('(' + list.map(escRe).join('|') + ')', 'g');
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!m[0]) { re.lastIndex++; continue; }      // 零宽命中要手动推进，否则死循环
      if (m.index > last) out += esc(text.slice(last, m.index));
      out += '<mark>' + esc(m[0]) + '</mark>';
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
  }

  /** 从 match.js 给的「依据」文本里还原出命中词，用于原文标红 */
  function tokensFromReasons(reasons) {
    const out = [];
    (reasons || []).forEach(function (r) {
      const i = r.lastIndexOf('：');
      if (i < 0) return;                             // 「专业不限」这类没有命中词
      r.slice(i + 1).split(' / ').forEach(function (t) { if (t) out.push(t); });
    });
    return out;
  }

  /**
   * 大数字滚动。显示值记在 tickState 里而不是从 DOM 文本反推 ——
   * 两次筛选间隔比动画时长短时，两个 rAF 循环会互相抢写同一个元素，
   * 起点被读成对方的中途值，数字能跑到目标之外。所以每次先取消上一帧。
   */
  const tickState = new WeakMap();

  function tick(el, to, duration) {
    const st = tickState.get(el) || { shown: 0, raf: 0, net: 0 };
    if (st.raf) cancelAnimationFrame(st.raf);
    if (st.net) clearTimeout(st.net);

    function settle() {
      st.raf = 0;
      st.net = 0;
      st.shown = to;
      tickState.set(el, st);
      el.textContent = to.toLocaleString('en-US');
    }

    const from = st.shown;
    if (reduceMotion || from === to || !duration) { settle(); return; }

    const t0 = performance.now();
    function step(now) {
      // 下界必须钳住：rAF 的时间戳可能早于刚才的 performance.now() 采样点，
      // k 为负时三次缓动会反向放大，数字能冲到目标之外好几个数量级
      const k = Math.max(0, Math.min(1, (now - t0) / duration));
      const eased = 1 - Math.pow(1 - k, 3);
      st.shown = Math.round(from + (to - from) * eased);
      el.textContent = st.shown.toLocaleString('en-US');
      st.raf = k < 1 ? requestAnimationFrame(step) : 0;
    }
    st.raf = requestAnimationFrame(step);
    // 后台标签页 / 无头浏览器里 rAF 可能被节流甚至不触发，兜底直接落到终值
    st.net = setTimeout(settle, duration + 140);
    tickState.set(el, st);
  }

  function debounce(fn, ms) {
    let timer = null;
    return function () {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(null, args); }, ms);
    };
  }

  function chosen(container) {
    if (!container) return [];
    return Array.prototype.slice.call(container.querySelectorAll('input:checked'))
      .map(function (i) { return i.value; });
  }

  /* ===================================================================
   * 持久化
   * ===================================================================*/

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        v: STORE_VERSION,
        profile: state.profile, sort: state.sort, distTab: state.distTab,
      }));
      localStorage.setItem(SAVED_KEY, JSON.stringify(Array.from(saved)));
    } catch (e) { /* 隐私模式或无存储时静默降级 */ }
  }

  function restore() {
    let store = {};
    try {
      store = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {};
      JSON.parse(localStorage.getItem(SAVED_KEY) || '[]').forEach(function (id) {
        if (typeof id === 'number') saved.add(id);
      });
    } catch (e) { /* 存档损坏就当没有 */ }

    state.profile = Object.assign({}, GK.DEFAULT_PROFILE, store.profile || {});
    // 老存档里是二元的是否应届，换成毕业年份：原来选「应届」的按当年届算。
    // 迁移只做一次，之后 profile 里不再有 freshness 字段。
    if (!store.profile || !store.profile.gradYear) {
      const old = store.profile && store.profile.freshness;
      state.profile.gradYear = old === '往届'
        ? 'earlier'
        : String(GK.examCohortYear());
    }
    // v1 的「无」写的是「未取得 / 不填」，一个选项里混了两件事，而且它是默认值——
    // 也就是说绝大多数存档里的「无」是没动过，不是「我没过四级」。v2 把两者拆开，
    // 所以 v1 的「无」一律落回空值（没填），不能当成断言留着。
    if (!store.v && state.profile.english === '无') state.profile.english = '';
    if (store.sort) state.sort = store.sort;
    if (store.distTab) state.distTab = store.distTab;
  }

  /* ===================================================================
   * 侧栏选项的生成
   * ===================================================================*/

  function countsOf(field) {
    const map = new Map();
    records.forEach(function (r) {
      const v = r[field];
      if (!v) return;
      map.set(v, (map.get(v) || 0) + 1);
    });
    return Array.from(map.entries()).sort(function (a, b) { return b[1] - a[1]; });
  }

  function checkboxHTML(items, name) {
    return items.map(function (it) {
      const value = Array.isArray(it) ? it[0] : it.value;
      const label = Array.isArray(it) ? it[1] : it.label;
      const count = Array.isArray(it) ? it[2] : (it.count || 0);
      return '<label class="check"><input type="checkbox" name="' + name + '" value="' + esc(value) + '"> ' +
        esc(label) + (count ? ' <span class="num" style="color:#A9A69C">' + count + '</span>' : '') + '</label>';
    }).join('');
  }

  const pickers = {};

  function buildPicker(opts) {
    const list = $(opts.listId);
    const search = $(opts.searchId);
    const chips = opts.chipsId ? $(opts.chipsId) : null;
    const items = opts.items;

    list.innerHTML = items.map(function (it) {
      return '<label class="lei" data-name="' + esc(it.value) + '">' +
        '<input type="checkbox" value="' + esc(it.value) + '">' +
        '<span class="lei__name">' + esc(it.label) + '</span>' +
        '<span class="lei__count">' + (it.count || 0) + '</span></label>';
    }).join('');

    const api = {
      /** 勾选并同步 chips */
      set: function (values) {
        const want = new Set(values || []);
        Array.prototype.forEach.call(list.querySelectorAll('input'), function (input) {
          input.checked = want.has(input.value);
        });
        syncChips();
      },
      values: function () {
        return Array.prototype.slice.call(list.querySelectorAll('input:checked'))
          .map(function (i) { return i.value; });
      },
      /** 外部（如专业代码推荐）追加一个值 */
      add: function (value) {
        const input = list.querySelector('input[value="' + escRe(value).replace(/"/g, '\\"') + '"]');
        if (input && !input.checked) { input.checked = true; syncChips(); return true; }
        return false;
      },
      has: function (value) {
        const input = list.querySelector('input[value="' + escRe(value).replace(/"/g, '\\"') + '"]');
        return !!(input && input.checked);
      },
    };

    function syncChips() {
      if (!chips) return;
      const picked = api.values();
      chips.innerHTML = picked.map(function (v) {
        return '<span class="chip">' + esc(v) +
          '<button type="button" data-remove="' + esc(v) + '" aria-label="移除 ' + esc(v) + '">×</button></span>';
      }).join('');
      list.querySelectorAll('.lei').forEach(function (row) {
        const input = row.querySelector('input');
        row.classList.toggle('lei--picked', input.checked);
      });
    }

    // 搜索只在已有节点上切换 hidden，185 个类目不重排
    search.addEventListener('input', function () {
      const q = search.value.trim();
      list.querySelectorAll('.lei').forEach(function (row) {
        const hit = !q || row.getAttribute('data-name').indexOf(q) >= 0;
        row.hidden = !hit;
      });
    });

    list.addEventListener('change', function () { syncChips(); onFormChange(); });
    if (chips) {
      chips.addEventListener('click', function (e) {
        const btn = e.target.closest('button[data-remove]');
        if (!btn) return;
        const input = list.querySelector('input[value="' + escRe(btn.getAttribute('data-remove')).replace(/"/g, '\\"') + '"]');
        if (input) input.checked = false;
        syncChips();
        onFormChange();
      });
    }

    pickers[opts.key] = api;
    return api;
  }

  function buildSidebar() {
    // 服务基层项目
    $('f-services').innerHTML = checkboxHTML(
      GK.SERVICE_KEYS.map(function (k) { return [k[0], k[0]]; }), 'services');

    // 省份：只列源表里真实出现过的，按职位数排序（港澳台无职位，不列）
    buildPicker({
      key: 'provinces', listId: 'f-prov-list', searchId: 'f-prov-search',
      chipsId: 'f-prov-chips',
      items: countsOf('province').map(function (e) {
        return { value: e[0], label: e[0], count: e[1] };
      }),
    });

    // 专业类目：词表带出现次数，方便判断哪些类目是「大路货」
    buildPicker({
      key: 'classes', listId: 'f-lei-list', searchId: 'f-lei-search',
      chipsId: 'f-lei-chips',
      items: DATA.leiVocab.map(function (e) { return { value: e[0], label: e[0], count: e[1] }; }),
    });

    // 其余单选条件直接由数据取值生成，避免写死与源表不符
    $('f-levels').innerHTML = checkboxHTML(countsOf('机构层级').map(function (e) {
      return [e[0], e[0], e[1]];
    }), 'levels');
    $('f-exams').innerHTML = checkboxHTML(countsOf('考试类别').map(function (e) {
      return [e[0], e[0], e[1]];
    }), 'exams');
    $('f-attrs').innerHTML = checkboxHTML(countsOf('职位属性').map(function (e) {
      return [e[0], e[0], e[1]];
    }), 'attrs');
    $('f-categories').innerHTML = checkboxHTML(countsOf('招录类别').map(function (e) {
      return [e[0], e[0], e[1]];
    }), 'categories');

    // 面试比例
    const ratios = countsOf('面试人员比例').slice(0, 12);
    $('f-ratio').innerHTML = '<option value="">不限</option>' + ratios.map(function (e) {
      return '<option value="' + esc(e[0]) + '">' + esc(e[0]) + '（' + e[1] + '）</option>';
    }).join('');
    $('f-ratio').multiple = false;

    // 附加条件：只列侧栏别处没有输入控件的标签。
    // 另外六个（应届两条、性别两条、英语两条）在上面的「毕业年份」「性别」「英语等级」
    // 各有自己的行，把整个词表铺两遍会生出矛盾状态——英语选「已过六级」再勾上
    // 「要求六级」，就把你明明够得着的岗位扣掉了（实测 75 个）。
    $('f-exclude').innerHTML = ['hukou', 'service5', 'physical', 'west']
      .map(function (key) {
        return '<label class="check"><input type="checkbox" name="excludeTagKeys" value="' +
          esc(key) + '"> ' + esc(GK.tagLabel(key)) + '</label>';
      }).join('');

    // 毕业年份：届别是 unpack 时从数据里认出来的，所以选项也得现生成
    const thisYear = GK.examCohortYear();
    const leeway = GK.leewayYears();
    // 「附加条件 · 只看限某届」里的年份同样现取，换一份新表不用改 HTML
    Array.prototype.forEach.call(document.querySelectorAll('.js-cohort-year'), function (el) {
      el.textContent = String(thisYear);
    });
    // 侧栏只有 322px 宽，选项文字太长会把下拉箭头挤出去，所以标签从简，
    // 具体口径交给下面的提示行说
    const opts = [[String(thisYear), thisYear + ' 届（当年应届）']];
    for (let i = leeway.length - 2; i >= 0; i--) {
      opts.push([String(leeway[i]), leeway[i] + ' 届（择业期内）']);
    }
    // 最后一项不写具体年份：'earlier' 在 match.js 里 gradYearNum = 0，两条应届规则都过不了，
    // 行为就是纯粹的「非应届」。写成「2024 届及更早（往届）」反而把口径说窄了——
    // 择业期一过，2024、2023、2022 届在这一点上没有任何区别，写出具体年份会让人以为
    // 还得再对一次数字。值仍然是 'earlier'，老存档不用迁移。
    opts.push(['earlier', '非应届']);
    $('f-gradyear').innerHTML = opts.map(function (o) {
      return '<option value="' + esc(o[0]) + '">' + esc(o[1]) + '</option>';
    }).join('');
    $('f-gradyear-hint').textContent =
      '写「限' + thisYear + '届高校毕业生」的职位只认当年应届；' +
      '写「限应届高校毕业生」的职位，' + leeway[0] + '—' + thisYear + ' 届都在择业期内，都算应届。' +
      '选「非应届」则两类职位都会从结果里去掉。';

    // 表头
    $('masthead-meta').innerHTML = '数据来源：' + esc(DATA.meta.source) +
      ' · 共 <b>' + DATA.meta.total.toLocaleString('en-US') + '</b> 个职位';
  }

  /* ===================================================================
   * 表单读写
   * ===================================================================*/

  function readForm() {
    return {
      level: $('f-level').value,
      degree: $('f-degree').value,
      politics: $('f-politics').value,
      years: parseInt($('f-years').value, 10) || 0,
      services: chosen($('f-services')),
      gender: (document.querySelector('input[name="gender"]:checked') || {}).value || '不限',
      gradYear: $('f-gradyear').value || String(GK.examCohortYear()),
      english: $('f-english').value,
      majorText: $('f-major').value,
      majorCodes: $('f-codes').value,
      classes: pickers.classes ? pickers.classes.values() : [],
      provinces: pickers.provinces ? pickers.provinces.values() : [],
      levels: chosen($('f-levels')),
      exams: chosen($('f-exams')),
      attrs: chosen($('f-attrs')),
      categories: chosen($('f-categories')),
      minHeadcount: parseInt($('f-headcount').value, 10) || 0,
      ratios: $('f-ratio').value ? [$('f-ratio').value] : [],
      excludeTagKeys: chosen($('f-exclude')),
      onlyCohort: $('f-only-cohort').checked,
      ruleFresh: $('f-rule-fresh').checked,
      ruleGender: $('f-rule-gender').checked,
      ruleEnglish: $('f-rule-english').checked,
    };
  }

  function writeForm(p) {
    $('f-level').value = p.level;
    $('f-degree').value = p.degree;
    $('f-politics').value = p.politics;
    $('f-years').value = String(p.years);
    $('f-english').value = p.english || '';
    $('f-major').value = p.majorText || '';
    $('f-codes').value = p.majorCodes || '';
    $('f-headcount').value = String(p.minHeadcount || 0);
    $('f-rule-fresh').checked = p.ruleFresh !== false;
    $('f-rule-gender').checked = p.ruleGender !== false;
    $('f-rule-english').checked = p.ruleEnglish !== false;

    setRadio('gender', p.gender || '不限');
    $('f-gradyear').value = p.gradYear || String(GK.examCohortYear());
    setChecked($('f-services'), p.services);
    setChecked($('f-levels'), p.levels);
    setChecked($('f-exams'), p.exams);
    setChecked($('f-attrs'), p.attrs);
    setChecked($('f-categories'), p.categories);
    setChecked($('f-exclude'), p.excludeTagKeys);
    $('f-only-cohort').checked = !!p.onlyCohort;
    if (pickers.classes) pickers.classes.set(p.classes);
    if (pickers.provinces) pickers.provinces.set(p.provinces);
    if (p.ratios && p.ratios.length) $('f-ratio').value = p.ratios[0];
  }

  function setRadio(name, value) {
    const el = document.querySelector('input[name="' + name + '"][value="' + esc(value) + '"]');
    if (el) el.checked = true;
  }
  function setChecked(container, values) {
    const want = new Set(values || []);
    container.querySelectorAll('input[type="checkbox"]').forEach(function (i) {
      i.checked = want.has(i.value);
    });
  }

  /** 专业名称/代码变化 -> 提示可能所属的类目，一键加入 */
  function renderSuggestion() {
    const box = $('f-major-sugg');
    const text = ($('f-major').value + ' ' + $('f-codes').value).trim();
    if (!text) { box.textContent = ''; return; }

    const all = GK.suggestClasses(text, {
      majorDict: DATA.majorDict, codeToLei: DATA.codeToLei,
    });
    const todo = all.filter(function (s) { return !pickers.classes.has(s.lei); }).slice(0, 6);

    if (todo.length) {
      box.innerHTML = '推断所属类目，点击加入：' + todo.map(function (s) {
        return '<button type="button" class="chipbtn" data-add-lei="' + esc(s.lei) +
          '" title="由「' + esc(s.from) + '」推断">' + esc(s.lei) + '</button>';
      }).join(' ');
      return;
    }
    // 推断不出来、和「推断出来了但你已经勾上」是两回事，不能混成一句话
    if (all.length) {
      box.textContent = '已包含推断出的类目：' + all.map(function (s) { return s.lei; }).join('、');
      return;
    }
    box.innerHTML = '未能自动判断类目。对照《专业参考目录》在下方勾选 —— 这一档通常能多出上千个职位。';
  }

  /* ===================================================================
   * 渲染：总览
   * ===================================================================*/

  function render() {
    const raw = readForm();
    state.profile = raw;
    const t0 = performance.now();
    lastResult = GK.filterRecords(records, raw, { search: state.search, sort: state.sort });
    const elapsed = Math.round(performance.now() - t0);

    state.profile = raw;
    persist();
    renderTally();
    renderNotices();
    renderTiers();
    renderGroups();
    renderDist();
    renderDrawer();
    renderSuggestion();

    const verb = lastResult.mode === 'search' ? '检索' : '筛';
    $('live').textContent = (lastResult.mode === 'search' ? '检索' : '筛选') +
      '完成，' + lastResult.stats.total + ' 个职位';
    // 无头浏览器 / 虚拟时钟下 performance.now() 可能不动，显示 0 ms 像是坏了
    $('tally-aside').textContent = state.onlySaved
      ? '只看已收藏（共' + verb + '出 ' + lastResult.stats.total.toLocaleString('en-US') + ' 个）'
      : '在 ' + DATA.meta.total.toLocaleString('en-US') +
        ' 个职位中' + verb + '出 · ' + (elapsed < 1 ? '不足 1' : elapsed) + ' ms';
    firstRender = false;
  }

  /** 当前档位筛选 + 只收藏 之后真正要列出的记录 */
  function visibleGroups() {
    // 检索模式只有一档，档位筛选（精准 / 类合 / 门类）在这里没有意义
    const tiers = lastResult.mode === 'search'
      ? ['search']
      : (state.tierFilter === 'all' ? ['exact', 'class', 'category'] : [state.tierFilter]);
    const out = [];
    tiers.forEach(function (t) {
      let list = lastResult.groups[t] || [];
      if (state.onlySaved) list = list.filter(function (r) { return saved.has(r.id); });
      out.push({ tier: t, list: list });
    });
    return out;
  }

  function renderTally() {
    const groups = visibleGroups();
    const listed = groups.reduce(function (acc, g) { return acc.concat(g.list); }, []);
    const count = listed.length;
    const people = listed.reduce(function (a, r) { return a + r.headcount; }, 0);
    const exact = (groups.find(function (g) { return g.tier === 'exact'; }) || { list: [] }).list.length;

    // 滚动只在首次载入播一次：每次筛选都滚的话，打字时数字会一直抖，
    // 而且动画期间显示的是旧值，看着像没生效
    const dur = firstRender ? 700 : 0;
    tick($('tally-count'), count, dur);
    tick($('tally-people'), people, dur);
    tick($('tally-exact'), exact, dur);

    // 检索模式下「可报职位 / 专业精准命中」都不成立：
    // 前者改成「检索结果」，后者整格收起来。
    const searchMode = lastResult.mode === 'search';
    $('tally-label-count').textContent = searchMode ? '检索结果' : '可报职位';
    $('tally-exact-item').hidden = searchMode;
  }

  function renderNotices() {
    const box = $('notices');

    // 检索模式不讲排除原因：这里一行都没被「排除」，只是没搜到
    if (lastResult.mode === 'search') {
      box.innerHTML = '<p class="notice notice--info"><span>专业栏空着，正在按文字检索全部 ' +
        DATA.meta.total.toLocaleString('en-US') + ' 个职位，<b>没有套用左侧报考条件</b>。' +
        '检索结果只说明表里有哪些岗位，不代表你能报。填上专业后即恢复资格匹配。</span></p>';
      return;
    }

    const ex = lastResult.stats.excluded || {};
    const out = [];

    function ruleNotice(key, why, label) {
      if (!state.profile[key] || !ex[why]) return;
      out.push({
        text: '已按备注排除 <b class="num">' + ex[why] + '</b> 个' + label + '的职位。' +
              '这一条是从备注文本推断的，可能不准。',
        action: { label: '改为只提示', key: key },
      });
    }
    ruleNotice('ruleFresh', '限' + GK.examCohortYear() + '届（备注）',
               '「限' + GK.examCohortYear() + '届高校毕业生」');
    ruleNotice('ruleFresh', '限应届高校毕业生（备注，含择业期）',
               '「限应届高校毕业生」（含择业期）');
    ruleNotice('ruleGender', '限男性（备注）', '限男性');
    ruleNotice('ruleGender', '限女性（备注）', '限女性');
    ruleNotice('ruleEnglish', '有英语等级要求（备注）', '要求英语等级');
    ruleNotice('ruleEnglish', '要求六级（备注）', '要求英语六级');

    // 「只看限当年届」是用户主动勾的收窄条件，排除量和退出入口都要说清楚，
    // 否则结果一下少掉几千个，看着像工具算错了。
    const onlyCohortWhy = '不在「仅限' + GK.examCohortYear() + '届」范围';
    if (state.profile.onlyCohort) {
      if (String(state.profile.gradYear) !== String(GK.examCohortYear())) {
        out.push({
          tone: 'info',
          text: '你选的毕业年份不是 ' + GK.examCohortYear() + ' 届，' +
                '而「只看限 ' + GK.examCohortYear() + ' 届」只留当年那一届的职位，' +
                '两者对不上，结果必然是 0。',
          action: { label: '取消这条', key: 'onlyCohort' },
        });
      }
      if (ex[onlyCohortWhy]) {
        out.push({
          text: '已按「只看限 ' + GK.examCohortYear() + ' 届」挡掉 <b class="num">' +
                ex[onlyCohortWhy] + '</b> 个职位：它们的备注写的是「限应届高校毕业生」' +
                '（含择业期），或者根本没提应往届。',
          action: { label: '取消这条', key: 'onlyCohort' },
        });
      }
    }

    // 英语留空（默认）时上面两条都不会出现——工具没排除任何职位。
    // 但结果里确实混着要求英语的职位，得说明白，否则用户以为自己都符合。
    // 按「行」计数，不按标签计数：一行可能同时要求四级和六级，按标签数会重复统计。
    let engRows = 0;
    let engSix = 0;
    Object.keys(lastResult.groups || {}).forEach(function (t) {
      (lastResult.groups[t] || []).forEach(function (r) {
        if (!englishGaps(r, state.profile).length) return;
        engRows += 1;
        if (r.tags.indexOf('cet6') >= 0) engSix += 1;
      });
    });
    if (engRows) {
      out.push({
        text: '结果里有 <b class="num">' + engRows + '</b> 个职位要求英语等级' +
              (engSix ? '（其中 ' + engSix + ' 个要求六级）' : '') + '，' +
              (state.profile.english ? '「按英语排除」已关掉' : '你还没填英语水平') +
              '，这些卡片都标了 ⚠，请自行核对。',
        tone: 'info',
      });
    }

    const p = state.profile;
    if (p.majorText || p.majorCodes || p.classes.length) {
      const noClass = !p.classes.length;
      if (noClass) {
        out.push({
          text: '没有勾选专业类目，现在只按专业名称和代码匹配。多数职位的专业栏写的是类目' +
                '（如「计算机类」），不勾类目会漏掉大量可报职位。',
          tone: 'info',
        });
      }
    } else {
      out.push({ text: '尚未填写专业，结果只反映学历、政治面貌等硬性条件。', tone: 'info' });
    }

    box.innerHTML = out.map(function (n) {
      const btn = n.action
        ? '<button type="button" data-toggle-rule="' + n.action.key + '">' + n.action.label + '</button>'
        : '';
      return '<p class="notice' + (n.tone === 'info' ? ' notice--info' : '') + '">' +
        '<span>' + n.text + '</span>' + btn + '</p>';
    }).join('');
  }

  function renderTiers() {
    const t = lastResult.stats.byTier;
    if (lastResult.mode === 'search') {
      // 纯检索没有档位可分，把三颗药丸换成一句「这是检索，不是可报判断」
      $('tiers').innerHTML = '<span class="tier-pill tier-pill--on">检索结果 ' +
        lastResult.stats.total.toLocaleString('en-US') + '</span>' +
        '<span class="tier-note">未套用左侧报考条件</span>';
      return;
    }
    const defs = [
      { key: 'all', label: '全部', count: lastResult.stats.total },
      { key: 'exact', label: GK.TIERS.exact.label, count: t.exact.count },
      { key: 'class', label: GK.TIERS.class.label, count: t.class.count },
      { key: 'category', label: GK.TIERS.category.label, count: t.category.count },
    ];
    $('tiers').innerHTML = defs.map(function (d) {
      const on = state.tierFilter === d.key;
      const dim = d.count === 0 && d.key !== 'all';
      return '<button type="button" class="tier-pill' + (on ? ' tier-pill--on' : '') +
        (dim ? ' tier-pill--off' : '') + '" data-tier="' + d.key + '">' +
        esc(d.label) + ' <span class="tier-pill__count">' + d.count.toLocaleString('en-US') +
        '</span></button>';
    }).join('');
  }

  function renderGroups() {
    const host = $('groups');
    const groups = visibleGroups();
    const hasAny = groups.some(function (g) { return g.list.length; });

    if (!hasAny) {
      host.innerHTML = emptyState();
      return;
    }

    let firstSeal = firstRender;
    host.innerHTML = groups.map(function (g) {
      if (!g.list.length) return '';
      const def = GK.TIERS[g.tier];
      const cap = state.caps[g.tier] || CAP_STEP;
      const shown = g.list.slice(0, cap);
      const rest = g.list.length - shown.length;
      const headText = shown.reduce(function (a, r) { return a + r.headcount; }, 0);

      const cards = shown.map(function (r, i) {
        const animate = firstSeal && i < 6;
        return cardHTML(r, g.tier, animate);
      }).join('');
      firstSeal = false;

      return '<section class="group">' +
        '<div class="group-head">' +
          '<h2 class="group-head__title">' + esc(def.label) + '</h2>' +
          '<span class="group-head__count">' + g.list.length.toLocaleString('en-US') + ' 个 / ' +
            headText.toLocaleString('en-US') + ' 人</span>' +
          '<span class="group-head__desc">' + esc(def.desc) + '</span>' +
        '</div>' +
        '<div class="cards">' + cards + '</div>' +
        (rest > 0
          ? '<p style="margin:14px 0 0"><button type="button" class="btn" data-more="' + g.tier +
            '">再显示 ' + Math.min(rest, CAP_STEP) + ' 个（还有 ' + rest.toLocaleString('en-US') + ' 个未显示）</button></p>'
          : '') +
      '</section>';
    }).join('');
  }

  function emptyState() {
    const ex = lastResult.stats.excluded || {};
    const top = Object.keys(ex).sort(function (a, b) { return ex[b] - ex[a]; }).slice(0, 6);
    const p = state.profile;

    if (state.onlySaved) {
      return '<div class="empty">' +
        '<p class="empty__title">还没有收藏任何职位</p>' +
        '<p class="empty__text">点职位卡右下角的「收藏」，收藏的职位会并排出现在这里对比。</p>' +
      '</div>';
    }

    // 检索模式搜空了：这不是「条件太窄」，别让人去掉专业
    if (lastResult.mode === 'search') {
      return '<div class="empty">' +
        '<p class="empty__title">没有搜到「' + esc(state.search) + '」</p>' +
        '<p class="empty__text">检索的是部门名称、用人司局、职位名称、部门代码、职位代码、工作地点、专业栏和备注。</p>' +
        '<ul class="empty__list">' +
          '<li>先用短一点的片段，例如只搜「天府新区」而不带上级机关全称</li>' +
          '<li>职位的正式名称里可能不带「局」「处」这类后缀</li>' +
          '<li>按代码搜时注意别把部门代码和职位代码拼在一起</li>' +
        '</ul>' +
      '</div>';
    }

    // 没填专业时的 0 是必然的：19,426 个职位里只有 7 个不限专业，且都还附带别的条件。
    // 这跟「条件太窄筛空了」是两回事，得分开说，否则用户以为工具坏了。
    if (!p.majorText && !p.majorCodes && !p.classes.length) {
      const unl = 7;
      return '<div class="empty">' +
        '<p class="empty__title">先填上你的专业</p>' +
        '<p class="empty__text">全部 ' + DATA.meta.total.toLocaleString('en-US') +
          ' 个职位里，只有 <span class="num">' + unl + '</span> 个不限专业，' +
          '而这 ' + unl + ' 个还都另有基层经历或党员身份的要求。所以专业栏空着时，可报职位必然为 0。</p>' +
        '<ul class="empty__list">' +
          '<li>在左侧「所学专业」填专业名称，多数人还会填上专业代码</li>' +
          '<li>下面会给出推断的专业类目，点一下就选上 —— 这一档通常能多出上千个职位</li>' +
          '<li>对照《专业参考目录》再手工勾选几个类目，宁多勿少</li>' +
          '<li>只想先找某个部门或岗位？直接在上面搜索框输入名字，不用填专业 —— ' +
            '那会按文字检索全表，不判断你能不能报</li>' +
        '</ul>' +
      '</div>';
    }

    const advice = [];
    if (p.provinces.length) advice.push('取消「工作省份」的限制');
    if (p.classes.length === 0) advice.push('补勾专业类目（专业栏多数写的是类目，不是具体专业名）');
    if (p.ratios.length) advice.push('面试比例改为不限');
    if (p.minHeadcount > 0) advice.push('降低招考人数下限');
    if (p.excludeTagKeys.length) advice.push('取消勾选的排除标签');
    if (p.onlyCohort) advice.push('取消「只看限 ' + GK.examCohortYear() + ' 届」');
    if (p.levels.length || p.exams.length || p.attrs.length || p.categories.length) {
      advice.push('放宽机构层级 / 考试类别 / 职位属性 / 招录类别');
    }

    return '<div class="empty">' +
      '<p class="empty__title">当前条件下没有可报职位</p>' +
      '<p class="empty__text">' + (top.length ? '被排除最多的原因如下，可据此放宽条件。' : '放宽条件后再看。') + '</p>' +
      (top.length
        ? '<ul class="empty__list">' + top.map(function (k) {
            return '<li>' + esc(k) + ' <span class="num">' + ex[k].toLocaleString('en-US') + '</span></li>';
          }).join('') + '</ul>'
        : '') +
      (advice.length
        ? '<p class="empty__text" style="margin-top:14px">可以试试：' +
          advice.map(esc).join(' · ') + '</p>'
        : '') +
    '</div>';
  }

  /* ===================================================================
   * 渲染：职位卡
   * ===================================================================*/

  const GRID_ROWS = [
    ['学历', '学历'], ['学位', '学位'],
    ['政治面貌', '政治面貌'], ['基层年限', '基层工作最低年限'],
    ['招考人数', '招考人数'], ['面试比例', '面试人员比例'],
    ['机构层级', '机构层级'], ['考试类别', '考试类别'],
  ];

  function gridHTML(r) {
    let out = '';
    for (let i = 0; i < GRID_ROWS.length; i += 2) {
      for (let k = 0; k < 2; k++) {
        const pair = GRID_ROWS[i + k];
        if (!pair) break;
        const raw = r[pair[1]];
        const value = /^\d+$/.test(String(raw)) ? '<span class="num">' + esc(raw) + '</span>' : esc(raw || '—');
        out += '<dt>' + esc(pair[0]) + '</dt><dd>' + value + '</dd>';
      }
    }
    out += '<dt>工作地点</dt><dd class="wide">' + esc(r['工作地点'] || '—') + '</dd>';
    if (r['落户地点'] && r['落户地点'] !== r['工作地点']) {
      out += '<dt>落户地点</dt><dd class="wide">' + esc(r['落户地点']) + '</dd>';
    }
    return '<dl class="card__grid">' + out + '</dl>';
  }

  /**
   * 这个职位的英语要求里，用户够不着的有哪些。
   * 返回该标 ⚠ 的标签键数组，全够得着就是空数组。
   *
   * 规则开着、且用户明确说了「未通过四级」时，够不着的行早就被 matchRow 排除了，
   * 根本走不到这里——所以这里不必再判断规则开关，只要问「够不够得着」。
   * 英语留空表示没填，两个等级都够不着，于是这类职位会留在结果里并标上 ⚠。
   *
   * 返回值是数组而不是单个键：1,063 行的备注同时提到四级和六级，只标等级最高的那个，
   * 会让旁边同样够不着的标签看着像没问题。
   */
  function englishGaps(r, p) {
    const has6 = p.english === '六级';
    const has4 = has6 || p.english === '四级';   // 六级能顶四级
    const gaps = [];
    if (r.tags.indexOf('cet6') >= 0 && !has6) gaps.push('cet6');
    if (r.tags.indexOf('cet4') >= 0 && !has4) gaps.push('cet4');
    return gaps;
  }

  function tagsHTML(r) {
    if (!r.tags || !r.tags.length) return '';
    const p = state.profile;
    const conflicting = [];
    // 关掉应届规则时，把「我其实不符合」的那条标出来，别让人以为这些职位真能报
    if (!p.ruleFresh) {
      const y = /^[0-9]{4}$/.test(String(p.gradYear)) ? Number(p.gradYear) : 0;
      if (r.cohortReq && r.cohortReq.length && r.cohortReq.indexOf(y) < 0) conflicting.push('cohort');
      const within = y >= GK.examCohortYear() - 2 && y <= GK.examCohortYear();
      if (r.tags.indexOf('fresh') >= 0 && !within) conflicting.push('fresh');
    }
    if (p.gender === '男' && r.tags.indexOf('female') >= 0 && !p.ruleGender) conflicting.push('female');
    if (p.gender === '女' && r.tags.indexOf('male') >= 0 && !p.ruleGender) conflicting.push('male');
    englishGaps(r, state.profile).forEach(function (k) { conflicting.push(k); });

    return '<div class="tags">' + r.tags.map(function (key) {
      const def = GK.TAG_DEFS.find(function (t) { return t.key === key; }) || GK.EXTRA_TAGS[key];
      if (!def) return '';
      const bad = conflicting.indexOf(key) >= 0;
      const tone = bad ? 'hard' : (def.tone === 'hard' ? '' : (def.tone === 'warn' ? 'warn' : ''));
      return '<span class="tag' + (tone ? ' tag--' + tone : '') + '" title="' + esc(GK.tagDesc(key)) + '">' +
        (bad ? '⚠ ' : '') + esc(GK.tagLabel(key)) + '</span>';
    }).join('') + '</div>';
  }

  function cardHTML(r, tier, animate) {
    const def = GK.TIERS[tier];
    const isSaved = saved.has(r.id);
    const tokens = tokensFromReasons(r.reasons);
    // 专业栏最长 120 字（约 4 行），不截断 —— 这段原文就是匹配的证据本身，
    // 折叠它等于把唯一的凭据藏起来
    const rawMajor = r.major.raw || r['专业'] || '';

    const url = (r['部门网站'] || '').trim();
    const urlHTML = url
      ? '<a href="' + esc(/^https?:/.test(url) ? url : 'http://' + url) +
        '" target="_blank" rel="noopener noreferrer">' + esc(url.replace(/^https?:\/\//, '')) + '</a>'
      : '—';

    const title = r['用人司局'] || r['部门名称'];
    const sub = r['用人司局'] && r['用人司局'] !== r['部门名称']
      ? r['部门名称'] + ' · ' + r['招考职位']
      : r['招考职位'];

    return '<article class="card' + (isSaved ? ' card--saved' : '') + '" data-id="' + r.id + '">' +
      '<div class="card__top">' +
        '<div class="card__ident">' +
          '<h3 class="card__dept">' + esc(title) + '</h3>' +
          '<p class="card__post">' + esc(sub) + '</p>' +
          '<p class="card__code">' +
            '<span class="card__code-item"><span class="card__code-label">部门代码</span>' +
              '<span class="card__code-value">' + esc(r['部门代码']) + '</span>' +
              '<button type="button" class="card__copy" data-copy="' + esc(r['部门代码']) +
                '" aria-label="复制部门代码">复制</button></span>' +
            '<span class="card__code-item"><span class="card__code-label">职位代码</span>' +
              '<span class="card__code-value">' + esc(r['职位代码']) + '</span>' +
              '<button type="button" class="card__copy" data-copy="' + esc(r['职位代码']) +
                '" aria-label="复制职位代码">复制</button></span>' +
          '</p>' +
        '</div>' +
        '<div class="seal' + (animate ? '' : ' seal--idle') +
          (tier === 'category' ? ' seal--dashed' : '') +
          (tier === 'search' ? ' seal--search' : '') +
          '" aria-label="匹配档位：' + esc(def.label) + '">' +
          '<span>' + esc(def.stamp) + '</span>' +
        '</div>' +
      '</div>' +
      gridHTML(r) +
      '<div class="card__major">' +
        '<span class="card__major-label">专业栏原文</span>' +
        '<p class="card__major-text">' + highlight(rawMajor, tokens) + '</p>' +
        (r.reasons && r.reasons.length
          ? '<p class="card__why">' + esc(r.reasons.join('；')) + '</p>' : '') +
        (r.flags && r.flags.length
          ? r.flags.map(function (f) {
              return '<p class="card__why" style="color:#6B6F6A">' + esc(f) + '</p>';
            }).join('')
          : '') +
      '</div>' +
      tagsHTML(r) +
      '<div class="card__foot">' +
        '<button type="button" class="card__more">职位简介 · 备注 · 联系方式</button>' +
        '<button type="button" class="card__save' + (isSaved ? ' card__save--on' : '') + '">' +
          (isSaved ? '★ 已收藏' : '☆ 收藏') + '</button>' +
      '</div>' +
      '<div class="card__remark" hidden>' +
        '<span class="card__remark-title">职位简介</span>' + esc(r['职位简介'] || '（无）') +
        '<span class="card__remark-title" style="margin-top:8px">备注原文</span>' +
          esc(r['备注'] || '（无）') +
        '<span class="card__remark-title" style="margin-top:8px">联系与落户</span>' +
          '部门网站 ' + urlHTML + '<br>' +
          '咨询电话 ' + esc(r['咨询电话1'] || '—') + '<br>' +
          '落户地点 ' + esc(r['落户地点'] || '—') + '<br>' +
          '部门代码 ' + esc(r['部门代码']) + ' · 机构性质 ' + esc(r['机构性质'] || '—') + '<br>' +
          '专业能力测试 ' + esc(r['是否在面试阶段组织专业能力测试'] || '—') +
      '</div>' +
    '</article>';
  }

  /* ===================================================================
   * 渲染：分布统计
   * ===================================================================*/

  const DIST_TABS = [
    { key: 'provinces', label: '省份' },
    { key: 'depts', label: '部门' },
    { key: 'levels', label: '机构层级' },
    { key: 'exams', label: '考试类别' },
    { key: 'tags', label: '风险标签' },
    { key: 'excluded', label: '被排除原因' },
  ];

  /** 分布的统计口径必须跟着列表走：档位筛选、只看收藏之后，数字不能还是全集 */
  function distStats() {
    const list = visibleGroups().reduce(function (acc, g) { return acc.concat(g.list); }, []);
    return {
      provinces: GK.topCounts(list, function (r) { return r.province; }),
      levels: GK.topCounts(list, function (r) { return r['机构层级']; }),
      exams: GK.topCounts(list, function (r) { return r['考试类别']; }),
      depts: GK.topCounts(list, function (r) { return r['部门名称']; }),
      tags: GK.topCounts(
        list.reduce(function (acc, r) { return acc.concat(r.tags); }, []),
        function (t) { return GK.tagLabel(t); }),
      excluded: lastResult.stats.excluded,
    };
  }

  function renderDist() {
    const host = $('dist');
    const stats = distStats();

    // 「被排除原因」是 {原因: 条数}，其余统计是 [{name,count}]，统一成二元组
    const rows = state.distTab === 'excluded'
      ? rowsOf(stats.excluded)
      : (stats[state.distTab] || []).map(function (e) { return [e.name, e.count]; });

    host.hidden = false;
    $('dist-tabs').innerHTML = DIST_TABS.map(function (t) {
      return '<button type="button" class="dist__tab' + (state.distTab === t.key ? ' dist__tab--on' : '') +
        '" data-dist="' + t.key + '">' + esc(t.label) + '</button>';
    }).join('');

    if (!rows.length) {
      $('dist-body').innerHTML = '<p class="hint">没有可统计的记录。</p>';
      return;
    }
    const max = rows[0][1] || 1;
    $('dist-body').innerHTML = rows.slice(0, 12).map(function (e) {
      return '<div class="dist__row">' +
        '<span class="dist__name" title="' + esc(e[0]) + '">' + esc(e[0]) + '</span>' +
        '<span class="dist__bar"><span style="width:' + Math.max(1.5, (e[1] / max) * 100).toFixed(1) + '%"></span></span>' +
        '<span class="dist__count">' + e[1].toLocaleString('en-US') + '</span>' +
      '</div>';
    }).join('');
  }

  function rowsOf(obj) {
    return Object.keys(obj || {}).map(function (k) { return [k, obj[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; });
  }

  /* ===================================================================
   * 渲染：收藏抽屉与对比
   * ===================================================================*/

  const COMPARE_ROWS = [
    ['部门名称', '部门名称'], ['用人司局', '用人司局'], ['招考职位', '招考职位'],
    ['招录类别', '招录类别'], ['机构层级', '机构层级'], ['考试类别', '考试类别'],
    ['职位属性', '职位属性'], ['学历', '学历'], ['学位', '学位'],
    ['政治面貌', '政治面貌'], ['基层年限', '基层工作最低年限'],
    ['基层项目', '服务基层项目工作经历'], ['招考人数', '招考人数'],
    ['面试比例', '面试人员比例'], ['工作地点', '工作地点'], ['落户地点', '落户地点'],
  ];

  function renderDrawer() {
    $('drawer-count').textContent = saved.size;
    const body = $('drawer-body');

    if (!saved.size) {
      body.innerHTML = '<p class="drawer__empty">还没有收藏。在职位卡上点「☆ 收藏」，' +
        '收藏的职位会在这里并排对比，差异项自动标出。</p>';
      return;
    }

    // 收藏的职位可能已被当前条件筛掉，所以直接从全量里取，不依赖 lastResult
    const picked = Array.from(saved).map(function (id) { return records[id]; })
      .filter(Boolean).slice(0, 4);
    // 档位必须按当前条件重算 —— rec.tier 是上一次筛选的残留，直接用会串档
    const profile = GK.buildProfile(state.profile);

    let html = '<table class="compare"><thead><tr><th class="rowhead">共 ' +
      (saved.size > 4 ? '4 / ' + saved.size : saved.size) + ' 个</th>';
    picked.forEach(function (r) {
      html += '<th>' + esc(r['用人司局'] || r['部门名称']) +
        '<button type="button" class="compare__remove" data-unsave="' + r.id + '">移除</button>' +
        '<div style="font-weight:400;color:#6B6F6A;font-size:12px">' + esc(r['招考职位']) + '</div></th>';
    });
    html += '</tr></thead><tbody>';

    html += '<tr><th class="rowhead">当前条件下</th>';
    picked.forEach(function (r) {
      const m = GK.matchMajor(r, profile);
      html += m.tier
        ? '<td><span style="color:#A8201A;font-family:var(--serif);font-weight:700">' +
            esc(GK.TIERS[m.tier].label) + '</span>' +
            (m.reasons.length
              ? '<div style="font-size:12px;color:#6B6F6A">' + esc(m.reasons.join('；')) + '</div>' : '') +
          '</td>'
        : '<td><span style="color:#6B6F6A">不符合当前条件</span>' +
            (m.flags.length
              ? '<div style="font-size:12px;color:#6B6F6A">' + esc(m.flags.join('；')) + '</div>' : '') +
          '</td>';
    });
    html += '</tr>';

    COMPARE_ROWS.forEach(function (pair) {
      const vals = picked.map(function (r) { return r[pair[1]] || '—'; });
      const allSame = vals.every(function (v) { return v === vals[0]; });
      html += '<tr><th class="rowhead">' + esc(pair[0]) + '</th>';
      vals.forEach(function (v) {
        html += '<td' + (allSame ? '' : ' class="diff"') + '>' + esc(v) + '</td>';
      });
      html += '</tr>';
    });

    // 专业栏原文是最需要逐字对比的
    html += '<tr><th class="rowhead">专业栏原文</th>';
    picked.forEach(function (r) {
      html += '<td style="max-width:320px">' + highlight(r.major.raw || r['专业'], []) + '</td>';
    });
    html += '</tr>';

    html += '<tr><th class="rowhead">风险标签</th>';
    picked.forEach(function (r) {
      const labels = (r.tags || []).map(function (k) {
        const d = GK.TAG_DEFS.find(function (t) { return t.key === k; }) || GK.EXTRA_TAGS[k];
        return d ? GK.tagLabel(k) : k;
      });
      html += '<td>' + (labels.length ? esc(labels.join('、')) : '—') + '</td>';
    });
    html += '</tr>';

    html += '<tr><th class="rowhead">备注</th>';
    picked.forEach(function (r) {
      html += '<td style="max-width:320px;color:#4A4844;font-size:12.5px">' +
        esc(r['备注'] || '—') + '</td>';
    });
    html += '</tr>';

    body.innerHTML = html + '</tbody></table>';
  }

  /* ===================================================================
   * 导出
   * ===================================================================*/

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function stamp() {
    const d = new Date();
    const p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  }

  function exportCSV() {
    const groups = visibleGroups();
    const list = groups.reduce(function (acc, g) { return acc.concat(g.list); }, []);
    if (!list.length) { alert('当前没有可导出的职位。'); return; }
    download('国考职位筛选_' + stamp() + '.csv', GK.toCSV(list), 'text/csv;charset=utf-8');
  }

  /* ===================================================================
   * 事件
   * ===================================================================*/

  /** 条件变了就把「显示更多」的展开量收回去，否则筛选后列表长度会很怪 */
  const onFormChange = debounce(function () {
    state.caps = { exact: CAP_STEP, class: CAP_STEP, category: CAP_STEP };
    render();
  }, 120);

  function bind() {
    // 侧栏：所有输入统一走委托。选择器内部的勾选由它自己的监听处理，这里跳过，
    // 否则同一次点击会触发两遍（虽然被 debounce 吞掉，但没必要）
    const rail = document.querySelector('.rail');
    rail.addEventListener('input', function (e) {
      if (e.target.closest('.leipicker')) return;
      renderSuggestion();
      onFormChange();
    });
    rail.addEventListener('change', function (e) {
      if (e.target.closest('.leipicker')) return;
      onFormChange();
    });

    // 推荐类目的点击
    $('f-major-sugg').addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-add-lei]');
      if (!btn) return;
      pickers.classes.add(btn.getAttribute('data-add-lei'));
      renderSuggestion();
      onFormChange();
    });

    // 规则提示条里的「改为只提示」
    $('notices').addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-toggle-rule]');
      if (!btn) return;
      const key = btn.getAttribute('data-toggle-rule');
      const box = {
        ruleFresh: 'f-rule-fresh', ruleGender: 'f-rule-gender',
        ruleEnglish: 'f-rule-english', onlyCohort: 'f-only-cohort',
      }[key];
      if (box) $(box).checked = false;
      onFormChange();
    });

    // 工具条
    $('f-search').addEventListener('input', debounce(function () {
      state.search = $('f-search').value;
      state.caps = { exact: CAP_STEP, class: CAP_STEP, category: CAP_STEP };
      render();
    }, 220));
    $('f-sort').addEventListener('change', function () {
      state.sort = $('f-sort').value;
      render();
    });
    $('f-onlysaved').addEventListener('change', function () {
      state.onlySaved = $('f-onlysaved').checked;
      render();
    });

    // 档位筛选
    $('tiers').addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-tier]');
      if (!btn) return;
      state.tierFilter = btn.getAttribute('data-tier');
      render();
    });

    // 分布标签页
    $('dist-tabs').addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-dist]');
      if (!btn) return;
      state.distTab = btn.getAttribute('data-dist');
      persist();
      renderDist();
    });

    // 卡片动作
    $('groups').addEventListener('click', function (e) {
      const more = e.target.closest('button[data-more]');
      if (more) {
        const tier = more.getAttribute('data-more');
        state.caps[tier] = (state.caps[tier] || CAP_STEP) + CAP_STEP;
        renderGroups();
        return;
      }
      const copy = e.target.closest('button[data-copy]');
      if (copy) {
        copyText(copy.getAttribute('data-copy'), copy);
        return;
      }
      const save = e.target.closest('.card__save');
      if (save) {
        toggleSave(parseInt(save.closest('.card').getAttribute('data-id'), 10));
        return;
      }
      const expand = e.target.closest('.card__more');
      if (expand) {
        const panel = expand.closest('.card').querySelector('.card__remark');
        panel.hidden = !panel.hidden;
        expand.textContent = panel.hidden ? '职位简介 · 备注 · 联系方式' : '收起简介与备注';
      }
    });

    // 抽屉
    $('drawer-bar').addEventListener('click', toggleDrawer);
    $('drawer-bar').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDrawer(); }
    });
    $('drawer-body').addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-unsave]');
      if (btn) toggleSave(parseInt(btn.getAttribute('data-unsave'), 10));
    });

    // 顶部动作
    $('btn-csv').addEventListener('click', exportCSV);
    $('btn-print').addEventListener('click', function () { window.print(); });
    $('btn-reset').addEventListener('click', function () {
      if (!confirm('清空全部报考条件？收藏的职位会保留。')) return;
      state.profile = Object.assign({}, GK.DEFAULT_PROFILE);
      state.search = '';
      state.tierFilter = 'all';
      state.onlySaved = false;
      $('f-search').value = '';
      $('f-onlysaved').checked = false;
      writeForm(state.profile);
      render();
    });

    // 键盘：/ 聚焦搜索
    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) {
        e.preventDefault();
        $('f-search').focus();
      }
    });
  }

  function copyText(text, btn) {
    const done = function () {
      const old = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(function () { btn.textContent = old; }, 1200);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    } else { fallback(); }

    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { /* 复制失败就算了 */ }
      document.body.removeChild(ta);
    }
  }

  function toggleSave(id) {
    if (saved.has(id)) saved.delete(id); else saved.add(id);
    persist();
    // 只更新那张卡，避免整页重排
    const card = document.querySelector('.card[data-id="' + id + '"]');
    if (card) {
      const btn = card.querySelector('.card__save');
      const on = saved.has(id);
      card.classList.toggle('card--saved', on);
      btn.classList.toggle('card__save--on', on);
      btn.textContent = on ? '★ 已收藏' : '☆ 收藏';
    }
    renderDrawer();
    if (state.onlySaved) render();
  }

  function toggleDrawer() {
    const open = $('drawer').classList.toggle('drawer--open');
    $('drawer-bar').setAttribute('aria-expanded', String(open));
    $('drawer-toggle').textContent = open ? '收起' : '展开对比';
  }

  /* ===================================================================
   * 启动
   * ===================================================================*/

  function init() {
    DATA = window.GK_DATA;
    if (!DATA || !DATA.meta) {
      $('loading').innerHTML = '<p class="loading__title">数据没能载入</p>' +
        '<p class="loading__hint">请确认 data/positions.js 与 index.html 在同一目录下。</p>';
      return;
    }
    records = GK.unpack(DATA);

    restore();
    buildSidebar();
    writeForm(state.profile);
    $('f-sort').value = state.sort;
    bind();
    render();
    renderSuggestion();

    // 首次打开且没填专业时，光标直接落在专业栏 —— 空态再怎么解释，
    // 也不如把光标放到位来得直接
    if (!state.profile.majorText && !state.profile.majorCodes) {
      $('f-major').focus({ preventScroll: true });
    }

    $('loading').hidden = true;
  }

  function boot() {
    let started = false;
    function start() {
      if (started) return;
      started = true;
      init();
    }

    // 先让载入遮罩画出来，再注入 4.6MB 的数据脚本
    const s = document.createElement('script');
    s.src = 'data/positions.js';
    s.onload = function () {
      // 双 rAF 让遮罩先上屏；但无头/后台标签页里 rAF 可能一直不触发，
      // 所以再压一个定时器兜底，谁先到谁算
      requestAnimationFrame(function () { requestAnimationFrame(start); });
      setTimeout(start, 400);
    };
    s.onerror = function () {
      $('loading').innerHTML = '<p class="loading__title">找不到 data/positions.js</p>' +
        '<p class="loading__hint">先运行：python build_data.py "2027年国考职位表（全国）.xls"</p>';
    };
    document.body.appendChild(s);
    $('loading-hint').textContent = '读取 data/positions.js …';
    // 数据脚本若始终没动静（file:// 被拦等），要让人看见发生了什么，而不是一直转圈
    setTimeout(function () {
      if (!started) {
        $('loading-hint').textContent = '数据脚本未响应 —— 请确认 data/positions.js 存在，' +
          '或用本地服务器打开本页。';
      }
    }, 8000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
