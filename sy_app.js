/**
 * sy_app.js —— 事业单位页面的状态、选择范围、渲染、收藏对比、统计、导出
 *
 * 和省考页面（sc_app.js）是两份代码：字段不同、档位含义不同，
 * 「招聘范围」还是一整句自由文本，硬套一份会到处是 if。
 * 共用的只有 styles.css 的排版与 match.js 的文本工具。
 *
 * 页面打开先落在「选择范围」：全省汇总表含省直属和 21 个市州，
 * 可以看某一个市州，也可以看全省。选择存在本机，下次直接进上次的范围。
 */
(function () {
  'use strict';

  const SY = window.SYMatch;
  const GK = window.GKMatch;
  const $ = function (id) { return document.getElementById(id); };
  const STORE_KEY = 'sy2026.state.v1';
  // 收藏存岗位编码：重建数据后行序会变，存序号会指到别的岗位上
  const SAVED_KEY = 'sy2026.saved.v1';
  const CAP_STEP = 200;
  const reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let records = null;
  let DATA = null;
  let lastResult = null;
  let firstRender = true;
  let favOpen = false;
  const saved = new Set();

  const state = {
    scope: null,          // null = 还没选；'' = 四川全省；否则是市州名
    profile: null,
    sort: 'region',
    search: '',
    tierFilter: 'all',
    onlySaved: false,
    distTab: 'counties',
    caps: { all: CAP_STEP, exact: CAP_STEP, class: CAP_STEP, category: CAP_STEP, eligible: CAP_STEP },
  };

  const ARRAY_KEYS = ['classes', 'identities', 'counties', 'jobCats', 'exams',
    'ranges', 'eduReqs', 'degreeReqs', 'certReqs', 'services', 'areaTags'];

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

  /** 「命中本科阶段专业名称：汉语言文学」 -> 汉语言文学 */
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

  function resetCaps() {
    return { all: CAP_STEP, exact: CAP_STEP, class: CAP_STEP,
      category: CAP_STEP, eligible: CAP_STEP };
  }

  /* ===================================================================
   * 持久化
   * ===================================================================*/

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        v: 1, scope: state.scope, profile: state.profile,
        sort: state.sort, distTab: state.distTab,
      }));
      localStorage.setItem(SAVED_KEY, JSON.stringify(Array.from(saved).map(function (id) {
        const r = records[id];
        return r && r['岗位编码'];
      }).filter(Boolean)));
    } catch (e) { /* 隐私模式无存储时静默降级 */ }
  }

  function restore() {
    let store = {};
    try {
      store = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {};
      const byCode = new Map();
      records.forEach(function (r) { byCode.set(String(r['岗位编码']), r.id); });
      JSON.parse(localStorage.getItem(SAVED_KEY) || '[]').forEach(function (code) {
        const id = byCode.get(String(code));
        if (id !== undefined) saved.add(id);
      });
    } catch (e) { /* 存档坏了就当没有 */ }

    // 没存过 scope（首次打开）和存了空串（四川全省）是两回事
    if (Object.prototype.hasOwnProperty.call(store, 'scope')) {
      const sc = store.scope;
      if (sc === null || sc === '' ||
          (typeof sc === 'string' && DATA.meta.cities.some(function (c) { return c.name === sc; }))) {
        state.scope = sc;
      }
    }

    const p = Object.assign({}, SY.DEFAULT_PROFILE, store.profile || {});
    ARRAY_KEYS.forEach(function (k) { if (!Array.isArray(p[k])) p[k] = []; });
    state.profile = p;
    if (store.sort) state.sort = store.sort;
    if (store.distTab) state.distTab = store.distTab;
  }

  /* ===================================================================
   * 范围选择
   * ===================================================================*/

  function scopeRecords() {
    if (!records) return [];
    if (!state.scope) return records;
    return records.filter(function (r) { return r['市州'] === state.scope; });
  }

  function renderCityPicker() {
    const cities = DATA.meta.cities;
    const total = records.length;
    const people = records.reduce(function (a, r) { return a + r.headcount; }, 0);

    const card = function (scope, name, subtitle, count, headcount, extraCls) {
      return '<button type="button" class="citycard' + (extraCls ? ' ' + extraCls : '') +
        '" data-scope="' + esc(scope) + '">' +
        '<span class="citycard__head">' +
          '<span class="citycard__name">' + esc(name) + '</span>' +
          '<span class="citycard__go">进入检索 →</span>' +
        '</span>' +
        '<span class="citycard__title">' + esc(subtitle) + '</span>' +
        '<span class="citycard__stats">' +
          '<span class="citycard__stat"><b>' + count + '</b> 个岗位</span>' +
          '<span class="citycard__stat"><b>' + headcount + '</b> 人</span>' +
        '</span>' +
      '</button>';
    };

    let html = card('', '四川全省', '21 个市州 + 省直属 · 22 份岗位表一起检索',
      total, people, 'citycard--all');
    html += cities.map(function (c) {
      const subtitle = c.name === '省直属'
        ? '省级部门所属事业单位 · ' + c.units + ' 个单位'
        : c.units + ' 个招聘单位 · ' + c.counties + ' 个县（市、区）';
      return card(c.name, c.name, subtitle, c.count, c.headcount);
    }).join('');

    $('citypick-grid').innerHTML = html;

    const restricted = restrictedCount();
    const unknown = records.filter(function (r) { return r.range.unknown; }).length;
    const open = records.filter(function (r) {
      return !r.range.restricted && !r.range.unknown;
    }).length;
    $('citypick-foot').innerHTML = '全省汇总表共 <b>' + total.toLocaleString('en-US') +
      '</b> 个岗位：<b>' + open.toLocaleString('en-US') +
      '</b> 个写「面向全国招聘 / 面向全国 / 无」，不限对象；<b>' +
      restricted.toLocaleString('en-US') + '</b> 个限定了招聘对象、户籍或基层项目' +
      '（部属公费师范生、退役军人、残疾人、乡村医生、' +
      '村社区党组织书记、本地户籍等）' +
      (unknown ? '，另有 ' + unknown + ' 个写「详见公告正文」' : '') +
      '。选择范围只决定先看哪部分岗位，不会过滤掉这些岗位。';
  }

  /** 招聘范围至少有一种限定（对象、户籍、基层项目、应届身份）就算受限 */
  function restrictedCount(list) {
    const rows = list || records;
    return rows.filter(function (r) { return r.range.restricted; }).length;
  }

  function openCityPicker() {
    renderCityPicker();
    $('citypick').hidden = false;
    document.body.classList.add('citypick-open');
    ['.shell', '.masthead', '.scopebar'].forEach(function (sel) {
      const el = document.querySelector(sel);
      if (el) el.inert = true;
    });
    $('drawer').inert = true;
    const first = $('citypick-grid').querySelector('.citycard');
    if (first) first.focus();
  }

  function closeCityPicker() {
    // 第一次打开时还没选，Esc 不能把用户留在一个空白页上
    if (state.scope === null) return;
    $('citypick').hidden = true;
    document.body.classList.remove('citypick-open');
    ['.shell', '.masthead', '.scopebar'].forEach(function (sel) {
      const el = document.querySelector(sel);
      if (el) el.inert = false;
    });
    $('drawer').inert = false;
    $('btn-city').focus();
  }

  function chooseCity(scope) {
    if (scope === null) return;
    state.scope = scope;
    // 换范围后，原来勾的区县、市州可能已经不在当前表里
    state.profile.counties = [];
    state.profile.city = '';
    state.search = '';
    state.onlySaved = false;
    state.tierFilter = 'all';
    state.caps = resetCaps();
    if (pickers.counties) pickers.counties.set([]);
    $('f-city').value = '';
    $('f-search').value = '';
    $('f-onlysaved').checked = false;

    closeCityPicker();
    refreshSidebarData();
    writeForm(state.profile);
    applyCityFilter();
    renderScope();
    render();
  }

  function renderScope() {
    const city = DATA.meta.cities.find(function (c) { return c.name === state.scope; });
    const list = scopeRecords();
    const people = list.reduce(function (a, r) { return a + r.headcount; }, 0);
    const countyCount = new Set(list.map(function (r) { return r['县市区']; })
      .filter(Boolean)).size;
    const areaText = countyCount
      ? countyCount + ' 个县（市、区）'
      : (city ? city.units + ' 个招聘单位' : '');

    $('scope-name').textContent = city ? city.name : '四川全省';
    $('scope-detail').textContent =
      (city ? (city.title || (city.name + '事业单位岗位表'))
        : '21 个市州 + 省直属 · 22 份岗位表') +
      ' · ' + list.length.toLocaleString('en-US') + ' 个岗位 / ' +
      people.toLocaleString('en-US') + ' 人' +
      (areaText ? ' / ' + areaText : '');

    document.title = (city ? city.name : '四川全省') +
      '事业单位选岗器 · 2026 年下半年';
    $('masthead-eyebrow').textContent = city
      ? city.name + ' · 2026 年下半年事业单位招聘'
      : '2026 年下半年四川省事业单位公开招聘';
    $('masthead-title').textContent = city
      ? city.name + '事业单位 · 岗位检索'
      : '四川事业单位 · 岗位检索';

    const totalPeople = records.reduce(function (a, r) { return a + r.headcount; }, 0);
    $('masthead-meta').innerHTML = '数据来源：' +
      DATA.meta.sources.map(esc).join(' · ') + ' · 共 <b>' +
      records.length.toLocaleString('en-US') + '</b> 个岗位 / <b>' +
      totalPeople.toLocaleString('en-US') + '</b> 人';
  }

  /* ===================================================================
   * 侧栏
   * ===================================================================*/

  function countsOf(field) {
    const map = new Map();
    scopeRecords().forEach(function (r) {
      const v = r[field];
      if (!v) return;
      map.set(v, (map.get(v) || 0) + 1);
    });
    return Array.from(map.entries()).sort(function (a, b) { return b[1] - a[1]; });
  }

  function countBy(fn) {
    let n = 0;
    scopeRecords().forEach(function (r) { if (fn(r)) n += 1; });
    return n;
  }

  function checkboxHTML(items, name) {
    return items.map(function (it) {
      const value = it[0];
      const label = it[1];
      const count = it[2] || 0;
      return '<label class="check" title="' + esc(value) + '"><input type="checkbox" name="' + name +
        '" value="' + esc(value) + '"> ' + esc(label) +
        (count ? ' <span class="num" style="color:#A9A69C">' + count + '</span>' : '') +
        '</label>';
    }).join('');
  }

  function identityHTML() {
    return SY.IDENTITY_DEFS.map(function (d) {
      return '<label class="check" title="' + esc(d.desc) + '">' +
        '<input type="checkbox" name="identities" value="' + esc(d.key) + '"> ' +
        esc(d.label) + '</label>';
    }).join('');
  }

  const pickers = {};

  function buildPicker(opts) {
    const list = $(opts.listId);
    const search = $(opts.searchId);
    const chips = opts.chipsId ? $(opts.chipsId) : null;

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

    function renderItems(items) {
      const picked = new Set(api.values());
      if (!items.length) {
        list.innerHTML = '<p class="leipicker__empty">没有可选项</p>';
        syncChips();
        return;
      }
      list.innerHTML = items.map(function (it) {
        return '<label class="lei" data-name="' + esc(it.value) + '">' +
          '<input type="checkbox" value="' + esc(it.value) + '">' +
          '<span class="lei__name">' + esc(it.label) + '</span>' +
          '<span class="lei__count">' + (it.count || 0) + '</span></label>';
      }).join('');
      if (picked.size) {
        Array.prototype.forEach.call(list.querySelectorAll('input'), function (input) {
          if (picked.has(input.value)) input.checked = true;
        });
      }
      syncChips();
    }

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

    api.setItems = renderItems;
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

    renderItems(opts.items || []);
    pickers[opts.key] = api;
    return api;
  }

  /**
   * 县市区列表跟着市州与当前范围变；专业类目词表由数据构建时汇总。
   * 选了市州时直接用 DATA.counties 的 (市州, 县市区) 计数：全省列表把各市的
   * 「市本级」合并成一条，而分市后必须拆开，否则计数会算成全省合计。
   */
  function countyItems() {
    const city = $('f-city') ? $('f-city').value : '';
    if (city) {
      return DATA.counties
        .filter(function (e) { return e[2] === city; })
        .map(function (e) { return { value: e[0], label: e[0], count: e[1] }; });
    }
    return countsOf('县市区').map(function (e) {
      return { value: e[0], label: e[0], count: e[1] };
    });
  }

  /** 把市州选择同步到区县列表：标题、候选、已勾但不在本市的值 */
  function applyCityFilter() {
    // 单个市州范围里，市州筛选没有意义；存档里带来的旧值也在这里清掉
    if (state.scope) $('f-city').value = '';
    const city = $('f-city').value;
    $('f-county-title').textContent = city === '省直属'
      ? '省直属没有区县'
      : (city ? city + ' · 区县' : '全部区县');
    $('f-county-search').value = '';
    $('f-county-search').placeholder = city ? '在' + city + '内搜索' : '搜索，如 三台';
    if (pickers.counties) pickers.counties.setItems(countyItems());
    $('row-city').hidden = !!state.scope;
  }

  function refreshSidebarData() {
    if (!records) return;
    if (pickers.counties) pickers.counties.setItems(countyItems());

    $('f-jobcats').innerHTML = checkboxHTML(countsOf('岗位类别').map(function (e) {
      return [e[0], e[0], e[1]];
    }), 'jobCats');

    $('f-exams').innerHTML = checkboxHTML(countsOf('考试科目').map(function (e) {
      return [e[0], e[0], e[1]];
    }), 'exams');

    $('f-ranges').innerHTML = checkboxHTML(SY.IDENTITY_DEFS.map(function (d) {
      const label = d.key === 'veteran' ? '退役军人（含退役大学生士兵）' : d.label;
      return [d.key, label,
        countBy(function (r) { return SY.rangeHit(r, d.key); })];
    }), 'ranges');

    $('f-edureqs').innerHTML = checkboxHTML(countsOf('学历要求').map(function (e) {
      return [e[0], e[0], e[1]];
    }), 'eduReqs');

    $('f-degreereqs').innerHTML = checkboxHTML(countsOf('学位要求').map(function (e) {
      return [e[0], e[0], e[1]];
    }), 'degreeReqs');

    $('f-certreqs').innerHTML = checkboxHTML(countsOf('教资要求').map(function (e) {
      return [e[0], e[0] === '不限' ? '不限（不要求）' : e[0], e[1]];
    }), 'certReqs');

    $('f-services').innerHTML = checkboxHTML(
      countsOf('服务期年数').sort(function (a, b) { return Number(b[0]) - Number(a[0]); })
        .map(function (e) { return [e[0], e[0] + ' 年', e[1]]; }),
      'services');

    $('f-areatags').innerHTML = checkboxHTML(
      ['provinceService', 'cityService', 'countyService'].map(function (key) {
        return [key, SY.tagLabel(key), countBy(function (r) { return r.tags.indexOf(key) >= 0; })];
      }).filter(function (e) { return e[2] > 0; }),
      'areaTags');
  }

  function fillServicePlace() {
    const groups = {};
    DATA.counties.forEach(function (e) {
      const name = e[0];
      const city = e[2];
      if (name === '市本级') return;   // 基层服务不会落在「市本级」
      if (!groups[city]) groups[city] = [];
      groups[city].push(e);
    });
    let html = '<option value="" selected>不填</option>';
    DATA.meta.cities.forEach(function (c) {
      const list = groups[c.name];
      if (!list || !list.length) return;
      html += '<optgroup label="' + esc(c.name) + '">' +
        list.map(function (e) {
          return '<option value="' + esc(e[0]) + '">' + esc(e[0]) + '</option>';
        }).join('') + '</optgroup>';
    });
    html += '<option value="' + SY.PLACE_OTHER + '">四川省内其他地区</option>' +
      '<option value="' + SY.PLACE_OUTSIDE + '">四川省外</option>';
    $('f-serviceplace').innerHTML = html;
  }

  function buildSidebar() {
    $('f-city').innerHTML = '<option value="" selected>全部市州</option>' +
      DATA.meta.cities.map(function (c) {
        return '<option value="' + esc(c.name) + '">' + esc(c.name) + '</option>';
      }).join('');
    $('f-city').addEventListener('change', function () {
      applyCityFilter();
      onFormChange();
    });

    buildPicker({
      key: 'counties', listId: 'f-county-list', searchId: 'f-county-search',
      chipsId: 'f-county-chips', items: countyItems(),
    });

    buildPicker({
      key: 'classes', listId: 'f-lei-list', searchId: 'f-lei-search',
      chipsId: 'f-lei-chips',
      items: DATA.leiVocab.map(function (e) {
        return { value: e[0], label: e[0], count: e[1] };
      }),
    });

    $('f-identities').innerHTML = identityHTML();
    fillServicePlace();
    refreshSidebarData();
  }

  /* ===================================================================
   * 表单读写
   * ===================================================================*/

  function readForm() {
    return {
      level: $('f-level').value,
      degree: $('f-degree').value,
      cert: $('f-cert').value,
      majorText: $('f-major').value,
      majorCodes: $('f-codes').value,
      classes: pickers.classes ? pickers.classes.values() : [],
      identities: chosen($('f-identities')),
      servicePlace: $('f-serviceplace').value,
      city: $('f-city').value,
      counties: pickers.counties ? pickers.counties.values() : [],
      jobCats: chosen($('f-jobcats')),
      exams: chosen($('f-exams')),
      ranges: chosen($('f-ranges')),
      eduReqs: chosen($('f-edureqs')),
      degreeReqs: chosen($('f-degreereqs')),
      certReqs: chosen($('f-certreqs')),
      services: chosen($('f-services')),
      minHeadcount: parseInt($('f-headcount').value, 10) || 0,
    };
  }

  function writeForm(p) {
    $('f-level').value = p.level || '';
    $('f-degree').value = p.degree || '';
    $('f-cert').value = p.cert || '';
    $('f-major').value = p.majorText || '';
    $('f-codes').value = p.majorCodes || '';
    $('f-serviceplace').value = p.servicePlace || '';
    $('f-city').value = p.city || '';
    $('f-headcount').value = String(p.minHeadcount || 0);

    setChecked($('f-identities'), p.identities);
    setChecked($('f-jobcats'), p.jobCats);
    setChecked($('f-exams'), p.exams);
    setChecked($('f-ranges'), p.ranges);
    setChecked($('f-edureqs'), p.eduReqs);
    setChecked($('f-degreereqs'), p.degreeReqs);
    setChecked($('f-certreqs'), p.certReqs);
    setChecked($('f-services'), p.services);
    setChecked($('f-areatags'), p.areaTags);
    if (pickers.classes) pickers.classes.set(p.classes);
    if (pickers.counties) pickers.counties.set(p.counties);
  }

  function setChecked(container, values) {
    if (!container) return;
    const want = new Set(values || []);
    container.querySelectorAll('input[type="checkbox"]').forEach(function (i) {
      i.checked = want.has(i.value);
    });
  }

  function renderSuggestion() {
    const box = $('f-major-sugg');
    const text = ($('f-major').value + ' ' + $('f-codes').value).trim();
    if (!text) { box.textContent = ''; return; }
    if (!pickers.classes) return;

    const all = SY.suggestClasses(text, DATA);
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
    box.textContent = '推不出类目也没关系：表里多数岗位按具体专业名匹配，直接填上方专业名称即可。';
  }

  /* ===================================================================
   * 渲染
   * ===================================================================*/

  function render() {
    if (state.scope === null) return;
    const raw = readForm();
    state.profile = raw;
    const t0 = performance.now();
    lastResult = SY.filterRecords(records, raw, {
      search: state.search, sort: state.sort, scope: state.scope || '',
    });
    const elapsed = Math.round(performance.now() - t0);

    persist();
    renderTally();
    renderNotices();
    renderTiers();
    renderGroups();
    renderDist();
    renderDrawer();
    if (favOpen) renderFavPage();
    renderSuggestion();

    $('live').textContent = ({
      browse: '浏览', eligible: '筛选', match: '匹配',
    }[lastResult.mode] || '筛选') + '完成，' + lastResult.stats.total + ' 个岗位';

    if (state.onlySaved) {
      $('tally-aside').textContent =
        '只看已收藏（共 ' + lastResult.stats.total.toLocaleString('en-US') + ' 个）';
    } else if (lastResult.mode === 'browse') {
      $('tally-aside').textContent = '浏览 ' +
        scopeRecords().length.toLocaleString('en-US') + ' 个岗位 · ' +
        (elapsed < 1 ? '不足 1' : elapsed) + ' ms';
    } else {
      $('tally-aside').textContent = '在 ' +
        scopeRecords().length.toLocaleString('en-US') + ' 个岗位中筛出 · ' +
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
      lastResult.mode === 'browse' ? '岗位' :
      lastResult.mode === 'eligible' ? '符合硬性条件' : '可报岗位';
    $('tally-exact-item').hidden = !isMatch;
  }

  function renderNotices() {
    const box = $('notices');
    const p = SY.buildProfile(state.profile);
    const out = [];
    const scopeName = state.scope || '四川全省';
    const scoped = scopeRecords();
    const restricted = restrictedCount(scoped);
    const unknown = scoped.filter(function (r) { return r.range.unknown; }).length;

    if (lastResult.mode === 'browse') {
      out.push({
        tone: 'info',
        text: '你还没有填写任何个人条件，正在<b>浏览' + esc(scopeName) + '的 ' +
          scoped.length.toLocaleString('en-US') + ' 个岗位</b>。' +
          '左侧「浏览筛选」只按岗位本身的要求收窄，' +
          '不会因为你不符合而排除。',
      });
      out.push({
        tone: '',
        text: '全省汇总表里大多数岗位写<b>「面向全国招聘」</b>：' +
          scoped.length.toLocaleString('en-US') + ' 个岗位中有 ' +
          restricted.toLocaleString('en-US') + ' 个限定了招聘对象、户籍或基层项目' +
          (unknown ? '，另有 ' + unknown + ' 个写「详见公告正文」' : '') +
          '。你还没勾「我的身份」，所以这部分没有被判断。' +
          '先看卡片上的标签，或在左侧「招聘对象」里只看某一类。',
      });
      box.innerHTML = noticeHTML(out);
      return;
    }

    if (lastResult.mode === 'eligible') {
      out.push({
        tone: 'info',
        text: '已按你填的学历、学位、教师资格证、身份、基层服务地判断；' +
          '留空的项一律不排除。专业还没填，所以<b>没有判断专业是否符合</b>——' +
          '这一档只能当作「硬性条件过关」的候选。',
      });
    } else {
      if (p.majorLevelAssumed) {
        out.push({
          tone: 'info',
          text: '「我的学历」没填，专业暂按<b>本科阶段</b>匹配。' +
            '岗位专业栏分「大专：…／本科：…／研究生：…」，填上学历会更准。',
        });
      }
      if (!p.classes.length) {
        out.push({
          tone: 'info',
          text: '没有勾选专业类目，现在只按专业名称和代码匹配。' +
            '这份全省表多数岗位写具体专业名或专业类，不勾类目通常也够用。',
        });
      }
      if (lastResult.stats.byTier.category.count) {
        out.push({
          tone: 'info',
          text: '「门类命中」包含专业不限、门类级匹配的岗位，范围较宽，建议逐条核对专业栏。',
        });
      }
    }

    if (!p.rangeActive) {
      out.push({
        tone: '',
        text: '你还没勾「我的身份」，<b>「招聘范围」没有参与判断</b>。' +
          '多数岗位不限对象；限对象、户籍或基层项目的岗位在卡片上有标签，' +
          '请对照「招聘范围」原文自行核对。',
      });
    } else if (!p.servicePlace && (p.identitySet.has('sanZhi') || p.identitySet.has('xiBu'))) {
      out.push({
        tone: 'info',
        text: '你勾了基层项目身份，但没填「基层服务地」。' +
          '要求「本县」「某县」「某市」完成服务的岗位只提示、没有排除；' +
          '填上服务地后才会按地域判断。',
      });
    }

    if (p.cert) {
      out.push({
        tone: 'info',
        text: '教师资格证只按学段判断（高中证可报小学、初中岗）。' +
          '岗位要求的<b>学科</b>是否与你的证书一致，需要自己核对。',
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
    const shownTotal = state.onlySaved ? visibleList().length : lastResult.stats.total;
    if (lastResult.mode === 'browse') {
      $('tiers').innerHTML = '<span class="tier-pill tier-pill--on">全部岗位 ' +
        shownTotal.toLocaleString('en-US') + '</span>' +
        '<span class="tier-note">未套用个人条件，只按岗位要求浏览</span>';
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
      { key: 'exact', label: SY.TIERS.exact.label, count: t.exact.count },
      { key: 'class', label: SY.TIERS.class.label, count: t.class.count },
      { key: 'category', label: SY.TIERS.category.label, count: t.category.count },
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
      const def = SY.TIERS[g.tier];
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
        '<p class="empty__title">还没有收藏任何岗位</p>' +
        '<p class="empty__text">点岗位卡右下角的「收藏」，收藏的岗位会并排出现在这里对比。</p>' +
      '</div>';
    }

    if (state.search) {
      return '<div class="empty">' +
        '<p class="empty__title">没有搜到「' + esc(state.search) + '」</p>' +
        '<p class="empty__text">检索的是市州、县市区、招聘单位、岗位名称、岗位编码、' +
          '专业栏、招聘范围、备注和咨询电话。</p>' +
        '<ul class="empty__list">' +
          '<li>先用短一点的片段，例如只搜「三台」而不带单位全称</li>' +
          '<li>岗位名称可能是「语文教师」「工作人员」这类通用词</li>' +
          '<li>搜之前先清掉左侧过窄的浏览筛选，否则会在一个小集合里空转</li>' +
        '</ul>' +
      '</div>';
    }

    const p = SY.buildProfile(state.profile);
    const ex = lastResult.stats.excluded || {};
    const top = Object.keys(ex).sort(function (a, b) { return ex[b] - ex[a]; }).slice(0, 6);
    const advice = [];

    if (p.counties.length) advice.push('取消县市区限制');
    if (p.jobCats.length || p.exams.length) advice.push('放宽岗位类别 / 考试科目');
    if (p.ranges.length) advice.push('放宽招聘对象');
    if (p.eduReqs.length || p.degreeReqs.length || p.certReqs.length) {
      advice.push('放宽学历 / 学位 / 教师资格证要求');
    }
    if (p.services.length || p.minHeadcount) advice.push('放宽最低服务期 / 招聘名额');
    if (p.majorActive && !p.classes.length) advice.push('补勾专业类目');
    if (p.identities.length) advice.push('核对「我的身份」');
    if (p.servicePlace) advice.push('核对基层服务地');
    if (p.level) advice.push('核对「我的学历」');
    if (p.degree) advice.push('核对「我的学位」');
    if (p.cert) advice.push('核对教师资格证学段');

    const title = lastResult.mode === 'browse' ? '当前浏览条件下没有岗位'
      : lastResult.mode === 'eligible' ? '按已填的硬性条件没有岗位'
      : '当前条件下没有可报岗位';
    const desc = lastResult.mode === 'browse'
      ? '岗位本身的要求收得太窄，可以逐项放宽。'
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
   * 岗位卡
   * ===================================================================*/

  /** 卡片上只写「中江县」看不出是哪个市的，统一补上「德阳市 · 」 */
  function countyLabel(r) {
    if (!r['县市区']) return '';
    return (r['市州'] ? r['市州'] + ' · ' : '') + r['县市区'];
  }

  const GRID_ROWS = [
    ['县市区', '县市区'], ['岗位类别', '岗位类别'],
    ['考试科目', '考试科目'], ['招聘名额', '招聘名额'],
    ['学历要求', '学历要求'], ['学位要求', '学位要求'],
    ['教师资格证', '教资要求'], ['最低服务期', '服务期年数'],
  ];

  function gridValue(field, r) {
    if (field === '县市区') return countyLabel(r);
    if (field === '服务期年数') return r[field] ? r[field] + ' 年' : '';
    if (field === '教资要求') return r[field] || '';
    return r[field];
  }

  function gridHTML(r) {
    let out = '';
    for (let i = 0; i < GRID_ROWS.length; i += 2) {
      for (let k = 0; k < 2; k++) {
        const pair = GRID_ROWS[i + k];
        if (!pair) break;
        const raw = gridValue(pair[1], r);
        if (raw === '' || raw == null) continue;
        const value = /^\d+$/.test(String(raw))
          ? '<span class="num">' + esc(raw) + '</span>' : esc(raw);
        out += '<dt>' + esc(pair[0]) + '</dt><dd>' + value + '</dd>';
      }
    }
    let wide = '';
    if (r['招聘范围']) wide += '<dt>招聘范围</dt><dd>' + esc(r['招聘范围']) + '</dd>';
    if (r['学历学位']) wide += '<dt>学历学位</dt><dd>' + esc(r['学历学位']) + '</dd>';
    return (out ? '<dl class="card__grid">' + out + '</dl>' : '') +
      (wide ? '<dl class="card__grid card__grid--wide">' + wide + '</dl>' : '');
  }

  function examMetaHTML(r) {
    const rows = [];
    const add = function (label, value) {
      if (value && value !== '无') rows.push([label, value]);
    };
    add('岗位类别及等级', r['岗位类别及等级']);
    add('年龄', r['年龄']);
    add('政治面貌', r['政治面貌']);
    add('职称资格', r['职称资格']);
    add('工作经历', r['工作经历']);
    add('公共科目', r['公共科目']);
    add('专业科目', r['专业科目']);
    add('笔试成绩', r['笔试成绩计算']);
    add('笔试合格线', r['笔试合格线']);
    add('笔试开考比例', r['笔试开考比例']);
    add('综合面试', r['综合面试']);
    add('专业面试', r['专业面试']);
    add('面试成绩', r['面试成绩计算']);
    add('面试合格线', r['面试合格线']);
    add('面试入围比例', r['面试入围比例']);
    add('总成绩', r['总成绩计算']);
    add('最低服务期', r['最低服务期']);
    add('咨询电话', r['咨询电话']);

    return '<dl class="card__meta">' + rows.map(function (p) {
      return '<dt>' + esc(p[0]) + '</dt><dd>' + esc(p[1]) + '</dd>';
    }).join('') + '</dl>';
  }

  function tagsHTML(r) {
    if (!r.tags || !r.tags.length) return '';
    return '<div class="tags">' + r.tags.map(function (key) {
      const def = SY.TAG_DEFS.find(function (t) { return t.key === key; });
      if (!def) return '';
      const tone = def.tone === 'hard' ? 'hard' : (def.tone === 'info' ? 'info' : '');
      return '<span class="tag' + (tone ? ' tag--' + tone : '') +
        '" title="' + esc(SY.tagDesc(key)) + '">' + esc(SY.tagLabel(key)) + '</span>';
    }).join('') + '</div>';
  }

  function cardHTML(r, tier, animate, sealOverride) {
    const def = sealOverride || SY.TIERS[tier];
    const sealWhy = sealOverride && sealOverride.why;
    const isSaved = saved.has(r.id);
    const tokens = tokensFromReasons(r.reasons);
    const rawMajor = r['专业'] || r.major.raw || '';

    const sealCls = sealOverride ? (sealOverride.cls || '')
      : (tier === 'all' || tier === 'eligible') ? ' seal--search' : '';
    const dashed = sealOverride ? ''
      : (tier === 'category' || tier === 'eligible') ? ' seal--dashed' : '';

    return '<article class="card' + (isSaved ? ' card--saved' : '') + '" data-id="' + r.id + '">' +
      '<div class="card__top">' +
        '<div class="card__ident">' +
          '<h3 class="card__dept">' + esc(r['招聘单位']) + '</h3>' +
          '<p class="card__post">' + esc(r['岗位名称']) +
            (r['县市区'] ? ' · ' + esc(countyLabel(r)) : '') + '</p>' +
          '<p class="card__code">' +
            '<span class="card__code-item"><span class="card__code-label">岗位编码</span>' +
              '<span class="card__code-value">' + esc(r['岗位编码']) + '</span>' +
              '<button type="button" class="card__copy" data-copy="' + esc(r['岗位编码']) +
                '" aria-label="复制岗位编码">复制</button></span>' +
          '</p>' +
        '</div>' +
        '<div class="seal' + (animate ? '' : ' seal--idle') + sealCls + dashed +
          '" aria-label="匹配档位：' + esc(def.label) + '">' +
          '<span>' + esc(def.stamp) + '</span>' +
        '</div>' +
      '</div>' +
      gridHTML(r) +
      (rawMajor || sealWhy || (r.reasons && r.reasons.length) ||
       (r.matchFlags && r.matchFlags.length)
        ? '<div class="card__major">' +
            (sealWhy
              ? '<p class="card__why">不符合当前条件：' + esc(sealWhy) + '</p>'
              : '') +
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
        '<button type="button" class="card__more">岗位详情 · 考试 · 联系方式</button>' +
        '<button type="button" class="card__save' + (isSaved ? ' card__save--on' : '') + '">' +
          (isSaved ? '★ 已收藏' : '☆ 收藏') + '</button>' +
      '</div>' +
      '<div class="card__remark" hidden>' +
        '<span class="card__remark-title">备注</span>' + esc(r['备注'] || '（无）') +
        '<span class="card__remark-title" style="margin-top:8px">考试与成绩</span>' +
          examMetaHTML(r) +
      '</div>' +
    '</article>';
  }

  /* ===================================================================
   * 分布统计
   * ===================================================================*/

  const DIST_TABS = [
    { key: 'counties', label: '县市区' },
    { key: 'jobcats', label: '岗位类别' },
    { key: 'exams', label: '考试科目' },
    { key: 'tags', label: '要求标签' },
    { key: 'excluded', label: '被排除原因' },
  ];

  function distStats() {
    const list = visibleList();
    return {
      counties: GK.topCounts(list, function (r) { return r['县市区']; }),
      jobcats: GK.topCounts(list, function (r) { return r['岗位类别']; }),
      exams: GK.topCounts(list, function (r) { return r['考试科目']; }),
      tags: GK.topCounts(
        list.reduce(function (acc, r) { return acc.concat(r.tags); }, []),
        function (t) { return SY.tagLabel(t); }
      ),
      excluded: lastResult.stats.excluded,
    };
  }

  function renderDist() {
    const host = $('dist');
    const stats = distStats();

    const showExcluded = lastResult.mode !== 'browse' || Object.keys(stats.excluded).length;
    if (state.distTab === 'excluded' && !showExcluded) state.distTab = 'counties';

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
    ['市州', '市州'], ['县市区', '县市区'], ['招聘单位', '招聘单位'],
    ['岗位名称', '岗位名称'], ['岗位类别', '岗位类别'], ['考试科目', '考试科目'],
    ['招聘名额', '招聘名额'], ['学历学位', '学历学位'], ['教资要求', '教资要求'],
    ['招聘范围', '招聘范围'], ['最低服务期', '最低服务期'], ['咨询电话', '咨询电话'],
  ];

  function renderDrawer() {
    $('drawer-count').textContent = saved.size;
    $('fav-count').textContent = saved.size;
    const body = $('drawer-body');

    if (!saved.size) {
      body.innerHTML = '<p class="drawer__empty">还没有收藏。在岗位卡上点「☆ 收藏」，' +
        '收藏的岗位会在这里并排对比，差异项自动标出。</p>';
      return;
    }

    const picked = Array.from(saved).map(function (id) { return records[id]; })
      .filter(Boolean).slice(0, 4);
    const profile = SY.buildProfile(state.profile);

    let html = '<table class="compare"><thead><tr><th class="rowhead">共 ' +
      (saved.size > 4 ? '4 / ' + saved.size : saved.size) + ' 个</th>';
    picked.forEach(function (r) {
      html += '<th>' + esc(r['招聘单位']) +
        '<button type="button" class="compare__remove" data-unsave="' + r.id + '">移除</button>' +
        '<div style="font-weight:400;color:#6B6F6A;font-size:12px">' +
          esc(r['岗位名称']) + '</div></th>';
    });
    html += '</tr></thead><tbody>';

    html += '<tr><th class="rowhead">当前条件下</th>';
    picked.forEach(function (r) {
      const m = SY.matchRow(r, profile);
      if (profile.majorActive) {
        html += m.ok
          ? '<td><span style="color:#A8201A;font-family:var(--serif);font-weight:700">' +
              esc(SY.TIERS[m.tier].label) + '</span>' +
              (m.reasons && m.reasons.length
                ? '<div style="font-size:12px;color:#6B6F6A">' +
                  esc(m.reasons.join('；')) + '</div>' : '') + '</td>'
          : '<td><span style="color:#6B6F6A">不符合当前条件</span>' +
              (m.flags && m.flags.length
                ? '<div style="font-size:12px;color:#6B6F6A">' +
                  esc(m.flags.join('；')) + '</div>' : '') + '</td>';
      } else if (SY.personalActive(profile)) {
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
      const labels = (r.tags || []).map(function (k) { return SY.tagLabel(k); });
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
   * 收藏页
   * ===================================================================*/

  function missSeal(why) {
    return { label: '不符合当前条件', stamp: '不符', cls: ' seal--miss', why: why };
  }

  function favGroups() {
    const list = Array.from(saved).map(function (id) { return records[id]; }).filter(Boolean);
    if (!list.length) return [];

    const profile = SY.buildProfile(state.profile);
    if (!SY.personalActive(profile)) {
      return [{
        label: '收藏的岗位',
        desc: '还没填个人条件，先按收藏顺序列出；填了条件后会按匹配档位归组',
        items: list.map(function (r) { return { r: r, tier: 'all' }; }),
      }];
    }

    const buckets = { exact: [], class: [], category: [], eligible: [], miss: [] };
    list.forEach(function (r) {
      const m = SY.matchRow(r, profile);
      if (m.ok) {
        const tier = m.tier || 'eligible';
        buckets[tier].push({ r: r, tier: tier });
      } else {
        buckets.miss.push({ r: r, tier: 'all', seal: missSeal(m.why) });
      }
    });

    return ['exact', 'class', 'category', 'eligible', 'miss'].filter(function (k) {
      return buckets[k].length;
    }).map(function (k) {
      return k === 'miss'
        ? { label: '不符合当前条件',
            desc: '条件改了以后不再符合，可以先留着，也可以点「★ 已收藏」移出',
            items: buckets[k] }
        : { label: SY.TIERS[k].label, desc: SY.TIERS[k].desc, items: buckets[k] };
    });
  }

  function renderFavPage() {
    $('fav-count').textContent = saved.size;
    $('favpage-count').textContent = saved.size;

    const body = $('favpage-body');
    if (!saved.size) {
      body.innerHTML = '<div class="empty">' +
        '<p class="empty__title">还没有收藏任何岗位</p>' +
        '<p class="empty__text">回到选岗页，在岗位卡右下角点「☆ 收藏」，' +
          '收藏的岗位会集中到这里。</p>' +
        '<p style="margin:18px 0 0">' +
          '<button type="button" class="btn btn--primary" data-fav-back>去挑岗位</button></p>' +
      '</div>';
      return;
    }

    body.innerHTML = favGroups().map(function (g) {
      const people = g.items.reduce(function (a, it) { return a + it.r.headcount; }, 0);
      const cards = g.items.map(function (it) {
        return cardHTML(it.r, it.tier, false, it.seal || null);
      }).join('');
      return '<section class="group">' +
        '<div class="group-head">' +
          '<h2 class="group-head__title">' + esc(g.label) + '</h2>' +
          '<span class="group-head__count">' + g.items.length.toLocaleString('en-US') +
            ' 个 / ' + people.toLocaleString('en-US') + ' 人</span>' +
          '<span class="group-head__desc">' + esc(g.desc) + '</span>' +
        '</div>' +
        '<div class="cards">' + cards + '</div>' +
      '</section>';
    }).join('');
  }

  function openFavPage() {
    if (favOpen) return;
    favOpen = true;
    renderFavPage();
    $('favpage').hidden = false;
    $('favpage').scrollTop = 0;
    document.body.classList.add('fav-open');
    document.querySelector('.shell').inert = true;
    document.querySelector('.masthead').inert = true;
    document.querySelector('.scopebar').inert = true;
    $('drawer').inert = true;
    $('fav-back').focus();
  }

  function closeFavPage() {
    if (!favOpen) return;
    favOpen = false;
    $('favpage').hidden = true;
    document.body.classList.remove('fav-open');
    document.querySelector('.shell').inert = false;
    document.querySelector('.masthead').inert = false;
    document.querySelector('.scopebar').inert = false;
    $('drawer').inert = false;
    $('btn-fav').focus();
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
    if (!list.length) { alert('当前没有可导出的岗位。'); return; }
    const scopeName = state.scope || '四川全省';
    download(scopeName + '事业单位岗位筛选_' + stamp() + '.csv', SY.toCSV(list),
      'text/csv;charset=utf-8');
  }

  /* ===================================================================
   * 事件
   * ===================================================================*/

  const onFormChange = debounce(function () {
    state.caps = resetCaps();
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
      state.caps = resetCaps();
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
      handleCardClick(e);
    });

    $('drawer-bar').addEventListener('click', toggleDrawer);
    $('drawer-bar').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDrawer(); }
    });
    $('drawer-body').addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-unsave]');
      if (btn) toggleSave(parseInt(btn.getAttribute('data-unsave'), 10));
    });

    $('btn-fav').addEventListener('click', openFavPage);
    $('fav-back').addEventListener('click', closeFavPage);
    $('favpage-body').addEventListener('click', function (e) {
      if (e.target.closest('[data-fav-back]')) { closeFavPage(); return; }
      handleCardClick(e);
    });

    $('btn-city').addEventListener('click', openCityPicker);
    $('citypick-grid').addEventListener('click', function (e) {
      const card = e.target.closest('button[data-scope]');
      if (!card) return;
      chooseCity(card.getAttribute('data-scope'));
    });

    $('btn-csv').addEventListener('click', exportCSV);
    $('btn-print').addEventListener('click', function () { window.print(); });
    $('btn-reset').addEventListener('click', function () {
      if (!confirm('清空全部筛选条件？收藏的岗位会保留。')) return;
      state.profile = Object.assign({}, SY.DEFAULT_PROFILE);
      state.search = '';
      state.tierFilter = 'all';
      state.onlySaved = false;
      state.sort = 'region';
      state.caps = resetCaps();
      $('f-search').value = '';
      $('f-onlysaved').checked = false;
      $('f-sort').value = 'region';
      writeForm(state.profile);
      applyCityFilter();
      render();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (favOpen) { e.preventDefault(); closeFavPage(); return; }
        if (!$('citypick').hidden) { e.preventDefault(); closeCityPicker(); return; }
      }
      if (e.key === '/' && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName) &&
          $('citypick').hidden && !favOpen) {
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

  function handleCardClick(e) {
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
      expand.textContent = panel.hidden ? '岗位详情 · 考试 · 联系方式' : '收起详情';
    }
  }

  function toggleSave(id) {
    if (saved.has(id)) saved.delete(id); else saved.add(id);
    persist();
    const on = saved.has(id);
    Array.prototype.forEach.call(
      document.querySelectorAll('.card[data-id="' + id + '"]'),
      function (card) {
        card.classList.toggle('card--saved', on);
        const btn = card.querySelector('.card__save');
        if (!btn) return;
        btn.classList.toggle('card__save--on', on);
        btn.textContent = on ? '★ 已收藏' : '☆ 收藏';
      }
    );
    renderDrawer();
    if (favOpen) renderFavPage();
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
    DATA = window.SY_DATA;
    if (!DATA || !DATA.meta) {
      failLoad('数据没能载入', '请确认 data/sy_positions.js 与 sy.html 在同一目录下。');
      return;
    }
    try {
      initBody();
    } catch (err) {
      const frame = String(err && err.stack || '').split('\n')
        .filter(function (l) { return /sy_app\.js|sy_match\.js|match\.js/.test(l); })[0] || '';
      failLoad('页面初始化出错', esc(String(err && err.message || err)) +
        (frame ? '<br><span class="num">' + esc(frame.trim()) + '</span>' : ''));
      throw err;
    }
    $('loading').hidden = true;
  }

  function initBody() {
    records = SY.unpack(DATA);

    restore();
    buildSidebar();
    bind();
    writeForm(state.profile);
    applyCityFilter();
    $('f-sort').value = state.sort;
    renderScope();

    if (state.scope === null) {
      openCityPicker();
    } else {
      render();
    }
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
    // 带时间戳：file:// 下浏览器也会启发式缓存，重建数据后普通刷新可能拿旧文件
    s.src = 'data/sy_positions.js?v=' + Date.now();
    s.onload = function () {
      requestAnimationFrame(function () { requestAnimationFrame(start); });
      setTimeout(start, 400);
    };
    s.onerror = function () {
      $('loading').innerHTML = '<p class="loading__title">找不到 data/sy_positions.js</p>' +
        '<p class="loading__hint">先运行：python -I build_sy_data.py ' +
        '"20日9点】26下四川事业单位岗位汇总表.xlsx"</p>';
    };
    document.body.appendChild(s);
    $('loading-hint').textContent = '读取 data/sy_positions.js …';
    setTimeout(function () {
      if (!started) {
        $('loading-hint').textContent = '数据脚本未响应 —— 请确认 data/sy_positions.js 存在，' +
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
