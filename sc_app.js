/**
 * sc_app.js —— 四川省考页面的状态、渲染、收藏对比、统计、导出
 *
 * 与 app.js（国考）分开写：字段名、档位、侧栏分组都不一样，
 * 硬套一份代码会到处是 if。共用的只有排版样式与 match.js 的文本工具。
 *
 * 这个页面的默认状态是「浏览」——什么个人条件都不填，直接把 4,001 个职位
 * 全部列出来，左侧「浏览筛选」只按职位本身的要求收窄。填了「我的条件」之后
 * 才进入资格匹配；只填学历学位、不填专业时进入「符合硬性条件」一档。
 */
(function () {
  'use strict';

  const SC = window.SCMatch;
  const GK = window.GKMatch;
  const $ = function (id) { return document.getElementById(id); };
  const STORE_KEY = 'sc2027.state.v1';
  // 收藏存职位编码而不是数组序号：重新构建数据后行序会变，
  // 序号会把收藏指到别的职位上（v1 存的就是序号，换表后只能作废）
  const SAVED_KEY = 'sc2027.saved.v2';
  const CAP_STEP = 200;
  const reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let records = null;
  let DATA = null;
  let lastResult = null;
  let firstRender = true;
  const saved = new Set();

  const state = {
    profile: null,
    sort: 'region',
    search: '',
    tierFilter: 'all',
    onlySaved: false,
    distTab: 'cities',
    caps: { all: CAP_STEP, exact: CAP_STEP, class: CAP_STEP, category: CAP_STEP, eligible: CAP_STEP },
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

  /** 先切片再转义，避免实体的 & 让标红位置错位 */
  function highlight(raw, tokens) {
    const text = String(raw == null ? '' : raw);
    const list = (tokens || []).filter(Boolean).sort(function (a, b) { return b.length - a.length; });
    if (!list.length) return esc(text);
    const re = new RegExp('(' + list.map(escRe).join('|') + ')', 'g');
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!m[0]) { re.lastIndex++; continue; }
      if (m.index > last) out += esc(text.slice(last, m.index));
      out += '<mark>' + esc(m[0]) + '</mark>';
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
  }

  /** 「命中本科阶段专业名称：法学」 -> 法学 */
  function tokensFromReasons(reasons) {
    const out = [];
    (reasons || []).forEach(function (r) {
      const i = r.lastIndexOf('：');
      if (i < 0) return;
      r.slice(i + 1).split(' / ').forEach(function (t) { if (t) out.push(t); });
    });
    return out;
  }

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
      const k = Math.max(0, Math.min(1, (now - t0) / duration));
      const eased = 1 - Math.pow(1 - k, 3);
      st.shown = Math.round(from + (to - from) * eased);
      el.textContent = st.shown.toLocaleString('en-US');
      st.raf = k < 1 ? requestAnimationFrame(step) : 0;
    }
    st.raf = requestAnimationFrame(step);
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

  const ARRAY_KEYS = ['classes', 'cities', 'systems', 'exams', 'scopes', 'targets',
    'eduReqs', 'degreeReqs', 'politicsReqs', 'flags', 'tags'];

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        v: 1, profile: state.profile, sort: state.sort, distTab: state.distTab,
      }));
      localStorage.setItem(SAVED_KEY, JSON.stringify(Array.from(saved).map(function (id) {
        const r = records[id];
        return r && r['职位编码'];
      }).filter(Boolean)));
    } catch (e) { /* 隐私模式无存储时静默降级 */ }
  }

  function restore() {
    let store = {};
    try {
      store = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {};
      const byCode = new Map();
      records.forEach(function (r) { byCode.set(String(r['职位编码']), r.id); });
      JSON.parse(localStorage.getItem(SAVED_KEY) || '[]').forEach(function (code) {
        const id = byCode.get(String(code));
        if (id !== undefined) saved.add(id);
      });
      localStorage.removeItem('sc2027.saved.v1');  // 旧版按序号存的收藏，换表后已无意义
    } catch (e) { /* 存档坏了就当没有 */ }

    const p = Object.assign({}, SC.DEFAULT_PROFILE, store.profile || {});
    ARRAY_KEYS.forEach(function (k) { if (!Array.isArray(p[k])) p[k] = []; });
    state.profile = p;
    if (store.sort) state.sort = store.sort;
    if (store.distTab) state.distTab = store.distTab;
  }

  /* ===================================================================
   * 侧栏
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

  function countBy(fn) {
    let n = 0;
    records.forEach(function (r) { if (fn(r)) n += 1; });
    return n;
  }

  function checkboxHTML(items, name) {
    return items.map(function (it) {
      const value = it[0];
      const label = it[1];
      const count = it[2] || 0;
      // title 放原文：筛选写成短语，鼠标停一下能看全
      return '<label class="check" title="' + esc(value) + '"><input type="checkbox" name="' + name +
        '" value="' + esc(value) + '"> ' + esc(label) +
        (count ? ' <span class="num" style="color:#A9A69C">' + count + '</span>' : '') +
        '</label>';
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
        row.classList.toggle('lei--picked', row.querySelector('input').checked);
      });
    }

    search.addEventListener('input', function () {
      const q = search.value.trim();
      list.querySelectorAll('.lei').forEach(function (row) {
        row.hidden = !!q && row.getAttribute('data-name').indexOf(q) < 0;
      });
    });

    list.addEventListener('change', function () { syncChips(); onFormChange(); });
    if (chips) {
      chips.addEventListener('click', function (e) {
        const btn = e.target.closest('button[data-remove]');
        if (!btn) return;
        const input = list.querySelector('input[value="' +
          escRe(btn.getAttribute('data-remove')).replace(/"/g, '\\"') + '"]');
        if (input) input.checked = false;
        syncChips();
        onFormChange();
      });
    }

    pickers[opts.key] = api;
    return api;
  }

  function buildSidebar() {
    // 户籍地：21 个市州 + 四川省外。汇总表里「省直机关」「监狱系统」「戒毒系统」
    // 也占着市州这一列，但它们不是户籍地，按「市州」结尾筛掉
    $('f-hukou').innerHTML = '<option value="">不填</option>' +
      countsOf('市州').filter(function (e) { return /[市州]$/.test(e[0]); })
        .map(function (e) {
          return '<option value="' + esc(e[0]) + '">' + esc(e[0]) + '</option>';
        }).join('') +
      '<option value="' + SC.HUKOU_OUTSIDE + '">四川省外</option>';

    // 市州：22 个，按职位数排
    buildPicker({
      key: 'cities', listId: 'f-city-list', searchId: 'f-city-search',
      chipsId: 'f-city-chips',
      items: countsOf('市州').map(function (e) {
        return { value: e[0], label: e[0], count: e[1] };
      }),
    });

    // 专业类目
    buildPicker({
      key: 'classes', listId: 'f-lei-list', searchId: 'f-lei-search',
      chipsId: 'f-lei-chips',
      items: DATA.leiVocab.map(function (e) {
        return { value: e[0], label: e[0], count: e[1] };
      }),
    });

    $('f-systems').innerHTML = checkboxHTML(countsOf('系统类别').map(function (e) {
      return [e[0], e[0], e[1]];
    }), 'systems');
    $('f-exams').innerHTML = checkboxHTML(countsOf('考试类别').map(function (e) {
      return [e[0], e[0], e[1]];
    }), 'exams');
    $('f-scopes').innerHTML = checkboxHTML(countsOf('考录范围').map(function (e) {
      return [e[0], e[0], e[1]];
    }), 'scopes');
    // 考录对象：原文是整句，筛选项只写短语。同义或按县拆开的写法合并成一项
    // （9 个按县的村社区干部、两种措辞的「应届＋社会·公安院校除外」），
    // 否则侧栏光这一栏就十几行、还出现两个一模一样的名字
    const targetCounts = countsOf('考录对象');
    const groupedTargets = new Set();
    const targetItems = [];
    SC.TARGET_GROUPS.forEach(function (g) {
      let sum = 0;
      targetCounts.forEach(function (e) {
        if (g.test(e[0])) { sum += e[1]; groupedTargets.add(e[0]); }
      });
      if (sum) targetItems.push([g.key, g.key, sum]);
    });
    targetCounts.forEach(function (e) {
      if (groupedTargets.has(e[0])) return;
      targetItems.push([e[0], SC.targetLabel(e[0]), e[1]]);
    });
    targetItems.sort(function (a, b) { return b[2] - a[2]; });
    $('f-targets').innerHTML = checkboxHTML(targetItems, 'targets');
    $('f-edureqs').innerHTML = checkboxHTML(countsOf('学历').map(function (e) {
      return [e[0], e[0], e[1]];
    }), 'eduReqs');
    $('f-degreereqs').innerHTML = checkboxHTML(countsOf('学位').map(function (e) {
      return [e[0], e[0], e[1]];
    }), 'degreeReqs');
    $('f-politicsreqs').innerHTML = checkboxHTML(countsOf('政治面貌').map(function (e) {
      return [e[0], e[0], e[1]];
    }), 'politicsReqs');

    // 附加项：结构化列，比从文字里猜可靠
    const flagKeys = Object.keys(SC.FLAG_FIELDS);
    $('f-flags').innerHTML = checkboxHTML(flagKeys.map(function (key) {
      return [key, SC.FLAG_FIELDS[key], countBy(function (r) { return r.flags[key]; })];
    }), 'flags');

    // 其他要求：只列卡片上会出现的文字标签。
    // 应届、基层经历已在「考录对象」里，四个加试项已在「附加项」里，
    // 同一件事铺两遍会生出互相矛盾的状态。
    const skip = { freshOnly: 1, ground2: 1, policeSchool: 1,
      physical: 1, psych: 1, specialSubject: 1, minorityLang: 1, autonomous: 1 };
    // 计数为 0 的标签不列：本表里户籍限制全在「考录范围」列，其他要求从没提过户籍，
    // 留一个勾了必然空结果的框只会误导
    $('f-tags').innerHTML = checkboxHTML(SC.TAG_DEFS.map(function (d) {
      return [d.key, d.label, countBy(function (r) { return r.tags.indexOf(d.key) >= 0; })];
    }).filter(function (e) {
      return !skip[e[0]] && e[2] > 0;
    }), 'tags');

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
      gender: $('f-gender').value,
      gradStatus: $('f-gradstatus').value,
      hukou: $('f-hukou').value,
      legalCert: $('f-legalcert').value,
      accountingCert: $('f-accounting').value,
      computerCert: $('f-computer').value,
      disabilityCert: $('f-disability').value,
      english: $('f-english').value,
      majorText: $('f-major').value,
      majorCodes: $('f-codes').value,
      classes: pickers.classes ? pickers.classes.values() : [],
      cities: pickers.cities ? pickers.cities.values() : [],
      systems: chosen($('f-systems')),
      exams: chosen($('f-exams')),
      scopes: chosen($('f-scopes')),
      targets: chosen($('f-targets')),
      eduReqs: chosen($('f-edureqs')),
      degreeReqs: chosen($('f-degreereqs')),
      politicsReqs: chosen($('f-politicsreqs')),
      minHeadcount: parseInt($('f-headcount').value, 10) || 0,
      flags: chosen($('f-flags')),
      tags: chosen($('f-tags')),
    };
  }

  /** 旧版本存的是「2025 / 2026 / 2027」届，现在合并成「应届」一档 */
  function normalizeGradStatus(v) {
    return v === '2025' || v === '2026' || v === '2027' ? 'fresh' : (v || '');
  }

  function writeForm(p) {
    $('f-level').value = p.level || '';
    $('f-degree').value = p.degree || '';
    $('f-politics').value = p.politics || '';
    $('f-gender').value = p.gender || '';
    $('f-gradstatus').value = normalizeGradStatus(p.gradStatus);
    $('f-hukou').value = p.hukou || '';
    $('f-legalcert').value = p.legalCert || '';
    $('f-accounting').value = p.accountingCert || '';
    $('f-computer').value = p.computerCert || '';
    $('f-disability').value = p.disabilityCert || '';
    $('f-english').value = p.english || '';
    $('f-major').value = p.majorText || '';
    $('f-codes').value = p.majorCodes || '';
    $('f-headcount').value = String(p.minHeadcount || 0);

    setChecked($('f-systems'), p.systems);
    setChecked($('f-exams'), p.exams);
    setChecked($('f-scopes'), p.scopes);
    setChecked($('f-targets'), p.targets);
    setChecked($('f-edureqs'), p.eduReqs);
    setChecked($('f-degreereqs'), p.degreeReqs);
    setChecked($('f-politicsreqs'), p.politicsReqs);
    setChecked($('f-flags'), p.flags);
    setChecked($('f-tags'), p.tags);
    if (pickers.classes) pickers.classes.set(p.classes);
    if (pickers.cities) pickers.cities.set(p.cities);
  }

  function setChecked(container, values) {
    const want = new Set(values || []);
    container.querySelectorAll('input[type="checkbox"]').forEach(function (i) {
      i.checked = want.has(i.value);
    });
  }

  function renderSuggestion() {
    const box = $('f-major-sugg');
    const text = ($('f-major').value + ' ' + $('f-codes').value).trim();
    if (!text) { box.textContent = ''; return; }

    const all = SC.suggestClasses(text, {
      majorDict: DATA.majorDict, codeToLei: DATA.codeToLei,
      nameToLei: DATA.nameToLei, majorClass: DATA.majorClass,
      leiVocab: DATA.leiVocab,
    });
    const todo = all.filter(function (s) { return !pickers.classes.has(s.lei); }).slice(0, 6);

    if (todo.length) {
      box.innerHTML = '推断所属类目，点击加入：' + todo.map(function (s) {
        return '<button type="button" class="chipbtn" data-add-lei="' + esc(s.lei) +
          '" title="由「' + esc(s.from) + '」推断">' + esc(s.lei) + '</button>';
      }).join(' ');
      return;
    }
    if (all.length) {
      box.textContent = '已包含推断出的类目：' + all.map(function (s) { return s.lei; }).join('、');
      return;
    }
    box.innerHTML = '未能自动判断类目。可对照《专业参考目录》在下方勾选，' +
      '表里大量职位只写「法学类」「计算机类」。';
  }

  /* ===================================================================
   * 渲染
   * ===================================================================*/

  function render() {
    const raw = readForm();
    state.profile = raw;
    const t0 = performance.now();
    lastResult = SC.filterRecords(records, raw, { search: state.search, sort: state.sort });
    const elapsed = Math.round(performance.now() - t0);

    persist();
    renderTally();
    renderNotices();
    renderTiers();
    renderGroups();
    renderDist();
    renderDrawer();
    renderSuggestion();

    $('live').textContent = ({
      browse: '浏览', eligible: '筛选', match: '匹配',
    }[lastResult.mode] || '筛选') + '完成，' + lastResult.stats.total + ' 个职位';

    if (state.onlySaved) {
      $('tally-aside').textContent =
        '只看已收藏（共 ' + lastResult.stats.total.toLocaleString('en-US') + ' 个）';
    } else if (lastResult.mode === 'browse') {
      $('tally-aside').textContent = '浏览全部 ' +
        DATA.meta.total.toLocaleString('en-US') + ' 个职位 · ' +
        (elapsed < 1 ? '不足 1' : elapsed) + ' ms';
    } else {
      $('tally-aside').textContent = '在 ' +
        DATA.meta.total.toLocaleString('en-US') + ' 个职位中筛出 · ' +
        (elapsed < 1 ? '不足 1' : elapsed) + ' ms';
    }
    firstRender = false;
  }

  function visibleGroups() {
    const tiers = lastResult.mode === 'browse' ? ['all']
      : lastResult.mode === 'eligible' ? ['eligible']
      : (state.tierFilter === 'all' ? ['exact', 'class', 'category'] : [state.tierFilter]);
    const out = [];
    tiers.forEach(function (t) {
      let list = lastResult.groups[t] || [];
      if (state.onlySaved) list = list.filter(function (r) { return saved.has(r.id); });
      out.push({ tier: t, list: list });
    });
    return out;
  }

  function visibleList() {
    return visibleGroups().reduce(function (acc, g) { return acc.concat(g.list); }, []);
  }

  function renderTally() {
    const groups = visibleGroups();
    const listed = groups.reduce(function (acc, g) { return acc.concat(g.list); }, []);
    const people = listed.reduce(function (a, r) { return a + r.headcount; }, 0);
    const exact = (groups.find(function (g) { return g.tier === 'exact'; }) || { list: [] }).list.length;
    const isMatch = lastResult.mode === 'match';

    const dur = firstRender ? 700 : 0;
    tick($('tally-count'), listed.length, dur);
    tick($('tally-people'), people, dur);
    tick($('tally-exact'), exact, dur);

    $('tally-label-count').textContent =
      lastResult.mode === 'browse' ? '职位' :
      lastResult.mode === 'eligible' ? '符合硬性条件' : '可报职位';
    $('tally-exact-item').hidden = !isMatch;
  }

  /** 当前列表里带某个标签的行数（按行计，不按标签计） */
  function countRowsWithTag(tag) {
    return visibleList().filter(function (r) { return r.tags.indexOf(tag) >= 0; }).length;
  }

  function renderNotices() {
    const box = $('notices');
    const p = SC.buildProfile(state.profile);
    const out = [];

    // 「本省 / 本市州」按「户籍地」判断。填了户籍，不符合的已经排除，不用再提示；
    // 没填就是不知道，只提示不排除。
    const localScope = p.hukou ? 0 : visibleList().filter(function (r) {
      return r['考录范围'] === '本省' || r['考录范围'] === '本市州';
    }).length;

    if (lastResult.mode === 'browse') {
      out.push({
        tone: 'info',
        text: '你还没有填写任何个人条件，正在<b>浏览全部 ' +
          DATA.meta.total.toLocaleString('en-US') + ' 个职位</b>。' +
          '左侧「浏览筛选」只按职位本身的要求收窄，不会因为你不符合而排除；' +
          '填上「我的条件」后才开始逐条判断你能不能报。',
      });
      if (localScope) {
        out.push({
          tone: 'info',
          text: '其中 <b class="num">' + localScope + '</b> 个职位限本省或本市州户籍/生源。' +
            '你还没填「户籍地」，没有据此判断；填上会自动排除，' +
            '或者直接在左侧「考录范围」里只看「全国」。',
        });
      }
      box.innerHTML = noticeHTML(out);
      return;
    }

    if (lastResult.mode === 'eligible') {
      out.push({
        tone: 'info',
        text: '已按你填的学历、学位、政治面貌、性别、应届身份、户籍地、' +
          '法律职业资格、会计/计算机资格、残疾人证和英语水平判断；' +
          '留空的项一律不排除。专业还没填，所以<b>没有判断专业是否符合</b>——' +
          '这一档只能当作「硬性条件过关」的候选。',
      });
    } else {
      if (p.majorLevelAssumed) {
        out.push({
          tone: 'info',
          text: '「我的学历」没填，专业暂按<b>本科阶段</b>匹配。' +
            '职位专业栏常分「本科：…／研究生：…」，填上学历会更准。',
        });
      }
      if (!p.classes.length) {
        out.push({
          tone: 'info',
          text: '没有勾选专业类目，现在只按专业名称和代码匹配。' +
            '表里大量职位写的是「法学类」「计算机类」，勾上类目通常能多出几百个职位。',
        });
      }
      if (lastResult.stats.byTier.category.count) {
        out.push({
          tone: 'info',
          text: '「门类命中」包含专业不限或门类级匹配的职位，范围较宽，建议逐条核对专业栏。',
        });
      }
    }

    // 定向招录整类不参与判断：不是「你符不符合」，是汇总表没给这类职位列学历和专业
    const directed = lastResult.stats.excluded['定向招录，限特定群体'] || 0;
    if (directed) {
      out.push({
        tone: 'info',
        text: '另有 <b class="num">' + directed + '</b> 个<b>定向招录</b>职位没有参与判断：' +
          '它们限服务基层项目人员、优秀村社区干部、工人农民、退役士兵等特定群体，' +
          '汇总表也没给这类职位列学历和专业。想单独看，在上方「系统类别」里勾「定向公务员」。',
      });
    }

    // 留空的项不排除，但结果里确实混着相应要求。逐条各占一栏会把通知区堆到半屏，
    // 合成一条，数量仍然逐个写明。
    const gaps = [];
    if (!p.english) {
      // cet4 与 cet6 在 analyzeFlags 里互斥（认定六级就不再标四级），直接相加即可
      const n = countRowsWithTag('cet4') + countRowsWithTag('cet6');
      if (n) gaps.push('<b class="num">' + n + '</b> 个要求英语等级');
    }
    if (!p.legalCert) {
      const n = countRowsWithTag('legal') + countRowsWithTag('legalA');
      if (n) gaps.push('<b class="num">' + n + '</b> 个要求法律职业资格');
    }
    if (!p.gradStatus) {
      const fresh = countRowsWithTag('freshOnly');
      const ground = countRowsWithTag('ground2');
      if (fresh) gaps.push('<b class="num">' + fresh + '</b> 个仅限应届');
      if (ground) gaps.push('<b class="num">' + ground + '</b> 个要求两年以上基层经历');
    }
    if (localScope) {
      gaps.push('<b class="num">' + localScope + '</b> 个限本省/本市州户籍或生源');
    }
    // 这三项现在也是「我的条件」里的选项，填了就会排除，没填才提示
    if (!p.accountingCert) {
      const n = countRowsWithTag('accounting');
      if (n) gaps.push('<b class="num">' + n + '</b> 个要求会计/审计资格');
    }
    if (!p.computerCert) {
      const n = countRowsWithTag('computer');
      if (n) gaps.push('<b class="num">' + n + '</b> 个要求计算机资格');
    }
    if (!p.disabilityCert) {
      const n = countRowsWithTag('disability');
      if (n) gaps.push('<b class="num">' + n + '</b> 个是残疾人专项');
    }
    if (gaps.length) {
      out.push({
        tone: 'info',
        text: '结果里还有 ' + gaps.join('、') +
          '。这些项没有参与排除（你还没填，或工具无从判断），' +
          '请对照卡片标签和「其他要求」原文自行核对。',
      });
    }

    box.innerHTML = noticeHTML(out);
  }

  function noticeHTML(list) {
    return list.map(function (n) {
      return '<p class="notice' + (n.tone === 'info' ? ' notice--info' : '') +
        '"><span>' + n.text + '</span></p>';
    }).join('');
  }

  function renderTiers() {
    // 「只看收藏」时列表已经收窄，档位药丸上的数字也得跟着走
    const shownTotal = state.onlySaved ? visibleList().length : lastResult.stats.total;
    if (lastResult.mode === 'browse') {
      $('tiers').innerHTML = '<span class="tier-pill tier-pill--on">全部职位 ' +
        shownTotal.toLocaleString('en-US') + '</span>' +
        '<span class="tier-note">未套用个人条件，只按职位要求浏览</span>';
      return;
    }
    if (lastResult.mode === 'eligible') {
      $('tiers').innerHTML = '<span class="tier-pill tier-pill--on">符合硬性条件 ' +
        shownTotal.toLocaleString('en-US') + '</span>' +
        '<span class="tier-note">专业未判断——填上专业后才分档</span>';
      return;
    }

    const t = lastResult.stats.byTier;
    const defs = [
      { key: 'all', label: '全部', count: lastResult.stats.total },
      { key: 'exact', label: SC.TIERS.exact.label, count: t.exact.count },
      { key: 'class', label: SC.TIERS.class.label, count: t.class.count },
      { key: 'category', label: SC.TIERS.category.label, count: t.category.count },
    ];
    $('tiers').innerHTML = defs.map(function (d) {
      const on = state.tierFilter === d.key;
      const dim = d.count === 0 && d.key !== 'all';
      return '<button type="button" class="tier-pill' + (on ? ' tier-pill--on' : '') +
        (dim ? ' tier-pill--off' : '') + '" data-tier="' + d.key + '">' +
        esc(d.label) + ' <span class="tier-pill__count">' +
        d.count.toLocaleString('en-US') + '</span></button>';
    }).join('');
  }

  function renderGroups() {
    const host = $('groups');
    const groups = visibleGroups();
    const hasAny = groups.some(function (g) { return g.list.length; });

    if (!hasAny) { host.innerHTML = emptyState(); return; }

    let firstSeal = firstRender;
    host.innerHTML = groups.map(function (g) {
      if (!g.list.length) return '';
      const def = SC.TIERS[g.tier];
      const cap = state.caps[g.tier] || CAP_STEP;
      const shown = g.list.slice(0, cap);
      const rest = g.list.length - shown.length;
      const people = g.list.reduce(function (a, r) { return a + r.headcount; }, 0);

      const cards = shown.map(function (r, i) {
        return cardHTML(r, g.tier, firstSeal && i < 6);
      }).join('');
      firstSeal = false;

      return '<section class="group">' +
        '<div class="group-head">' +
          '<h2 class="group-head__title">' + esc(def.label) + '</h2>' +
          '<span class="group-head__count">' + g.list.length.toLocaleString('en-US') +
            ' 个 / ' + people.toLocaleString('en-US') + ' 人</span>' +
          '<span class="group-head__desc">' + esc(def.desc) + '</span>' +
        '</div>' +
        '<div class="cards">' + cards + '</div>' +
        (rest > 0
          ? '<p style="margin:14px 0 0"><button type="button" class="btn" data-more="' +
            g.tier + '">再显示 ' + Math.min(rest, CAP_STEP) +
            ' 个（还有 ' + rest.toLocaleString('en-US') + ' 个未显示）</button></p>'
          : '') +
      '</section>';
    }).join('');
  }

  function emptyState() {
    if (state.onlySaved) {
      return '<div class="empty">' +
        '<p class="empty__title">还没有收藏任何职位</p>' +
        '<p class="empty__text">点职位卡右下角的「收藏」，收藏的职位会并排出现在这里对比。</p>' +
      '</div>';
    }

    if (state.search) {
      return '<div class="empty">' +
        '<p class="empty__title">没有搜到「' + esc(state.search) + '」</p>' +
        '<p class="empty__text">检索的是市州、系统类别、招录机关、内设机构、职位名称、' +
          '职位编码、专业栏、其他要求和备注。</p>' +
        '<ul class="empty__list">' +
          '<li>先用短一点的片段，例如只搜「天府新区」而不带上级机关全称</li>' +
          '<li>职位名称可能是「综合管理」「行政执法」这类通用词</li>' +
          '<li>搜之前先清掉左侧过窄的浏览筛选，否则会在一个小集合里空转</li>' +
        '</ul>' +
      '</div>';
    }

    const p = SC.buildProfile(state.profile);
    const ex = lastResult.stats.excluded || {};
    const top = Object.keys(ex).sort(function (a, b) { return ex[b] - ex[a]; }).slice(0, 6);
    const advice = [];

    if (p.cities.length) advice.push('取消市州限制');
    if (p.systems.length || p.exams.length) advice.push('放宽系统类别 / 考试类别');
    if (p.scopes.length || p.targets.length) advice.push('放宽考录范围 / 考录对象');
    if (p.eduReqs.length || p.degreeReqs.length || p.politicsReqs.length) {
      advice.push('放宽学历 / 学位 / 政治面貌要求');
    }
    if (p.flags.length || p.tags.length) advice.push('取消部分附加项和其他要求');
    if (p.minHeadcount) advice.push('降低招录名额下限');
    if (p.majorActive && !p.classes.length) advice.push('补勾专业类目');
    if (p.level) advice.push('核对「我的学历」');
    if (p.degree) advice.push('核对「我的学位」');
    if (p.politics) advice.push('核对政治面貌');
    if (p.gender) advice.push('取消性别限制');
    if (p.gradStatus) advice.push('核对应届身份');
    if (p.hukou) advice.push('核对户籍地');
    if (p.legalCert) advice.push('核对法律职业资格');
    if (p.english) advice.push('核对英语等级');
    if (p.accountingCert) advice.push('核对会计/审计资格');
    if (p.computerCert) advice.push('核对计算机资格');
    if (p.disabilityCert) advice.push('核对残疾人证');

    const title = lastResult.mode === 'browse' ? '当前浏览条件下没有职位'
      : lastResult.mode === 'eligible' ? '按已填的硬性条件没有职位'
      : '当前条件下没有可报职位';
    const desc = lastResult.mode === 'browse'
      ? '职位本身的要求收得太窄，可以逐项放宽。'
      : '被排除最多的原因如下，可据此放宽条件。';

    return '<div class="empty">' +
      '<p class="empty__title">' + esc(title) + '</p>' +
      '<p class="empty__text">' + esc(desc) + '</p>' +
      (top.length
        ? '<ul class="empty__list">' + top.map(function (k) {
            return '<li>' + esc(k) + ' <span class="num">' +
              ex[k].toLocaleString('en-US') + '</span></li>';
          }).join('') + '</ul>'
        : '') +
      (advice.length
        ? '<p class="empty__text" style="margin-top:14px">可以试试：' +
          advice.slice(0, 5).map(esc).join(' · ') + '</p>'
        : '') +
    '</div>';
  }

  /* ===================================================================
   * 职位卡
   * ===================================================================*/

  const GRID_ROWS = [
    ['市州', '市州'], ['系统类别', '系统类别'],
    ['考试类别', '考试类别'], ['招录名额', '招录名额'],
    ['学历', '学历'], ['学位', '学位'],
    ['政治面貌', '政治面貌'], ['拟任职务', '拟任职务'],
  ];

  /**
   * 卡片信息格：只列表里真写了的字段。
   * 定向招录那张表只有 9 列，没有考试类别、学历、学位、政治面貌、拟任职务、考录范围，
   * 补个「—」会被读成「不限」，所以整格省略；页面顶部另有说明。
   */
  function gridHTML(r) {
    let out = '';
    for (let i = 0; i < GRID_ROWS.length; i += 2) {
      for (let k = 0; k < 2; k++) {
        const pair = GRID_ROWS[i + k];
        if (!pair) break;
        const raw = r[pair[1]];
        if (raw === '' || raw == null) continue;
        const value = /^\d+$/.test(String(raw))
          ? '<span class="num">' + esc(raw) + '</span>' : esc(raw);
        out += '<dt>' + esc(pair[0]) + '</dt><dd>' + value + '</dd>';
      }
    }
    // 考录范围/考录对象是整段原文，单独成一行网格，免得挤在四列里
    let wide = '';
    if (r['考录范围']) wide += '<dt>考录范围</dt><dd>' + esc(r['考录范围']) + '</dd>';
    if (r['考录对象']) wide += '<dt>考录对象</dt><dd>' + esc(r['考录对象']) + '</dd>';
    return (out ? '<dl class="card__grid">' + out + '</dl>' : '') +
      (wide ? '<dl class="card__grid card__grid--wide">' + wide + '</dl>' : '');
  }

  /**
   * 考录信息：只列有内容的分项。
   * 笔试/面试开考比例、成绩占比、考察比例是全省统一的（考察比例 4,001 行全是「等额考察」），
   * 对选岗没有区分度，不占版面。
   * 487 行来自缺这几列的 4 个 sheet，值是空串——那是「表里没写」，不是「不需要」。
   */
  function examMetaHTML(r) {
    const rows = [];
    if (!r['加试专业'] && !r['加试心理测试'] && !r['加试民族语言']) {
      rows.push(['加试 / 体测', '本表未列此项']);
    } else {
      const adds = [];
      if (r['加试专业'] === '是') adds.push('专业科目');
      if (r['加试心理测试'] === '是') adds.push('心理测试');
      // 结构化列漏写了 16 行，值在「其他要求」原文里
      if (r.flags.minorityLang) adds.push('民族语言');
      rows.push(['加试', adds.length ? adds.join('、') : '无']);
      if (r['体能测评'] === '是') rows.push(['体能测评', '需要']);
    }
    if (r['民族自治州驻地'] === '是') rows.push(['驻地', '民族自治州']);
    if (r['审核单位']) rows.push(['审核单位', r['审核单位']]);
    rows.push(['咨询电话', r['咨询电话'] || '—']);

    return '<dl class="card__meta">' + rows.map(function (p) {
      return '<dt>' + esc(p[0]) + '</dt><dd>' + esc(p[1]) + '</dd>';
    }).join('') + '</dl>';
  }

  function tagsHTML(r) {
    if (!r.tags || !r.tags.length) return '';
    return '<div class="tags">' + r.tags.map(function (key) {
      const def = SC.TAG_DEFS.find(function (t) { return t.key === key; });
      if (!def) return '';
      const tone = def.tone === 'hard' ? 'hard' : (def.tone === 'warn' ? 'warn' : '');
      return '<span class="tag' + (tone ? ' tag--' + tone : '') +
        '" title="' + esc(SC.tagDesc(key)) + '">' + esc(SC.tagLabel(key)) + '</span>';
    }).join('') + '</div>';
  }

  function cardHTML(r, tier, animate) {
    const def = SC.TIERS[tier];
    const isSaved = saved.has(r.id);
    const tokens = tokensFromReasons(r.reasons);
    // 用表里的原文，不用 major.raw：后者在 unpack 时被 flat() 压掉了换行，
    // 「本科：…」和「研究生：…」会粘成「社会类研究生：…」
    const rawMajor = r['专业'] || r.major.raw || '';
    const sub = r['内设机构']
      ? r['内设机构'] + ' · ' + r['职位名称']
      : r['职位名称'];

    const sealCls = (tier === 'all' || tier === 'eligible') ? ' seal--search' : '';
    const dashed = (tier === 'category' || tier === 'eligible') ? ' seal--dashed' : '';

    return '<article class="card' + (isSaved ? ' card--saved' : '') + '" data-id="' + r.id + '">' +
      '<div class="card__top">' +
        '<div class="card__ident">' +
          '<h3 class="card__dept">' + esc(r['招录机关']) + '</h3>' +
          '<p class="card__post">' + esc(sub) + '</p>' +
          '<p class="card__code">' +
            '<span class="card__code-item"><span class="card__code-label">职位编码</span>' +
              '<span class="card__code-value">' + esc(r['职位编码']) + '</span>' +
              '<button type="button" class="card__copy" data-copy="' + esc(r['职位编码']) +
                '" aria-label="复制职位编码">复制</button></span>' +
          '</p>' +
        '</div>' +
        '<div class="seal' + (animate ? '' : ' seal--idle') + sealCls + dashed +
          '" aria-label="匹配档位：' + esc(def.label) + '">' +
          '<span>' + esc(def.stamp) + '</span>' +
        '</div>' +
      '</div>' +
      gridHTML(r) +
      (rawMajor || (r.reasons && r.reasons.length) ||
       (r.matchFlags && r.matchFlags.length)
        ? '<div class="card__major">' +
            (rawMajor
              ? '<span class="card__major-label">专业栏原文</span>' +
                '<p class="card__major-text">' + highlight(rawMajor, tokens) + '</p>'
              : '') +
            (r.reasons && r.reasons.length
              ? '<p class="card__why">' + esc(r.reasons.join('；')) + '</p>' : '') +
            (r.matchFlags && r.matchFlags.length
              ? r.matchFlags.map(function (f) {
                  return '<p class="card__why" style="color:#6B6F6A">' + esc(f) + '</p>';
                }).join('')
              : '') +
          '</div>'
        : '') +
      tagsHTML(r) +
      '<div class="card__foot">' +
        '<button type="button" class="card__more">职位简介 · 要求 · 联系方式</button>' +
        '<button type="button" class="card__save' + (isSaved ? ' card__save--on' : '') + '">' +
          (isSaved ? '★ 已收藏' : '☆ 收藏') + '</button>' +
      '</div>' +
      '<div class="card__remark" hidden>' +
        '<span class="card__remark-title">职位简介</span>' + esc(r['职位简介'] || '（无）') +
        '<span class="card__remark-title" style="margin-top:8px">其他要求</span>' +
          esc(r['其他要求'] || '（无）') +
        '<span class="card__remark-title" style="margin-top:8px">备注</span>' +
          esc(r['备注'] || '（无）') +
        '<span class="card__remark-title" style="margin-top:8px">考录信息</span>' +
          examMetaHTML(r) +
      '</div>' +
    '</article>';
  }

  /* ===================================================================
   * 分布统计
   * ===================================================================*/

  const DIST_TABS = [
    { key: 'cities', label: '市州' },
    { key: 'systems', label: '系统类别' },
    { key: 'exams', label: '考试类别' },
    { key: 'degrees', label: '学历' },
    { key: 'tags', label: '要求标签' },
    { key: 'excluded', label: '被排除原因' },
  ];

  function distStats() {
    const list = visibleList();
    return {
      cities: GK.topCounts(list, function (r) { return r['市州']; }),
      systems: GK.topCounts(list, function (r) { return r['系统类别']; }),
      exams: GK.topCounts(list, function (r) { return r['考试类别']; }),
      degrees: GK.topCounts(list, function (r) { return r['学历']; }),
      tags: GK.topCounts(
        list.reduce(function (acc, r) { return acc.concat(r.tags); }, []),
        function (t) { return SC.tagLabel(t); }
      ),
      excluded: lastResult.stats.excluded,
    };
  }

  function renderDist() {
    const host = $('dist');
    const stats = distStats();

    // 被排除原因只在有筛选意义时给入口；浏览全部时全是 0，留着反而误导
    const showExcluded = lastResult.mode !== 'browse' || Object.keys(stats.excluded).length;
    // 从「被排除原因」切回浏览模式时那一格会被藏掉，落到默认页
    if (state.distTab === 'excluded' && !showExcluded) state.distTab = 'cities';

    const rows = state.distTab === 'excluded'
      ? rowsOf(stats.excluded)
      : (stats[state.distTab] || []).map(function (e) { return [e.name, e.count]; });

    host.hidden = false;
    $('dist-tabs').innerHTML = DIST_TABS.filter(function (t) {
      return t.key !== 'excluded' || showExcluded;
    }).map(function (t) {
      return '<button type="button" class="dist__tab' +
        (state.distTab === t.key ? ' dist__tab--on' : '') +
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
        '<span class="dist__bar"><span style="width:' +
          Math.max(1.5, (e[1] / max) * 100).toFixed(1) + '%"></span></span>' +
        '<span class="dist__count">' + e[1].toLocaleString('en-US') + '</span>' +
      '</div>';
    }).join('');
  }

  function rowsOf(obj) {
    return Object.keys(obj || {}).map(function (k) { return [k, obj[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; });
  }

  /* ===================================================================
   * 收藏抽屉与对比
   * ===================================================================*/

  const COMPARE_ROWS = [
    ['市州', '市州'], ['系统类别', '系统类别'], ['招录机关', '招录机关'],
    ['内设机构', '内设机构'], ['职位名称', '职位名称'], ['考试类别', '考试类别'],
    ['拟任职务', '拟任职务'], ['招录名额', '招录名额'], ['考录范围', '考录范围'],
    ['考录对象', '考录对象'], ['学历', '学历'], ['学位', '学位'],
    ['政治面貌', '政治面貌'], ['其他要求', '其他要求'],
  ];

  function renderDrawer() {
    $('drawer-count').textContent = saved.size;
    const body = $('drawer-body');

    if (!saved.size) {
      body.innerHTML = '<p class="drawer__empty">还没有收藏。在职位卡上点「☆ 收藏」，' +
        '收藏的职位会在这里并排对比，差异项自动标出。</p>';
      return;
    }

    const picked = Array.from(saved).map(function (id) { return records[id]; })
      .filter(Boolean).slice(0, 4);
    const profile = SC.buildProfile(state.profile);

    let html = '<table class="compare"><thead><tr><th class="rowhead">共 ' +
      (saved.size > 4 ? '4 / ' + saved.size : saved.size) + ' 个</th>';
    picked.forEach(function (r) {
      html += '<th>' + esc(r['招录机关']) +
        '<button type="button" class="compare__remove" data-unsave="' + r.id + '">移除</button>' +
        '<div style="font-weight:400;color:#6B6F6A;font-size:12px">' +
          esc(r['职位名称']) + '</div></th>';
    });
    html += '</tr></thead><tbody>';

    html += '<tr><th class="rowhead">当前条件下</th>';
    picked.forEach(function (r) {
      const m = SC.matchRow(r, profile);
      if (profile.majorActive) {
        html += m.ok
          ? '<td><span style="color:#A8201A;font-family:var(--serif);font-weight:700">' +
              esc(SC.TIERS[m.tier].label) + '</span>' +
              (m.reasons && m.reasons.length
                ? '<div style="font-size:12px;color:#6B6F6A">' +
                  esc(m.reasons.join('；')) + '</div>' : '') + '</td>'
          : '<td><span style="color:#6B6F6A">不符合当前条件</span>' +
              (m.flags && m.flags.length
                ? '<div style="font-size:12px;color:#6B6F6A">' +
                  esc(m.flags.join('；')) + '</div>' : '') + '</td>';
      } else if (SC.personalActive(profile)) {
        html += m.ok
          ? '<td><span style="color:#1E3A5C">符合硬性条件</span>' +
              '<div style="font-size:12px;color:#6B6F6A">专业未判断</div></td>'
          : '<td><span style="color:#6B6F6A">不符合：' + esc(m.why) + '</span></td>';
      } else {
        html += '<td><span style="color:#6B6F6A">未判断（浏览模式）</span></td>';
      }
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

    html += '<tr><th class="rowhead">专业栏原文</th>';
    picked.forEach(function (r) {
      html += '<td style="max-width:320px">' + highlight(r['专业'] || r.major.raw, []) + '</td>';
    });
    html += '</tr>';

    html += '<tr><th class="rowhead">要求标签</th>';
    picked.forEach(function (r) {
      const labels = (r.tags || []).map(function (k) { return SC.tagLabel(k); });
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
    const list = visibleList();
    if (!list.length) { alert('当前没有可导出的职位。'); return; }
    download('四川省考职位筛选_' + stamp() + '.csv', SC.toCSV(list),
      'text/csv;charset=utf-8');
  }

  /* ===================================================================
   * 事件
   * ===================================================================*/

  const onFormChange = debounce(function () {
    state.caps = { all: CAP_STEP, exact: CAP_STEP, class: CAP_STEP,
      category: CAP_STEP, eligible: CAP_STEP };
    render();
  }, 120);

  function bind() {
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

    $('f-major-sugg').addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-add-lei]');
      if (!btn) return;
      pickers.classes.add(btn.getAttribute('data-add-lei'));
      renderSuggestion();
      onFormChange();
    });

    $('f-search').addEventListener('input', debounce(function () {
      state.search = $('f-search').value;
      state.caps = { all: CAP_STEP, exact: CAP_STEP, class: CAP_STEP,
        category: CAP_STEP, eligible: CAP_STEP };
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

    $('tiers').addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-tier]');
      if (!btn) return;
      state.tierFilter = btn.getAttribute('data-tier');
      render();
    });

    $('dist-tabs').addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-dist]');
      if (!btn) return;
      state.distTab = btn.getAttribute('data-dist');
      persist();
      renderDist();
    });

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
        expand.textContent = panel.hidden ? '职位简介 · 要求 · 联系方式' : '收起简介与要求';
      }
    });

    $('drawer-bar').addEventListener('click', toggleDrawer);
    $('drawer-bar').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDrawer(); }
    });
    $('drawer-body').addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-unsave]');
      if (btn) toggleSave(parseInt(btn.getAttribute('data-unsave'), 10));
    });

    $('btn-csv').addEventListener('click', exportCSV);
    $('btn-print').addEventListener('click', function () { window.print(); });
    $('btn-reset').addEventListener('click', function () {
      if (!confirm('清空全部筛选条件？收藏的职位会保留。')) return;
      state.profile = Object.assign({}, SC.DEFAULT_PROFILE);
      state.search = '';
      state.tierFilter = 'all';
      state.onlySaved = false;
      state.sort = 'region';
      $('f-search').value = '';
      $('f-onlysaved').checked = false;
      $('f-sort').value = 'region';
      writeForm(state.profile);
      render();
    });

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

  function failLoad(title, hint) {
    $('loading').innerHTML = '<p class="loading__title">' + esc(title) + '</p>' +
      '<p class="loading__hint">' + hint + '</p>' +
      '<p class="loading__hint">如果改过数据文件，按 Ctrl+F5 强制刷新一次。</p>';
  }

  function init() {
    DATA = window.SC_DATA;
    if (!DATA || !DATA.meta) {
      failLoad('数据没能载入', '请确认 data/sc_positions.js 与 sc.html 在同一目录下。');
      return;
    }
    try {
      initBody();
    } catch (err) {
      // 遮罩底下藏着一句报错就没人看得见了：把原始信息和出错位置摊在页面上
      const frame = String(err && err.stack || '').split('\n')
        .filter(function (l) { return /sc_app\.js|sc_match\.js|match\.js/.test(l); })[0] || '';
      failLoad('页面初始化出错', esc(String(err && err.message || err)) +
        (frame ? '<br><span class="num">' + esc(frame.trim()) + '</span>' : ''));
      throw err;
    }
    $('loading').hidden = true;
  }

  function initBody() {
    records = SC.unpack(DATA);

    restore();
    buildSidebar();
    writeForm(state.profile);
    $('f-sort').value = state.sort;
    bind();
    render();
    renderSuggestion();
  }

  function boot() {
    let started = false;
    function start() {
      if (started) return;
      started = true;
      init();
    }

    const s = document.createElement('script');
    // 带一个时间戳参数：Edge/Chrome 对 file:// 也走启发式缓存，重新构建数据后
    // 普通刷新可能还拿旧文件。每次加载都当作新地址，就不会读到过期的那份
    s.src = 'data/sc_positions.js?v=' + Date.now();
    s.onload = function () {
      requestAnimationFrame(function () { requestAnimationFrame(start); });
      setTimeout(start, 400);
    };
    s.onerror = function () {
      $('loading').innerHTML = '<p class="loading__title">找不到 data/sc_positions.js</p>' +
        '<p class="loading__hint">先运行：python build_sc_data.py "2027四川省考岗位汇总表.xlsx" ' +
        '"四川省2027年度公开考试录用公务员职位情况表).xlsx"</p>';
    };
    document.body.appendChild(s);
    $('loading-hint').textContent = '读取 data/sc_positions.js …';
    setTimeout(function () {
      if (!started) {
        $('loading-hint').textContent = '数据脚本未响应 —— 请确认 data/sc_positions.js 存在，' +
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
