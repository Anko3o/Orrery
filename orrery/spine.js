/* 书脊抽屉 · Spine Drawer（9-06 粗版）
 * 每进一级开一张新面板；上一级压成一条竖排书脊叠在左缘，点书脊退回那一级。
 * 一级：书架（记忆桶 / 锚点 / 日记 / 信件 / 找一找）；二级：列表；三级：正文。
 * 数据借天仪已经加载的 nodes（window.orrery），不再请求第二次。 */
(function () {
  "use strict";
  var root = document.getElementById("drawer");
  var row = document.getElementById("drawer-row");
  var btn = document.getElementById("drawerbtn");
  var xbtn = document.getElementById("drawer-x");
  if (!root || !row || !btn || !window.orrery) return;

  var PAGE = 20;
  var isDiary = function (n) { return n.box === "diary" || (n.tags || []).indexOf("__diary__") >= 0; };
  var byActive = function (a, b) { return String(b.active || b.created || "").localeCompare(String(a.active || a.created || "")); };
  var byCreated = function (a, b) { return String(b.created || "").localeCompare(String(a.created || "")); };
  /* 分签沿用旧 INDEX 的六个：全部 / 碎碎念 / 日记 / 记忆 / 核心 / 信箱（box 由 orrery-export 算好） */
  var BOXES = [["all", "全部"], ["murmur", "碎碎念"], ["diary", "日记"], ["memory", "记忆"], ["core", "核心"], ["letter", "信箱"]];
  var boxOf = function (n) { return n.box || (n.kind === "permanent" ? "core" : "memory"); };
  var SHELVES = [
    { key: "buckets", label: "记忆桶", spine: "BUCKETS", pick: function () { return true; }, sort: byActive, boxes: true },
    { key: "anchors", label: "锚点",   spine: "ANCHORS", pick: function (n) { return n.anchor === true || n.kind === "permanent"; }, sort: byActive },
    { key: "diary",   label: "日记",   spine: "DIARY",   pick: isDiary, sort: byCreated },
    { key: "letters", label: "信件",   spine: "LETTERS", pick: function (n) { return n.kind === "letters"; }, sort: byCreated },
    { key: "search",  label: "找一找", spine: "SEARCH",  pick: function () { return true; }, sort: byActive, search: true, boxes: true },
    { key: "topics",  label: "话题",   spine: "TOPICS",  topics: true },
    /* 9-10 安可：「开窗 breath 总是上限，但没有面板可以控制这些」→ 浮现预算 / 遗忘 / 强度权重都在这儿拧 */
    { key: "settings", label: "设置", spine: "SETTINGS", settings: true }
  ];
  /* OB 设置走同源小路 /ob-api/{brain}/…（和卡片编辑同一条），401 就在面板里要密码 */
  var OAPI = "/ob-api/" + (window.orrery.brain === "feylor" ? "feylor" : "rime");
  function oapi(path, opt) {
    opt = opt || {};
    var o = { method: opt.method || "GET", headers: { "X-Requested-With": "XMLHttpRequest" }, credentials: "same-origin" };
    if (opt.body) { o.headers["Content-Type"] = "application/json"; o.body = JSON.stringify(opt.body); }
    return fetch(OAPI + path, o).then(function (r) {
      return r.text().then(function (t) {
        var j = {}; try { j = t ? JSON.parse(t) : {}; } catch (e) { j = { error: t.slice(0, 120) }; }
        if (r.status === 401) { var e = new Error("unauthorized"); e.auth = true; throw e; }
        if (!r.ok || j.ok === false) throw new Error(j.error || ("HTTP " + r.status));
        return j;
      });
    });
  }
  /* 设置项：[组, 键, 中文名, 一句话, min, max, step] */
  var SETTINGS = [
    ["surfacing", "breath_max_tokens", "开窗浮现预算", "wake / breath 一次最多端上来多少 token。到顶就会报「有 n 条没放下」。最高 40000。", 1000, 40000, 500],
    ["surfacing", "breath_max_results", "开窗最多几只桶", "预算够也最多端这么多只。", 1, 50, 1],
    ["surfacing", "feel_max_tokens", "感受浮现预算", "feel 一次最多多少 token。", 500, 30000, 500],
    ["decay", "threshold", "算「正在变淡」的线", "提取强度低于它，天仪上就画成点线圆、FADING 计数。不会搬走。", 0.05, 0.9, 0.05],
    ["decay", "archive", "老式自动归档", "开了才会把低分桶搬进 archive（9-10 起默认关：记忆只淡不丢）。", 0, 1, 1],
    ["strength", "activation_weight", "被想起一次加多少", "存储强度：每被想起的次数翻一倍 +这么多。", 0, 3, 0.1],
    ["strength", "edit_weight", "被追加一次加多少", "存储强度：实质改动（正文/感受/为什么留）次数翻一倍 +这么多。", 0, 3, 0.1],
    ["strength", "mood_weight", "心情满格加多少", "存储强度：天气/轴幅度满格时 +这么多。", 0, 4, 0.1],
    ["strength", "mood_axis_full", "轴幅度多少算满格", "轴:思念+8 这种，写到多少算 100%。现库前两成 ≥8。", 2, 20, 1],
    ["strength", "half_life_base_days", "5 分桶的半衰期（天）", "多少天没想起，提取强度掉一半。", 3, 365, 1],
    ["strength", "half_life_growth", "每高一分半衰期乘几", "2 = 6 分 60 天、8 分 240 天。", 1, 4, 0.1],
    ["strength", "eternal_at", "几分以上永不褪", "存储强度到这儿就不衰减。", 6, 11, 0.5],
    ["strength", "resolved_factor", "已处理的桶半衰期乘几", "resolved 的桶褪得快一点。", 0.1, 1, 0.05]
  ];
  function openSettings(s) {
    var el = document.createElement("div"); el.className = "lvl detail";
    head(el, s.label, "");
    var body = document.createElement("div"); body.className = "lvl-body lvl-detail";
    body.innerHTML = '<p class="lvl-empty">读设置…</p>';
    el.appendChild(body);
    push(el, "SETTINGS");
    function render(cur) {
      var html = '<form class="set-form">';
      var lastGroup = "";
      SETTINGS.forEach(function (d) {
        var g = d[0], k = d[1];
        if (g !== lastGroup) { html += '<h2 class="topic-h set-g">' + ({ surfacing: "浮现", decay: "遗忘", strength: "记忆强度" })[g] + '</h2>'; lastGroup = g; }
        var v = (cur[g] || {})[k];
        var isBool = d[5] === 1 && d[4] === 0 && d[6] === 1 && k === "archive";
        html += '<label class="set-row"><span class="set-name">' + esc(d[2]) + '</span>' +
          (isBool ? '<input type="checkbox" name="' + g + '.' + k + '"' + (v ? ' checked' : '') + '>'
                  : '<input type="number" name="' + g + '.' + k + '" value="' + esc(String(v == null ? "" : v)) + '" min="' + d[4] + '" max="' + d[5] + '" step="' + d[6] + '">') +
          '<small>' + esc(d[3]) + '</small></label>';
      });
      html += '<div class="blk-actions"><button type="submit" class="save">保存</button><span class="set-note"></span></div>' +
        '<p class="set-hint">保存即写进 OB 的 config.yaml 并热生效；浮现预算下一次开窗见效，强度权重天仪下一轮导出（≤15 分钟）见效。</p></form>' +
        '<form class="set-login" hidden><label>OB 密码<input type="password" name="pw" autocomplete="current-password"></label><div class="blk-actions"><button type="submit" class="save">进来</button><span class="set-note"></span></div></form>';
      body.innerHTML = html;
      var form = body.querySelector(".set-form"), note = form.querySelector(".set-note");
      var login = body.querySelector(".set-login"), lnote = login.querySelector(".set-note");
      var pendingBody = null;
      function save(payload) {
        note.textContent = "…";
        oapi("/api/settings/surfacing", { method: "POST", body: payload }).then(function () {
          note.textContent = "已保存 ✓"; setTimeout(function () { note.textContent = ""; }, 3000);
        }).catch(function (e) {
          if (e.auth) { pendingBody = payload; login.hidden = false; note.textContent = ""; return; }
          note.textContent = "没成：" + e.message;
        });
      }
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var payload = {};
        SETTINGS.forEach(function (d) {
          var inp = form.querySelector('[name="' + d[0] + '.' + d[1] + '"]');
          if (!inp) return;
          var val = inp.type === "checkbox" ? inp.checked : Number(inp.value);
          if (inp.type !== "checkbox" && !isFinite(val)) return;
          (payload[d[0]] = payload[d[0]] || {})[d[1]] = val;
        });
        save(payload);
      });
      login.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var pw = login.querySelector('[name="pw"]').value; if (!pw) return;
        lnote.textContent = "…";
        oapi("/auth/login", { method: "POST", body: { password: pw } }).then(function () {
          login.hidden = true; lnote.textContent = ""; login.querySelector('[name="pw"]').value = "";
          if (pendingBody) { var b = pendingBody; pendingBody = null; save(b); } else { openSettings(s); popTo(levels.length - 2); }
        }).catch(function (e) { lnote.textContent = e.auth ? "密码不对" : ("没成：" + e.message); });
      });
    }
    oapi("/api/settings/surfacing").then(render).catch(function (e) {
      if (e.auth) {
        body.innerHTML = '<form class="set-login"><p class="lvl-empty">看设置要先跟 OB 打个招呼。</p><label>OB 密码<input type="password" name="pw" autocomplete="current-password"></label><div class="blk-actions"><button type="submit" class="save">进来</button><span class="set-note"></span></div></form>';
        var login = body.querySelector(".set-login"), lnote = login.querySelector(".set-note");
        login.addEventListener("submit", function (ev) {
          ev.preventDefault();
          var pw = login.querySelector('[name="pw"]').value; if (!pw) return;
          lnote.textContent = "…";
          oapi("/auth/login", { method: "POST", body: { password: pw } }).then(function () {
            return oapi("/api/settings/surfacing");
          }).then(render).catch(function (e2) { lnote.textContent = e2.auth ? "密码不对" : ("没成：" + e2.message); });
        });
        return;
      }
      body.innerHTML = '<p class="lvl-empty">OB 没应答：' + esc(e.message) + '</p>';
    });
  }
  /* 话题块库（9-07 安可「后端做个搜索安可也能自己修改」）：原文按话题切的块，走 /blocks/api（同全站门禁，同源） */
  var BAPI = "/blocks/api";
  function bapi(path, opt) {
    opt = opt || {};
    var o = { method: opt.method || "GET", headers: { "X-Requested-With": "XMLHttpRequest" }, credentials: "same-origin" };
    if (opt.body) { o.headers["Content-Type"] = "application/json"; o.body = JSON.stringify(opt.body); }
    return fetch(BAPI + path, o).then(function (r) {
      if (!r.ok) throw new Error("blocks-api " + r.status);
      return r.json();
    });
  }
  function tagLine(b) {
    var parts = [["人", b.who], ["事", b.what], ["物", b.things], ["地", b.where]].filter(function (x) { return x[1] && x[1].length; })
      .map(function (x) { return '<span class="tag">' + x[0] + '·' + esc(x[1].join("/")) + '</span>'; });
    return parts.join(" ");
  }

  var WX = { "放晴": "☀️", "彩虹": "🌈", "落雨": "🌧️", "落雪": "❄️", "冰雹": "🧊", "雷暴": "⛈️" };
  var WXKEY = { clear: "放晴", rainbow: "彩虹", rain: "落雨", snow: "落雪", hail: "冰雹", storm: "雷暴" };
  function wxEmoji(t) { var k = String(t || "").replace(/^天气[:：]\s*/, ""); return WX[WXKEY[k] || k] || ""; }
  function weatherOf(n) { var t = (n.tags || []).filter(function (x) { return /^天气[:：]/.test(x); })[0]; return t ? wxEmoji(t) : ""; }
  function tagRank(t) { return /^天气[:：]/.test(t) ? 0 : (/^轴[:：]/.test(t) ? 1 : 2); }

  /* ---- 9-09 心情栏（安可：VAL/ARO 撤销，改情绪驱动；21:47 追加：不要胶囊、不要渐变）----
     跟卡片同一套读法：天气章优先，轴最多画三根，条从中点向左（负）向右（正）。
     颜色表抄自 app.js 的 MOOD_COLORS 夜/昼两套，抽屉玻璃是暗底，取夜那套。 */
  var AXIS_COLOR = {
    "思念": "116,172,255", "幸福": "255,178,96", "渴望": "255,134,190",
    "压力": "178,142,255", "疲倦": "170,174,188", "好奇": "118,216,168", "社交": "240,220,118"
  };
  var AXIS_ALIAS = { "想念": "思念", "欲望": "渴望", "热闹": "社交", "开心": "幸福", "疲劳": "疲倦" };
  function moodOf(n) {
    var m = n.mood, wxName = "", axes = [];
    if (m && (m.weather || (m.axes && m.axes.length))) {
      wxName = WXKEY[m.weather] || m.weatherName || "";
      axes = (m.axes || []).slice();
    } else {
      (n.tags || []).forEach(function (t) {
        t = String(t);
        var w = /^\s*天气[:：]\s*(.+?)\s*$/.exec(t);
        if (w) { if (!wxName) wxName = WXKEY[w[1]] || w[1]; return; }
        var a = /^\s*轴[:：]\s*([^+\-0-9]+?)\s*([+\-]?\d+(?:\.\d+)?)?\s*$/.exec(t);
        if (!a) return;
        var nm = AXIS_ALIAS[a[1].trim()] || a[1].trim();
        if (!AXIS_COLOR[nm]) return;                 // 沉淀 / 牵挂 已下岗
        axes.push({ name: nm, delta: parseFloat(a[2] || "0") || 0 });
      });
      axes.sort(function (x, y) { return Math.abs(y.delta) - Math.abs(x.delta); });
    }
    return { wxName: wxName, axes: axes, has: !!(wxName || axes.length) };
  }
  function moodBlock(n) {
    var m = moodOf(n);
    if (!m.has) return '<div class="mood"><span class="mk">心情</span><em class="none">当时没留心情</em></div>';
    var head = '<div class="mood"><span class="mk">心情</span><em>' +
      (m.wxName ? esc((WX[m.wxName] || "") + " " + m.wxName) : "—") + '</em></div>';
    var rows = m.axes.slice(0, 3).map(function (a) {
      var c = AXIS_COLOR[a.name] || "170,174,188";
      var pct = Math.min(1, Math.abs(a.delta) / 12) * 50;
      var side = a.delta < 0 ? "right:50%" : "left:50%";
      return '<div class="mrow"><span class="mk">' + esc(a.name) + '</span>' +
        '<i class="mtrack"><b style="' + side + ';width:' + pct.toFixed(1) +
        '%;background:rgba(' + c + ',.92)"></b></i>' +
        '<span class="mnum" style="color:rgba(' + c + ',.95)">' +
        (a.delta > 0 ? "+" : "") + (Math.round(a.delta * 10) / 10) + '</span></div>';
    }).join("");
    return head + (rows ? '<div class="maxes">' + rows + '</div>' : "");
  }
  /* 滚到底自动再翻一页（MORE 按钮留着当兜底） */
  function autoMore(scroller, more, fn) {
    if (!("IntersectionObserver" in window)) return;
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting && !more.hidden) fn(); }); }, { root: scroller, rootMargin: "120px" });
    io.observe(more);
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; }); }
  function day(s) { var m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[1].slice(2) + "." + m[2] + "." + m[3] : ""; }
  function pad(i) { return (i < 9 ? "0" : "") + (i + 1); }
  function titleOf(n) {
    var t = String(n.title || "").trim();
    if (!t || /^\d{4}-\d{2}-\d{2}[ T]\d{2}[-:]\d{2}[-:]\d{2}$/.test(t)) {
      t = String(n.summary || "").split(/\n/)[0].replace(/^\d{4}-\d{2}-\d{2}\s*/, "").slice(0, 42) || "（无题）";
    }
    return t;
  }

  var levels = [];          // [{el, spine}]
  function push(el, spineLabel) {
    var sp = document.createElement("span");
    sp.className = "lvl-spine"; sp.textContent = spineLabel;
    el.appendChild(sp);
    /* 只把「退回这一级」挂在书脊条上：书脊只有压扁时才显示，
       否则列表项的点击冒泡到本级时本级已经被压扁，会把刚开的新面板又弹掉。 */
    sp.addEventListener("click", function (e) {
      e.stopPropagation();
      popTo(levels.findIndex(function (l) { return l.el === el; }));
    });
    levels.forEach(function (l) { l.el.classList.add("spined"); });
    levels.push({ el: el });
    /* 9-08 顺滑：上一级压扁和新面板滑入同一帧起步，别一前一后抖两下 */
    requestAnimationFrame(function () {
      row.appendChild(el);
      var body = el.querySelector(".lvl-body"); if (body) body.scrollTop = 0;
      var q = el.querySelector(".lvl-q");
      if (q) el.addEventListener("animationend", function () { q.focus({ preventScroll: true }); }, { once: true });
    });
  }
  function popTo(i) {
    while (levels.length > i + 1) { var l = levels.pop(); l.el.remove(); }
    levels.forEach(function (l, k) { l.el.classList.toggle("spined", k < levels.length - 1); });
  }
  function head(el, label, backLabel) {
    var h = document.createElement("div"); h.className = "lvl-head";
    if (backLabel !== null) {
      var b = document.createElement("button"); b.type = "button"; b.className = "lvl-back"; b.textContent = "‹ BACK";
      b.addEventListener("click", function () { popTo(levels.length - 2); });
      h.appendChild(b);
    }
    var t = document.createElement("span"); t.textContent = label; h.appendChild(t);
    var c = document.createElement("span"); c.className = "cnt"; h.appendChild(c);
    el.appendChild(h);
    return c;
  }

  /* 一级：书架 */
  function openMenu() {
    var el = document.createElement("div"); el.className = "lvl menu";
    head(el, "SHELF · 记忆书架", null);
    var body = document.createElement("div"); body.className = "lvl-body";
    SHELVES.forEach(function (s, i) {
      var b = document.createElement("button"); b.type = "button"; b.className = "lvl-item";
      b.innerHTML = '<span class="no">' + pad(i) + '</span><span class="tt">' + esc(s.label) + '</span><span class="ar">›</span>';
      b.addEventListener("click", function () { s.settings ? openSettings(s) : (s.topics ? openTopics(s) : openList(s)); });
      body.appendChild(b);
    });
    el.appendChild(body);
    push(el, "MENU");
  }

  /* 二级：列表 */
  function openList(s) {
    var el = document.createElement("div"); el.className = "lvl list";
    var cnt = head(el, s.label, "");
    /* 新旧排序（9-07 01:35 安可点单，从旧 INDEX 搬来） */
    var newFirst = true;
    var sortBtn = document.createElement("button"); sortBtn.type = "button"; sortBtn.className = "lvl-sort"; sortBtn.textContent = "NEW→OLD";
    cnt.parentNode.insertBefore(sortBtn, cnt);
    var body = document.createElement("div"); body.className = "lvl-body";
    var q = null;
    if (s.search) {
      q = document.createElement("input"); q.type = "search"; q.className = "lvl-q"; q.placeholder = "关键词、标签、日期…"; q.autocomplete = "off";
      body.appendChild(q);
    }
    /* 分签行 */
    var box = "all", chips = null;
    if (s.boxes) {
      chips = document.createElement("div"); chips.className = "lvl-chips";
      body.appendChild(chips);
    }
    function paintChips() {
      if (!chips) return;
      var all = window.orrery.nodes(), counts = {};
      all.forEach(function (n) { var b = boxOf(n); counts[b] = (counts[b] || 0) + 1; });
      chips.innerHTML = BOXES.map(function (d) {
        var c = d[0] === "all" ? all.length : (counts[d[0]] || 0);
        return '<button type="button" data-box="' + d[0] + '" aria-pressed="' + String(d[0] === box) + '">' + d[1] + '<b>' + c + '</b></button>';
      }).join("");
    }
    var ol = document.createElement("div"); body.appendChild(ol);
    var more = document.createElement("button"); more.type = "button"; more.className = "lvl-more"; more.textContent = "MORE ↓"; more.hidden = true;
    body.appendChild(more);
    el.appendChild(body);

    var rows = [], shown = 0;
    function paint(reset) {
      if (reset) { ol.innerHTML = ""; shown = 0; }
      var slice = rows.slice(shown, shown + PAGE);
      if (!rows.length) ol.innerHTML = '<p class="lvl-empty">这一格还是空的。</p>';
      slice.forEach(function (n, k) {
        var b = document.createElement("button"); b.type = "button"; b.className = "lvl-item";
        b.innerHTML = '<span class="no">' + pad(shown + k) + '</span><span class="tt">' + esc(titleOf(n)) + '</span><span class="wx">' + weatherOf(n) + '</span><span class="dt">' + day(n.created) + '</span><span class="ar">›</span>';
        b.addEventListener("click", function () { openDetail(n, s); });
        ol.appendChild(b);
      });
      shown += slice.length;
      more.hidden = shown >= rows.length;
      cnt.textContent = rows.length ? Math.min(shown, rows.length) + " / " + rows.length : "";
    }
    function apply() {
      var kw = q ? q.value.trim().toLowerCase() : "";
      rows = window.orrery.nodes().filter(s.pick);
      if (box !== "all") rows = rows.filter(function (n) { return boxOf(n) === box; });
      if (kw) rows = rows.filter(function (n) {
        return [n.title, n.summary, n.domain, (n.tags || []).join(" "), n.created].join(" ").toLowerCase().indexOf(kw) >= 0;
      });
      rows.sort(newFirst ? byCreated : function (a, b) { return byCreated(b, a); });
      paintChips();
      paint(true);
    }
    var t = 0;
    if (q) q.addEventListener("input", function () { clearTimeout(t); t = setTimeout(apply, 160); });
    if (chips) chips.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-box]"); if (!b) return;
      box = b.dataset.box; apply();
    });
    sortBtn.addEventListener("click", function () {
      newFirst = !newFirst; sortBtn.textContent = newFirst ? "NEW→OLD" : "OLD→NEW"; apply();
    });
    more.addEventListener("click", function () { paint(false); });
    autoMore(body, more, function () { paint(false); });
    apply();
    push(el, s.spine);
  }

  /* 二级（话题）：书脊列表，服务器搜 */
  function openTopics(s) {
    var el = document.createElement("div"); el.className = "lvl list";
    var cnt = head(el, s.label, "");
    var body = document.createElement("div"); body.className = "lvl-body";
    var q = document.createElement("input"); q.type = "search"; q.className = "lvl-q"; q.placeholder = "兔子、充电宝、床上、9-07…"; q.autocomplete = "off";
    body.appendChild(q);
    var st = document.createElement("div"); st.className = "lvl-stat"; body.appendChild(st);
    var ol = document.createElement("div"); body.appendChild(ol);
    var more = document.createElement("button"); more.type = "button"; more.className = "lvl-more"; more.textContent = "MORE ↓"; more.hidden = true;
    body.appendChild(more);
    el.appendChild(body);
    bapi("/stat").then(function (d) {
      st.textContent = d.blocks + " 块 · " + d.sessions + " 窗 · " + d.first.slice(0, 5) + " → " + d.last.slice(0, 5) +
        " · 本月切块 $" + d.month_usd.toFixed(2) + " / 封顶 $" + d.cap_usd.toFixed(0);
    }).catch(function () { st.textContent = "块库后端没应答"; });
    var offset = 0, total = 0, kw = "";
    function paint(reset) {
      if (reset) { ol.innerHTML = ""; offset = 0; }
      bapi("/list?q=" + encodeURIComponent(kw) + "&offset=" + offset + "&limit=" + PAGE).then(function (d) {
        total = d.total;
        if (!d.items.length && reset) ol.innerHTML = '<p class="lvl-empty">没有这个话题。</p>';
        d.items.forEach(function (b, k) {
          var it = document.createElement("button"); it.type = "button"; it.className = "lvl-item topic";
          it.innerHTML = '<span class="no">' + pad(offset + k) + '</span><span class="tt">' + esc(b.topic) + '</span><span class="dt">' + esc(b.local.slice(0, 5)) + '</span><span class="ar">›</span>';
          it.addEventListener("click", function () { openBlock(b.id, s); });
          ol.appendChild(it);
        });
        offset += d.items.length;
        more.hidden = offset >= total;
        cnt.textContent = total ? Math.min(offset, total) + " / " + total : "";
      }).catch(function () { if (reset) ol.innerHTML = '<p class="lvl-empty">块库后端没应答。</p>'; });
    }
    var t = 0;
    q.addEventListener("input", function () { clearTimeout(t); t = setTimeout(function () { kw = q.value.trim(); paint(true); }, 200); });
    more.addEventListener("click", function () { paint(false); });
    autoMore(body, more, function () { paint(false); });
    paint(true);
    push(el, s.spine);
  }

  /* 三级（话题）：一块原文，分页；书脊可改，块可删 */
  function openBlock(id, s, page) {
    page = page || 1;
    var el = document.createElement("div"); el.className = "lvl detail";
    head(el, (s ? s.label : "话题") + " · 原文", "");
    var body = document.createElement("div"); body.className = "lvl-body lvl-detail";
    body.innerHTML = '<p class="lvl-empty">拿原文…</p>';
    el.appendChild(body);
    push(el, "BLOCK");
    bapi("/block/" + encodeURIComponent(id) + "?page=" + page).then(function (b) {
      var holders = (b.buckets || []).map(function (h) { return '<span class="tag">桶·' + esc(h.title || h.bucket).slice(0, 18) + '</span>'; }).join(" ");
      body.innerHTML =
        '<h2 class="topic-h">' + esc(b.topic) + '</h2>' +
        '<div class="meta">' + esc(b.local) + ' · ' + b.turns + ' 回合 · ' + b.total_chars + ' 字' + (b.pages > 1 ? ' · 第 ' + b.page + '/' + b.pages + ' 页' : '') + '</div>' +
        ((tagLine(b) || holders) ? '<div>' + tagLine(b) + (holders ? ' ' + holders : '') + '</div>' : '') +
        (b.summary ? '<div class="body summ">' + esc(b.summary) + '</div>' : '') +
        '<pre class="body raw">' + esc(b.text) + '</pre>' +
        (b.pages > 1 ? '<div class="pager">' +
          (b.page > 1 ? '<button type="button" class="pg" data-p="' + (b.page - 1) + '">‹ 上一页</button>' : '') +
          (b.page < b.pages ? '<button type="button" class="pg" data-p="' + (b.page + 1) + '">下一页 ›</button>' : '') + '</div>' : '') +
        '<div class="blk-actions"><button type="button" class="edit">✎ 改书脊</button><button type="button" class="del">✕ 删这块</button></div>' +
        '<form class="blk-edit" hidden>' +
          '<label>话题<input name="topic" maxlength="60" value="' + esc(b.topic) + '"></label>' +
          '<div class="blk-actions"><button type="submit" class="save">保存</button><button type="button" class="cancel">算了</button></div>' +
        '</form>';
      body.querySelectorAll(".pg").forEach(function (btn) {
        btn.addEventListener("click", function () { popTo(levels.length - 2); openBlock(id, s, Number(btn.dataset.p)); });
      });
      var form = body.querySelector(".blk-edit");
      body.querySelector(".edit").addEventListener("click", function () { form.hidden = !form.hidden; });
      body.querySelector(".cancel").addEventListener("click", function () { form.hidden = true; });
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var fd = new FormData(form), payload = {};
        payload.topic = String(fd.get("topic") || "");
        bapi("/block/" + encodeURIComponent(id), { method: "PATCH", body: payload }).then(function () {
          popTo(levels.length - 2); openBlock(id, s, page);
        }).catch(function () { alert("没存上，后端没应答"); });
      });
      var del = body.querySelector(".del"), armed = false;
      del.addEventListener("click", function () {
        if (!armed) { armed = true; del.textContent = "再点一次就真删了（连原文）"; setTimeout(function () { armed = false; del.textContent = "✕ 删这块"; }, 4000); return; }
        bapi("/block/" + encodeURIComponent(id), { method: "DELETE" }).then(function () { popTo(levels.length - 2); })
          .catch(function () { alert("没删掉，后端没应答"); });
      });
    }).catch(function () { body.innerHTML = '<p class="lvl-empty">块库后端没应答。</p>'; });
  }

  /* 三级：正文 */
  function openDetail(n, s) {
    var el = document.createElement("div"); el.className = "lvl detail";
    head(el, s.label + " · " + (n.kind || ""), "");
    var body = document.createElement("div"); body.className = "lvl-body lvl-detail";
    // 9-09：天气/轴上移到心情栏，胶囊里只留普通标签（安可：胶囊太多了影响观感）
    var tags = (n.tags || []).filter(function (t) { return !/^__/.test(t) && !/^\s*(天气|轴)[:：]/.test(t); }).slice(0, 10)
      .map(function (t) { return '<span class="tag">#' + esc(t) + '</span>'; }).join("");
    var feels = (n.feel || []).filter(function (f) { return f && String(f).trim(); });
    body.innerHTML =
      '<h2>' + esc(titleOf(n)) + '</h2>' +
      '<div class="meta">' + esc(day(n.created)) + (n.domain ? ' · ' + esc(n.domain) : '') +
        (n.importance != null ? ' · IMP ' + esc(n.importance) : '') + (n.anchor === true ? ' · ⚓' : '') + '</div>' +
      moodBlock(n) +
      (tags ? '<div>' + tags + '</div>' : '') +
      '<div class="body">' + esc(n.summary || "") + '</div>' +
      (n.why && String(n.why).trim() ? '<div class="why"><span class="lab">为什么留</span><p>' + esc(n.why) + '</p></div>' : '') +
      (feels.length ? '<div class="feel"><span class="lab">我的感受</span>' + feels.map(function (f) { return '<p>' + esc(f) + '</p>'; }).join("") + '</div>' : '') +
      '<button type="button" class="go">GO TO STAR · 去看这颗星</button>';
    body.querySelector(".go").addEventListener("click", function () {
      close();
      window.orrery.focusStar(n);
    });
    /* 9-07 桶→原文：这个桶挂着哪些话题块（bucket-links），有就列出来，点开看原话 */
    var raw = document.createElement("div"); raw.className = "raw-links"; body.appendChild(raw);
    if (n.id) bapi("/links/" + encodeURIComponent(n.id)).then(function (d) {
      if (!d.items || !d.items.length) return;
      raw.innerHTML = '<div class="meta">原文 · ' + d.items.length + ' 块</div>';
      d.items.forEach(function (b) {
        var it = document.createElement("button"); it.type = "button"; it.className = "lvl-item topic";
        it.innerHTML = '<span class="tt">' + esc(b.topic) + '</span><span class="dt">' + esc(b.local.slice(0, 5)) + '</span><span class="ar">›</span>';
        it.addEventListener("click", function () { openBlock(b.id, { label: "原文" }); });
        raw.appendChild(it);
      });
    }).catch(function () {});
    el.appendChild(body);
    push(el, titleOf(n).slice(0, 14));
  }

  function open() {
    if (!levels.length) openMenu();
    root.hidden = false;
    btn.setAttribute("aria-pressed", "true");
  }
  function close() {
    root.hidden = true;
    btn.setAttribute("aria-pressed", "false");
  }
  btn.addEventListener("click", function () { root.hidden ? open() : close(); });
  xbtn.addEventListener("click", close);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !root.hidden) close(); });
  /* 天仪换住户是整页重载，抽屉自然跟着换；这里不用管 */
})();
