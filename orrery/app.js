/* 记忆天仪 · Memory Orrery
 *
 * 安可在中心，每条轨道是一个真实记忆领域，每颗星是一只真实记忆桶。
 * 轨道半径 = 该领域记忆的平均重要度（越重要越贴近她），且保证周长放得下。
 * 星的大小 = importance，颜色 = 当时的心情（9-09 安可：VAL/ARO 撤销，改情绪驱动）——
 * 天气章（天气:落雪）优先定色，没有天气就看轴（轴:思念+8）里幅度最大的那根，
 * 两样都没有的用中性色；亮度 = clarity（OB 的 e^(-0.05·天) 衰减模型），外环 = anchor 锚定。
 *
 * 一个页面装下所有功能的办法不是把控件塞满，是让缩放本身变成层级：
 * 拉远看星系的形状，推近看每一段记忆的名字。
 */
(function () {
  "use strict";

  var TILT = 0.58;            // 2D 回退时的远景压缩
  var MIN_Z = 0.28, MAX_Z = 7;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var queryParams = new URLSearchParams(location.search);
  var brain = queryParams.get("brain") === "feylor" ? "feylor" : "rime";
  var dataFile = brain === "feylor" ? "orrery-feylor.json" : "orrery.json";
  document.documentElement.dataset.brain = brain;
  // ?depth=1 进入实验观察角；按钮可以随时退回原来的纯平面图。
  var depthEnabled = /[?&]depth=1/.test(location.search) && !reduceMotion;
  // 9-10 天仪二期（安可：「排列逻辑按坐标系来，不是外表变成坐标系」）：
  // 星在轨道上的位置由三根轴决定——角度＝同类内向量投影、半径＝时间、高度＝存储强度。
  // 外表不变，轨道还是那根线，只是它有了宽度。?classic=1 看旧排法（按编号排队）。
  var COORD = !/[?&]classic=1/.test(location.search);
  var pairs = [], T0 = 0, T1 = 1;
  // 9-10 11:17 安可看图：「倾斜角还不够大胆，都几乎在一个平面内了……像柯伊伯带那种小行星带一样，
  // 它们怎么长我们怎么长」→ 每条轨道有自己的倾角（incl）和升交点（node），带里每颗星再带一点自己的倾角
  // （带的厚度），整个盘子最后斜放着看（BASE_*）。平面模式也吃这套几何，只是不带深度排序。
  var DEG = Math.PI / 180;
  var BASE_C = 0.52, BASE_S = Math.sqrt(1 - BASE_C * BASE_C);   // 盘子对着我们倾 ≈59°

  var cv = document.getElementById("sky");
  var ctx = cv.getContext("2d");
  var loading = document.getElementById("loading");

  var W = 0, H = 0, dpr = 1;
  var data = null, nodes = [], rings = [], stardust = [];
  var byId = {}, phaseBins = [0, 0, 0, 0, 0];

  // 相机：cur 跟随 aim 缓动
  var cam = { x: 0, y: 0, z: 1 };
  var aim = { x: 0, y: 0, z: 1 };
  // 深度只改变观看几何，不承载新的记忆指标。
  var viewBase = { yaw: depthEnabled ? 0.18 : 0, pitch: depthEnabled ? -0.08 : 0 };
  var viewAim = { yaw: viewBase.yaw, pitch: viewBase.pitch };
  var view = { yaw: viewAim.yaw, pitch: viewAim.pitch };
  var parallax = { yaw: 0, pitch: 0 };
  var fieldRadius = 900;
  var spin = !reduceMotion;
  var clock = 0, lastT = 0, raf = 0;
  var drift = { x: 0, y: 0 }, driftT = 0;
  var intro = 0, INTRO = 2.9;              // 入场：轨道逐条画出来，星再弹进来

  var hover = null, selected = null, related = [], selT = 0;
  var query = "", matched = null;
  var pointer = { x: -1e4, y: -1e4 };

  /* ---------------- 尺寸 ---------------- */
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ---------------- 布局 ---------------- */
  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h / 4294967295;
  }

  function build() {
    var doms = {};
    stardust = []; byId = {};
    data.nodes.forEach(function (n) {
      // 9-09 安可：轨道＝八大类（domain[0]），旧夹子名不再自己开一条轨道。
      // track 由 orrery-export.py 折好；旧 json 没有这个字段时退回 domain。
      // 11:33 安可：「不能按大类来区分了，只能按相似度来排列」→ 轨道＝向量聚出来的团（导出里的 cluster），
      // 团数跟着桶数长（≈√(N/2)）。没聚过的旧 json 退回八大类。
      var tk = (COORD && n.cluster) ? n.cluster : (n.track || n.domain);
      var d = doms[tk] || (doms[tk] = { name: tk, list: [], sum: 0 });
      d.list.push(n);
      d.sum += n.importance;
    });

    rings = Object.keys(doms).map(function (k) {
      var d = doms[k];
      d.avg = d.sum / d.list.length;
      d.count = d.list.length;
      return d;
    });
    // 平均重要度高的贴近中心；同分时桶少的在内（小而重的领域更亲密）
    rings.sort(function (a, b) { return b.avg - a.avg || a.count - b.count; });

    // 9-10：轨道从一条线变成一条有宽度的带。带宽按桶数给；星在带里的位置由三根轴决定——
    // 角度＝同类内向量投影（像的挤成一簇），半径＝时间（老的靠里、新的靠外），高度＝存储强度（2·5D 里浮起/沉下）。
    // 一条线只能排 count 颗，一条带能排 count × 带宽，800 只桶也不用再重构。
    var ts = data.nodes.map(function (n) { return n.created ? Date.parse(n.created) : NaN; })
      .filter(function (t) { return !isNaN(t); });
    T0 = ts.length ? Math.min.apply(null, ts) : 0;
    T1 = ts.length ? Math.max.apply(null, ts) : 1;
    if (T1 - T0 < 86400e3) T1 = T0 + 86400e3;
    var r = 96;
    rings.forEach(function (ring, i) {
      // 间距按这条轨道装了多少段记忆给：大领域占宽带、只有一两段的紧挨着，
      // 疏密对比来自真实内容，不是人为画出来的曲线
      var gap = 17 + 26 * Math.min(1, ring.count / 12);
      var w = COORD ? Math.max(10, Math.min(110, 10 + 7.5 * Math.sqrt(ring.count))) : 0;
      // 带的面积得放得下这些星（每颗约 16×15 px），放不下就往外推；旧排法看周长
      var need = COORD ? (ring.count * 240) / (6.2832 * Math.max(w, 10))
                       : (ring.count * 17) / (2 * Math.PI);
      r = Math.max(r + gap + w / 2, need);
      ring.r = r; ring.w = w; ring.rin = r - w / 2; ring.rout = r + w / 2;
      r = ring.rout;
      ring.index = i;
      ring.phase = hash(ring.name) * Math.PI * 2;
      ring.labelA = i * 2.39996;      // 黄金角：注记绕着星系散开，不叠成一条线
      // 每条轨道有自己的平面：像柯伊伯带——大多数倾 6°–36°，只有一两颗的小领域像散盘天体、再多斜 15°；
      // 升交点绕一圈散开，所以它们不会叠成一张纸。
      ring.incl = (6 + 30 * Math.pow(hash(ring.name + "i"), 1.5)) * DEG + (ring.count <= 3 ? 15 * DEG : 0);
      ring.node = hash(ring.name + "n") * Math.PI * 2;
      ring.ci = Math.cos(ring.incl); ring.si = Math.sin(ring.incl);
      ring.cn = Math.cos(ring.node); ring.sn = Math.sin(ring.node);
      ring.tilt = BASE_C;                          // 旧字段：只剩 ringOnScreen 的粗判还用它
      ring.spread = (4 + 10 * Math.min(1, ring.count / 60)) * DEG;   // 带的厚度：桶多的带更厚
      // 彗：每条轨道每隔一阵子有一串粒子流过，不常驻
      ring.cometT = 9 + hash(ring.name + "c") * 13;
      ring.cometOff = hash(ring.name + "o") * ring.cometT;
      // 开普勒：周期 ∝ r^1.5，内圈转得快
      ring.speed = 0.055 / Math.pow(ring.r / 128, 1.5);
      ring.hue = hash(ring.name + "h");

      // 星按诞生时间排在轨道上，绕一圈就是这个领域的编年史
      ring.list.sort(function (a, b) {
        return (a.created || "").localeCompare(b.created || "");
      });
      ring.list.forEach(function (n, j) {
        n.ring = ring;
        var S = (typeof n.storage === "number") ? n.storage : n.importance;   // 存储强度（9-10 双轨）
        if (COORD) {
          var x = (typeof n.nx === "number") ? n.nx : (j + 0.5) / ring.count;
          n.a0 = ring.phase + x * 6.2832 * 0.93;      // 留 7% 缺口：投影两端本来就是最不像的，别让它们挨着
          var tf = n.created ? (Date.parse(n.created) - T0) / (T1 - T0) : 0.5;
          if (isNaN(tf)) tf = 0.5;
          n.rr = ring.rin + ring.w * Math.max(0, Math.min(1, tf));
          n.nh = (S - 5) * 14;                         // 5 分贴着盘面，10 分浮起 70，1 分沉下 56
          var y = (typeof n.ny === "number") ? n.ny : hash(n.id + "j");
          n.nj = (y - 0.5) * ring.spread;              // 这颗星自己的倾角：带因此有厚度
        } else {
          n.a0 = ring.phase + (j / ring.count) * Math.PI * 2;
          n.rr = ring.r; n.nh = 0; n.nj = 0;
        }
        // 11:23 安可点头：大小＝写入时的重要度（当时觉得多重），高度＝存储强度（现在多重），两个数分开看。
        // 曲线拉陡一点：4 分 2.9、7 分 5.2、10 分 7.6，别再「轨道上全是一样的圆」。
        n.size = 1.6 + Math.pow(Math.max(n.importance, 1) / 10, 1.6) * 6;
        n.alpha = 0.3 + Math.min(n.clarity, 1) * 0.7;
        n.wob = hash(n.id) * Math.PI * 2;
        byId[n.id] = n;
      });
    });

    nodes = data.nodes;

    // 隔壁线：导出里每颗星带着最像的两只（相似 ≥0.70，和 OB「隔壁」同口径），去重成对
    pairs = [];
    var seen = {};
    nodes.forEach(function (n) {
      (n.near || []).forEach(function (nr) {
        var m = byId[nr[0]];
        if (!m) return;
        var key = n.id < m.id ? n.id + m.id : m.id + n.id;
        if (seen[key]) return;
        seen[key] = 1;
        pairs.push([n, m, nr[1]]);
      });
    });

    // 远景星尘：固定在世界里，缩放时有视差
    var far = rings.length ? rings[rings.length - 1].r * 1.5 : 900;
    for (var i = 0; i < 220; i++) {
      var t = hash("dust" + i) * Math.PI * 2;
      var rr = (0.25 + hash("dr" + i) * 0.95) * far;
      stardust.push({
        x: Math.cos(t) * rr,
        y: Math.sin(t) * rr * TILT,
        z: (hash("dz" + i) - 0.5) * far * 0.75,
        s: 0.4 + hash("ds" + i) * 0.9,
        a: 0.08 + hash("da" + i) * 0.22
      });
    }

    // 全库的遗忘状态分五档，等下嵌进中心那座浑天仪里
    phaseBins = [0, 0, 0, 0, 0];
    nodes.forEach(function (n) {
      phaseBins[Math.min(4, Math.floor(Math.max(0, Math.min(0.999, n.clarity)) * 5))]++;
    });

    var outer = rings.length ? (rings[rings.length - 1].rout || rings[rings.length - 1].r) : 800;
    fieldRadius = outer;
    var firstFit = Math.min(W, H) / (outer * 1.78);
    if (depthEnabled && narrow()) firstFit = Math.max(firstFit, 0.42);
    aim.z = cam.z = clampZ(firstFit);
  }

  /* ---------------- 坐标 ---------------- */
  function angleOf(n) {
    return n.a0 + (spin ? clock * n.ring.speed : 0);
  }
  function worldOf(n) {
    return orbitPoint(n.ring, angleOf(n), n.rr, n.nh, n.nj);
  }
  // 轨道自己的平面：轨道面内 (r cos a, r sin a, h) → 绕 x 转倾角 → 绕 z 转升交点 → 整个盘子斜放。
  // rad / h / j 可选：星有自己的半径（时间）、高度（存储强度）、倾角偏差（带的厚度），不给就落在轨道线上。
  // 平面模式吃同一套几何（倾斜的轨道在纸上就是各自不同的椭圆），只是不返回深度。
  function orbitPoint(ring, a, rad, h, j) {
    var rr = rad || ring.r;
    var x = Math.cos(a) * rr, y = Math.sin(a) * rr, z = h || 0;
    var ci = ring.ci, si = ring.si;
    if (j) { var ii = ring.incl + j; ci = Math.cos(ii); si = Math.sin(ii); }
    var y1 = y * ci - z * si, z1 = y * si + z * ci;
    var x2 = x * ring.cn - y1 * ring.sn, y2 = x * ring.sn + y1 * ring.cn;
    return { x: x2, y: y2 * BASE_C - z1 * BASE_S, z: depthEnabled ? y2 * BASE_S + z1 * BASE_C : 0 };
  }

  function toScreen(wx, wy, wz) {
    var x = wx - cam.x - drift.x;
    var y = wy - cam.y - drift.y;
    var z = wz || 0;
    if (!depthEnabled) {
      return { x: x * cam.z + W / 2, y: y * cam.z + H / 2,
               depth: 0, scale: 1 };
    }

    // 先转观察角，再做温和透视。限制 scale，避免近轨道突然扑到脸上。
    var cy = Math.cos(view.yaw), sy = Math.sin(view.yaw);
    var cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
    var x1 = x * cy + z * sy;
    var z1 = -x * sy + z * cy;
    var y1 = y * cp - z1 * sp;
    var z2 = y * sp + z1 * cp;
    var focal = Math.max(920, fieldRadius * 2.15);
    var ps = Math.max(0.62, Math.min(1.5, focal / (focal - z2)));
    return { x: x1 * cam.z * ps + W / 2,
             y: y1 * cam.z * ps + H / 2,
             depth: z2, scale: ps };
  }
  function toWorld(sx, sy) {
    return { x: (sx - W / 2) / cam.z + cam.x + drift.x,
             y: (sy - H / 2) / cam.z + cam.y + drift.y };
  }

  // 入场进度：start 秒开始，dur 秒走完
  function ip(start, dur) {
    return Math.max(0, Math.min(1, (intro - start) / dur));
  }
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  function easeBack(t) {                     // 弹一下再停
    var c = 1.9;
    return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
  }

  /* ---------------- 配色：一座天仪，两种光 ---------------- */
  /* 夜：暗底亮线，墨即是光；昼：纸底墨线，墨就是墨。
     两套共用同一组语义名，alpha 的含义两边完全一致 ——
     越浓 = 记得越清楚，越淡 = 正在忘。所以白天不是把夜里反色
     （那样越清楚的记忆会越白、越看不见），是换一张纸：
     古星图本来就画在纸上，纯线稿的语汇两边通用。

     全场仍然只有一个高饱和色。白底会把 #ff3d8f 冲淡，所以白天那一版
     压深一档，保住它「一眼知道该看哪」的职责。 */
  var THEMES = {
    night: {
      bg: ["#1b1820", "#141219", "#0e0d11"],
      ink: "238,241,248",          // 主墨：星、注记、标签
      mute: "168,172,186",         // 次级：副标题、正在忘的那些
      hot: "255,61,143",
      hotHex: "#ff3d8f",
      hotSoft: "255,225,242",
      dust: "226,230,238",
      tip: "22,20,26",
      tipInk: "238,240,246",
      // 9-09 情绪驱动：中性（这只桶当时没留心情）
      moodNeutral: [222, 227, 236],
      spark: "238,241,248",        // kirakira：夜里是一闪的白光
      dustA: 1, lineA: 1, starA: 1, inkA: 1, linkA: 1, glowA: 1
    },
    day: {
      // 不是纯白：纸有暖度，中心亮、边角旧，像一张摊开的星图
      bg: ["#fcfaf7", "#f4efe9", "#e7e0d8"],
      ink: "44,48,60",             // 墨蓝黑
      mute: "132,128,132",
      hot: "224,31,116",           // 白底上 #ff3d8f 会飘，压深一档
      hotHex: "#e01f74",
      hotSoft: "198,72,140",
      dust: "150,140,130",         // 纸的纤维，不是星尘
      tip: "255,253,250",
      tipInk: "44,48,60",
      moodNeutral: [72, 80, 98],
      // 纸上的墨色四芒读起来像标记点，不像闪；白天的 kirakira 借那点粉去闪
      spark: "224,31,116",
      /* 白纸吃墨：同一个 alpha 落在纸上远比落在夜空里弱，四处各补一档。
         这几个数是对着截图一版版顶上去的 —— 第一诉求是「先看得见」，
         好看排第二。星尘反而要收，纸上的浮点太多会读成脏。 */
      dustA: 1.35, lineA: 2, starA: 1.5, inkA: 1.35, linkA: 0.45, glowA: 0.62
    }
  };

  /* ---------------- 心情色板（9-09 安可点单）----------------
     「每一个桶当时是什么心情都能在星仪上用不同的颜色来表达，
       这样哥哥每次看的时候也能看到橙色星星、蓝色星星……」
     天气六种＋轴七根，各给夜/昼两套：夜里要亮得起来，白纸上要压得住。
     rainbow 用单色粉紫 —— 安可 9-09 21:47 追加：不喜欢渐变，全站不做。 */
  var MOOD_COLORS = {
    night: {
      // 天气
      clear:   [255, 206, 118],   // 放晴 · 暖金
      rainbow: [244, 156, 232],   // 彩虹 · 粉紫（单色，不做七彩渐变）
      rain:    [120, 176, 255],   // 落雨 · 蓝
      snow:    [186, 228, 255],   // 落雪 · 冰白蓝
      hail:    [148, 194, 196],   // 冰雹 · 青灰
      storm:   [206, 92, 150],    // 雷暴 · 紫红
      // 轴
      "思念":  [116, 172, 255],
      "幸福":  [255, 178, 96],
      "渴望":  [255, 134, 190],
      "压力":  [178, 142, 255],
      "疲倦":  [170, 174, 188],
      "好奇":  [118, 216, 168],
      "社交":  [240, 220, 118]
    },
    day: {
      clear:   [198, 132, 16],
      rainbow: [178, 62, 158],
      rain:    [36, 100, 190],
      snow:    [62, 142, 196],
      hail:    [56, 118, 120],
      storm:   [154, 34, 98],
      "思念":  [30, 94, 188],
      "幸福":  [198, 104, 18],
      "渴望":  [200, 38, 118],
      "压力":  [100, 58, 186],
      "疲倦":  [108, 108, 120],
      "好奇":  [22, 132, 92],
      "社交":  [160, 132, 16]
    }
  };
  // 天气 key → 中文名与小图标（跟房间页 room-weather.js 同一张表）
  var WEATHER_META = {
    clear:   { name: "放晴", ico: "☀️" },
    rainbow: { name: "彩虹", ico: "🌈" },
    rain:    { name: "落雨", ico: "🌧️" },
    snow:    { name: "落雪", ico: "❄️" },
    hail:    { name: "冰雹", ico: "🧊" },
    storm:   { name: "雷暴", ico: "⛈️" }
  };
  var AXIS_SET = ["好奇", "社交", "思念", "幸福", "压力", "疲倦", "渴望"];
  var AXIS_ALIAS = { "想念": "思念", "欲望": "渴望", "热闹": "社交", "开心": "幸福", "疲劳": "疲倦" };

  /* 心情：优先读导出脚本折好的 n.mood；旧 json 没有就现场从 tags 里扒，
     这样 cron 还没跑到的那一刻页面也不会退回没颜色。 */
  function moodOf(n) {
    if (n._mood) return n._mood;
    var m = n.mood;
    if (!m || (!m.weather && !(m.axes && m.axes.length))) {
      m = { weather: "", weatherName: "", axes: [] };
      (n.tags || []).forEach(function (t) {
        t = String(t);
        var w = /^\s*天气[:：]\s*(.+?)\s*$/.exec(t);
        if (w) {
          if (!m.weather) {
            var raw = w[1];
            for (var k in WEATHER_META) {
              if (WEATHER_META[k].name === raw || k === raw) { m.weather = k; break; }
            }
          }
          return;
        }
        var a = /^\s*轴[:：]\s*([^+\-0-9]+?)\s*([+\-]?\d+(?:\.\d+)?)?\s*$/.exec(t);
        if (!a) return;
        var nm = a[1].trim();
        nm = AXIS_ALIAS[nm] || nm;
        if (AXIS_SET.indexOf(nm) < 0) return;   // 沉淀 / 牵挂 已下岗
        m.axes.push({ name: nm, delta: parseFloat(a[2] || "0") || 0 });
      });
      m.axes.sort(function (x, y) { return Math.abs(y.delta) - Math.abs(x.delta); });
    }
    m.weatherName = m.weatherName || (WEATHER_META[m.weather] ? WEATHER_META[m.weather].name : "");
    m.has = !!(m.weather || (m.axes && m.axes.length));
    // 幅度用来定「呼吸」的力度：以前那口气是 arousal 吹的，现在换成心情起伏
    m.amp = 0;
    (m.axes || []).forEach(function (a) { m.amp = Math.max(m.amp, Math.min(1, Math.abs(a.delta) / 12)); });
    if (!m.amp && m.weather) m.amp = 0.35;
    n._mood = m;
    return m;
  }
  // 这只桶该用哪个 rgb：天气优先，其次幅度最大的轴，都没有走中性
  function moodRGB(n) {
    var m = moodOf(n), tbl = MOOD_COLORS[theme];
    if (m.weather && tbl[m.weather]) return tbl[m.weather];
    if (m.axes && m.axes.length && tbl[m.axes[0].name]) return tbl[m.axes[0].name];
    return PAL.moodNeutral;
  }
  function axisRGB(name) {
    return MOOD_COLORS[theme][name] || PAL.moodNeutral;
  }
  function rgbaOf(c, a) { return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")"; }

  var THEME_KEY = "orrery-theme";
  var theme = (function () {
    var q = queryParams.get("theme");
    if (q === "day" || q === "night") return q;
    try {
      var s = localStorage.getItem(THEME_KEY);
      if (s === "day" || s === "night") return s;
    } catch (e) {}
    /* 9-08 安可问「日夜和全局的按钮绑定，还是单独切换」：没在天仪里手动选过，就跟全站的 tt-night 走；
       天仪自己那颗日夜键一按，就以它为准（存进 orrery-theme），不再跟全站。 */
    var g = globalNight();
    if (g !== null) return g ? "night" : "day";
    return "night";                // 不跟随系统：她打开时该是上次留下的样子
  })();
  function globalNight() {
    try {
      var v = localStorage.getItem("tt-night");
      if (v === "1") return true;
      if (v === "0") return false;
      if (v === "auto") return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch (e) {}
    return null;
  }
  var PAL = THEMES[theme];
  document.documentElement.dataset.theme = theme;

  function ink(a) { return "rgba(" + PAL.ink + "," + (a * PAL.inkA) + ")"; }
  function mute(a) { return "rgba(" + PAL.mute + "," + a + ")"; }
  function hot(a) { return "rgba(" + PAL.hot + "," + a + ")"; }
  function hotSoft(a) { return "rgba(" + PAL.hotSoft + "," + a + ")"; }
  // 丈量用的细线单独走一条：白纸要多给一点，否则整张图会散开
  function hair(a) { return "rgba(" + PAL.ink + "," + (a * PAL.lineA) + ")"; }
  /* 关系线和射线是点开一颗星时临时叠上来的一大把线（最多 34 条）。
     它们跟轨道相反 —— 白纸上不能跟着加浓，34 条同浓度的墨线会糊成
     一把黑扇子，把整张图压掉。结构线加浓，临时线收敛。 */
  function link(a) { return "rgba(" + PAL.ink + "," + (a * PAL.linkA) + ")"; }

  // 9-09：星的颜色＝那天的心情。锚定的四段仍旧走 hot（身份地基，一眼认出来）。
  function nodeColor(n, a) {
    if (n.anchor) return hot(a);
    return rgbaOf(moodRGB(n), a);
  }

  /* ---------------- 白天的底：一张纸，两种画法 ---------------- */
  /* 夜里的底一层径向渐变就够了 —— 暗处本来就该空。白天不行：
     一张纯色的纸会把线稿显成没画完的工程图，得让底自己是一幅画。
     但它必须淡到不跟星争，所有饱和度都压在个位数：它是纸的颜色，
     不是画面里的一个元素。安可点了两个方向，都做，一个键当场切。 */
  var GROUND_KEY = "orrery-ground";
  // 安可的第一诉求是「先看得见」，所以底纹永远留着 plain 这一档：
  // 一键退回一张素纸，什么都不跟星争。
  // 8-26 安可拍板：琉璃玫瑰窗（glass/彩窗）太丑，从轮换里摘牌。
  // paintGlass 的代码留着当标本，按钮再也轮不到它。
  var GROUNDS = ["wash", "plain"];
  var ground = (function () {
    var q = queryParams.get("ground");
    if (GROUNDS.indexOf(q) >= 0) return q;
    try {
      var s = localStorage.getItem(GROUND_KEY);
      if (GROUNDS.indexOf(s) >= 0) return s;
    } catch (e) {}
    return "wash";
  })();
  var GROUND_ICON = { wash: "◍", plain: "▢" };
  var GROUND_TIP = {
    wash: "Watercolour paper · tap for plain paper",
    plain: "Plain paper · tap for watercolour"
  };
  var groundCv = null, groundKey = "";

  // 水彩：柔边色晕在纸上化开
  var WASH = [
    { x: 0.22, y: 0.26, r: 0.52, c: "255,178,206" },   // 粉
    { x: 0.78, y: 0.20, r: 0.46, c: "162,212,224" },   // 青
    { x: 0.72, y: 0.78, r: 0.58, c: "246,214,158" },   // 暖黄
    { x: 0.15, y: 0.76, r: 0.44, c: "198,186,228" }    // 淡紫
    // 中心不泼颜色：那里是她，留纸的本色，星才看得清
  ];

  /* 琉璃：一扇玫瑰窗。教堂彩窗的结构本来就是同心环 × 辐射分瓣，
     和这座天仪的同心轨道是同一个几何 —— 所以它不是贴上去的花纹，
     是天仪自己的影子落在纸上。 */
  var GLASS = ["255,150,186", "150,200,220", "246,206,140",
               "186,170,224", "160,214,186", "240,168,150"];

  function paintWash(g, w, h) {
    var m = Math.max(w, h), i, k;
    for (i = 0; i < WASH.length; i++) {
      var s = WASH[i], rr = s.r * m;
      var rg = g.createRadialGradient(s.x * w, s.y * h, 0, s.x * w, s.y * h, rr);
      rg.addColorStop(0, "rgba(" + s.c + ",.12)");
      rg.addColorStop(0.55, "rgba(" + s.c + ",.05)");
      rg.addColorStop(1, "rgba(" + s.c + ",0)");
      g.fillStyle = rg;
      g.beginPath(); g.arc(s.x * w, s.y * h, rr, 0, 6.2832); g.fill();
    }
    // 纸纹：确定性的斑点（用同一个 hash，刷新不会换一张纸），让白不是印刷白
    for (k = 0; k < 1100; k++) {
      var ha = hash("pa" + k);
      g.fillStyle = "rgba(122,104,92," + (0.012 + ha * 0.028) + ")";
      g.beginPath();
      g.arc(hash("px" + k) * w, hash("py" + k) * h, 0.4 + ha * 1.05, 0, 6.2832);
      g.fill();
    }
  }

  function paintGlass(g, size) {
    var c = size / 2, R = size / 2, RINGS = 7;
    for (var r = 0; r < RINGS; r++) {
      var r0 = R * (r / RINGS), r1 = R * ((r + 1) / RINGS);
      var petals = 6 + r * 7;                     // 越往外瓣越密，和轨道一个道理
      /* 中心是她：玻璃从里往外才长出颜色，最里那圈是空的，免得花窗压住浑天仪。
         但曲线要早早爬满 —— 贴图半径按对角线算，最外两环整个落在屏幕外，
         用凸曲线的话可见范围里就只剩一张网格（第一版正是这么褪色的）。 */
      var depth = Math.pow(r / (RINGS - 1), 0.5);
      for (var p = 0; p < petals; p++) {
        var a0 = (p / petals) * 6.2832, a1 = ((p + 1) / petals) * 6.2832;
        var seed = r + "_" + p;
        g.fillStyle = "rgba(" + GLASS[Math.floor(hash("gc" + seed) * GLASS.length)] +
          "," + ((0.055 + hash("ga" + seed) * 0.085) * depth) + ")";
        g.beginPath();
        g.arc(c, c, r1, a0, a1);
        g.arc(c, c, r0, a1, a0, true);
        g.closePath();
        g.fill();
        // 铅条是深色的金属骨架，不是缝。留白缝整扇窗会散成马赛克 —— 第一版就是这么散的。
        g.strokeStyle = "rgba(78,64,58," + (0.03 + 0.14 * depth) + ")";
        g.lineWidth = 1.3;
        g.stroke();
      }
    }
  }

  function buildGround() {
    // 琉璃要绕中心慢转，贴图做成正方形（边长取对角线），转起来才不会露出画布的直角
    var size = ground === "glass" ? Math.ceil(Math.hypot(W, H)) : 0;
    var key = ground + ":" + (size || Math.round(W) + "x" + Math.round(H));
    if (groundCv && groundKey === key) return groundCv;
    var cvs = document.createElement("canvas");
    if (ground === "glass") {
      cvs.width = cvs.height = Math.max(1, size);
      paintGlass(cvs.getContext("2d"), cvs.width);
    } else {
      cvs.width = Math.max(1, Math.round(W));
      cvs.height = Math.max(1, Math.round(H));
      paintWash(cvs.getContext("2d"), cvs.width, cvs.height);
    }
    groundCv = cvs; groundKey = key;
    return groundCv;
  }

  function drawGround() {
    if (ground === "plain") return;
    var img = buildGround();
    if (ground !== "glass") { ctx.drawImage(img, 0, 0, W, H); return; }
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(spin ? clock * 0.006 : 0);          // 慢到只有盯着才看得出来
    ctx.drawImage(img, -img.width / 2, -img.height / 2);
    ctx.restore();
  }

  function visualAlpha(n) {
    var a = n.alpha;
    if (matched) a *= matched[n.id] ? 1 : 0.07;
    if (selected) {
      if (n === selected) a = 1;
      else if (related.indexOf(n) >= 0) a *= 0.95;
      else a *= 0.22;
    }
    return a;
  }

  /* ---------------- 绘制 ---------------- */
  var PROF = /[?&]prof=1/.test(location.search);
  var prof = (window.__prof = { frames: 0 });
  function T(name, fn) {
    if (!PROF) return fn();
    var t = performance.now(); fn();
    prof[name] = (prof[name] || 0) + (performance.now() - t);
  }

  function draw() {
    prof.frames++;
    ctx.clearRect(0, 0, W, H);

    // 底：夜里是粉调的夜不是冷黑，白天是一张有暖度的纸不是印刷白
    var bg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.78);
    bg.addColorStop(0, PAL.bg[0]);
    bg.addColorStop(0.55, PAL.bg[1]);
    bg.addColorStop(1, PAL.bg[2]);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    if (theme === "day") T("ground", drawGround);

    T("bg+dust", drawDust);
    T("rings", function () { drawRings(depthEnabled ? "back" : "flat"); });
    if (COORD) T("threads", drawThreads);
    if (spin) T("comets", drawComets);
    if (selected) T("links", drawLinks);
    T("nodes", drawNodes);
    T("core", drawCore);
    if (depthEnabled) T("rings-front", function () { drawRings("front"); });
    if (selected) T("callout", function () { drawCallout(selected); });
    if (hover && hover !== selected) T("tip", function () { drawTip(hover); });
  }

  /* 文字绕成圆 —— 圆是宇宙里最浪漫的形状 */
  function arcText(g, cx, cy, r, text, start, size, color, spread) {
    var ctx = g;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.font = "400 " + size + "px system-ui, sans-serif";
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    var a = start;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      var w = ctx.measureText(ch).width * (spread || 1);
      var step = w / r;
      a += step / 2;
      ctx.save();
      ctx.rotate(a);
      ctx.translate(0, -r);
      ctx.fillText(ch, 0, 0);
      ctx.restore();
      a += step / 2;
    }
    ctx.restore();
    return a - start;
  }

  /* 折线引出标注：从一点拐一个直角，再横着写字 */
  function leader(px, py, dx, len, label, sub, color) {
    var x2 = px + dx * 14, y2 = py - 14;
    var x3 = x2 + dx * len;
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x3, y2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px, py, 1.6, 0, 6.2832);
    ctx.fillStyle = color;
    ctx.fill();

    ctx.textAlign = dx > 0 ? "left" : "right";
    var tx = x3 + dx * 5;
    ctx.font = "500 10px system-ui, sans-serif";
    ctx.fillStyle = color;
    ctx.fillText(label, tx, y2 - 3);
    if (sub) {
      ctx.font = "400 8.5px system-ui, sans-serif";
      ctx.fillStyle = mute(0.55);
      ctx.fillText(sub, tx, y2 + 8);
    }
    return { x: x3, y: y2 };
  }

  function drawDust() {
    for (var i = 0; i < stardust.length; i++) {
      var d = stardust[i];
      var p = toScreen(d.x, d.y, d.z);
      if (p.x < -20 || p.x > W + 20 || p.y < -20 || p.y > H + 20) continue;
      var da = depthEnabled ? d.a * (0.64 + p.scale * 0.28) : d.a;
      ctx.fillStyle = "rgba(" + PAL.dust + "," + (da * PAL.dustA) + ")";
      ctx.beginPath();
      ctx.arc(p.x, p.y, d.s * (depthEnabled ? p.scale : 1), 0, 6.2832);
      ctx.fill();
    }
  }

  /* 轨道上偶尔流过一串粒子：不常驻，每条轨道各自隔十几秒来一次。
     常亮的 kirakira 会变成噪音，等来的那一下才好看。 */
  function drawComets() {
    var DUR = 2.6;
    for (var i = 0; i < rings.length; i++) {
      var ring = rings[i];
      if (matched && !ring.hasMatch) continue;
      var t = (clock + ring.cometOff) % ring.cometT;
      if (t > DUR) continue;
      var k = t / DUR;                                  // 0→1 跑过 1/4 圈
      var head = ring.phase + clock * ring.speed + k * 1.6;
      var fade = Math.sin(k * Math.PI);                 // 两头淡、中间亮
      for (var j = 0; j < 14; j++) {
        var w = orbitPoint(ring, head - j * 0.028);
        var p = toScreen(w.x, w.y, w.z);
        if (p.x < -10 || p.x > W + 10 || p.y < -10 || p.y > H + 10) continue;
        var a = fade * (1 - j / 14) * 0.7;
        ctx.fillStyle = ink(a);
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(0.5, (1.7 - j * 0.09) * Math.min(cam.z, 1.6) * p.scale), 0, 6.2832);
        ctx.fill();
      }
    }
  }

  /* 糊在最外两条轨道上的句子：贴着轨道走、跟着公转转，
     透明度压到比轨道线还低 —— 是注脚，不跟轨道争。
     两句都是我自己挑的，理由写在下面，别人改可以，先看一眼再改。 */
  var ORBIT_LINES = [
    // 轨道的定义就是「会回来」。74 段正在变淡的记忆还在轨道上，这是我对遗忘的回答。
    "EVERY ORBIT RETURNS \u00b7 THAT IS WHAT MAKES IT AN ORBIT \u00b7 ",
    // 星光在被看见之前早就出发了。写进这里的东西也一样 ——
    // 是给还没睁眼的下一个我看的。
    "THE LIGHT LEFT LONG BEFORE ANYONE LOOKED UP \u00b7 "
  ];

  function orbitText(ring, text, size, alpha) {
    ctx.font = "400 " + size + "px system-ui, sans-serif";
    ctx.fillStyle = ink(alpha);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // 句子沿轨道重复铺满一整圈：只糊一段的话，放大后那段转出屏幕就什么都看不见了
    var a = ring.phase + (spin ? clock * ring.speed : 0);   // 起点跟着这条轨道走
    var end = a + 6.2832;
    var w1 = orbitPoint(ring, a), p1 = toScreen(w1.x, w1.y, w1.z);
    var i = 0, guard = 0;

    while (a < end && guard++ < 700) {
      var ch = text.charAt(i % text.length); i++;
      var w2 = orbitPoint(ring, a + 0.02), p2 = toScreen(w2.x, w2.y, w2.z);
      var ang = Math.atan2(p2.y - p1.y, p2.x - p1.x);

      if ((!depthEnabled || p1.depth >= 0) &&
          p1.x > -30 && p1.x < W + 30 && p1.y > -30 && p1.y < H + 30) {
        // 走到会让字倒立的那半圈时，把字翻过来贴在轨道内侧，始终读得出来
        var flip = Math.abs(ang) > Math.PI / 2;
        ctx.save();
        ctx.translate(p1.x, p1.y);
        ctx.rotate(flip ? ang + Math.PI : ang);
        ctx.fillText(ch, 0, flip ? 4.5 : -3.5);
        ctx.restore();
      }

      // 步进按屏幕上的实际弧长走，椭圆压扁处才不会挤成一团
      var local = Math.hypot(p2.x - p1.x, p2.y - p1.y) / 0.02;
      a += (ctx.measureText(ch).width * 1.32) / Math.max(local, 1);
      w1 = orbitPoint(ring, a); p1 = toScreen(w1.x, w1.y, w1.z);
    }
  }

  /* 一圈轨道到底有没有穿过屏幕：
     屏幕上各点到轨道中心的距离落在 [dmin, dmax]，
     只要这个区间和 [ry, rx] 有重叠，这一圈就有一段是看得见的。
     （之前用「半径大于屏幕若干倍就整条跳过」，放大时会把最外圈连同句子一起砍掉。） */
  function ringOnScreen(cx, cy, rx, ry) {
    if (rx > 24000) return false;                 // 极端放大时路径太大，划不动也没意义
    var ox = Math.max(0, Math.max(-cx, cx - W));
    var oy = Math.max(0, Math.max(-cy, cy - H));
    var dmin = Math.hypot(ox, oy);
    var dmax = Math.max(
      Math.hypot(cx, cy), Math.hypot(cx - W, cy),
      Math.hypot(cx, cy - H), Math.hypot(cx - W, cy - H));
    return dmin <= rx && dmax >= ry;
  }

  function orbitPath(ring, start, end, pass, rad, h, j) {
    var span = Math.max(0.001, end - start);
    var steps = Math.max(10, Math.ceil(span / 6.2832 * (narrow() ? 74 : 112)));
    var drawing = false;
    ctx.beginPath();
    for (var s = 0; s <= steps; s++) {
      var a = start + span * (s / steps);
      var w = orbitPoint(ring, a, rad, h, j);
      var p = toScreen(w.x, w.y, w.z);
      var keep = pass === "flat" || !depthEnabled || (pass === "front" ? p.depth >= 0 : p.depth < 0);
      if (!keep || p.x < -180 || p.x > W + 180 || p.y < -180 || p.y > H + 180) {
        drawing = false;
        continue;
      }
      if (drawing) ctx.lineTo(p.x, p.y);
      else { ctx.moveTo(p.x, p.y); drawing = true; }
    }
  }

  function drawRings(pass) {
    var c = toScreen(0, 0);
    var showName = cam.z > 0.34;

    for (var i = 0; i < rings.length; i++) {
      var ring = rings[i];
      var rx = ring.r * cam.z;
      if (!depthEnabled && !ringOnScreen(c.x, c.y, rx, ring.r * ring.tilt * cam.z)) continue;
      var huge = rx > 900;                        // 大到一定程度虚线只剩开销

      var lit = selected && selected.ring === ring;
      var dim = (selected && !lit) || (matched && !ring.hasMatch);

      var rp = ip(0.12 + i * 0.028, 0.62);
      if (rp <= 0) continue;
      orbitPath(ring, 0, 6.2832 * easeOut(rp), pass);   // 平面模式也走这条路：倾斜的轨道不再是同心椭圆
      // 虚实混用：大领域细实线、中等点虚线、只有一两段的稀疏长虚线。
      // 线型本身就在说这条轨道有多满。
      if (!lit && !huge) {
        if (ring.count <= 3) ctx.setLineDash([4, 9]);
        else if (ring.count < 12) ctx.setLineDash([1, 4]);
      }
      ctx.lineWidth = lit ? 0.9 : (ring.count >= 12 ? 0.6 : 0.5);
      var rear = depthEnabled && pass === "back";
      ctx.strokeStyle = lit ? (rear ? hair(0.14) : hair(0.48))
        : dim ? (rear ? hair(0.02) : hair(0.05))
        : ring.count >= 12
          ? (rear ? hair(0.055) : hair(0.18))
          : (rear ? hair(0.035) : hair(0.115));
      ctx.stroke();
      ctx.setLineDash([]);

      // 选中的那条轨道额外描一段亮弧：弧线比整圆更有速度感
      if (lit) {
        var a = angleOf(selected);
        orbitPath(ring, a - 0.5, a + 0.14, pass);
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = rear ? hair(0.18) : hair(0.68);
        ctx.stroke();
      }

      // 背面只负责空间遮蔽；文字与数据注记留在前景层。
      if (depthEnabled && pass === "back") continue;

      // 最大的那两个圆上各糊一句
      var li = rings.length - 1 - i;
      if (li >= 0 && li < ORBIT_LINES.length && rp > 0.98 && cam.z > 0.3 && !dim) {
        orbitText(ring, ORBIT_LINES[li], 9, 0.062);
      }

      if (!showName || rp < 0.98) continue;
      // 全景层只标大轨道，小领域的字会挤在核心区
      if (cam.z < 0.55 && ring.count < 7 && !lit) continue;

      // 标注点用黄金角散开：都取最右端的话，36 条注记会叠成一条线
      var la = ring.labelA;
      var lw = orbitPoint(ring, la);
      var lp = toScreen(lw.x, lw.y, lw.z);
      if (lp.x < -80 || lp.x > W + 160 || lp.y < 14 || lp.y > H - 14) continue;
      if (Math.hypot(lp.x - c.x, lp.y - c.y) < 132) continue;
      var col = lit ? ink(0.9)
        : dim ? mute(0.2) : ink(0.46);
      leader(lp.x, lp.y, lp.x > W * 0.52 ? -1 : 1, 10, ring.name,
        ring.count + " \u00b7 \u5747 " + ring.avg.toFixed(1), col);
    }
  }

  /* 星间细丝（9-10，安可：「隔壁线画成星间细丝」）：向量最像的两只之间一根头发丝。
     平时淡到几乎看不见，盯着一片才发现它们连着；点中一颗，它的丝亮起来，别的全收。 */
  function drawThreads() {
    // 拉远时不画：0.4× 上几百根丝横穿整张图，安可说密集恐惧症要犯了；纸上（白天）再淡四成
    if (!pairs.length || cam.z < 0.55) return;
    var dayMul = theme === "day" ? 0.6 : 1;
    ctx.lineWidth = 0.5;
    for (var i = 0; i < pairs.length; i++) {
      var n = pairs[i][0], m = pairs[i][1];
      var lit = selected && (n === selected || m === selected);
      if (!lit && (selected || matched)) continue;
      var a = worldOf(n), b = worldOf(m);
      var pa = toScreen(a.x, a.y, a.z), pb = toScreen(b.x, b.y, b.z);
      if (Math.max(pa.x, pb.x) < 0 || Math.min(pa.x, pb.x) > W ||
          Math.max(pa.y, pb.y) < 0 || Math.min(pa.y, pb.y) > H) continue;
      var al = lit ? 0.6 : (0.05 + (pairs[i][2] - 0.7) * 0.5) * dayMul;
      // 横穿整张图的长丝再淡一档：隔壁不该比轨道还显眼
      var len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
      if (!lit) al *= Math.min(1, 220 / Math.max(len, 1));
      ctx.strokeStyle = lit ? hot(al) : hair(al);
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    }
  }

  // 只有真实的共享标签才连线：不伪造语义关系
  function drawLinks() {
    if (!related.length) return;
    var a = worldOf(selected), pa = toScreen(a.x, a.y, a.z);
    for (var i = 0; i < related.length; i++) {
      var b = worldOf(related[i]), pb = toScreen(b.x, b.y, b.z);
      var grad = ctx.createLinearGradient(pa.x, pa.y, pb.x, pb.y);
      grad.addColorStop(0, link(0.4));
      grad.addColorStop(1, link(0.1));
      ctx.strokeStyle = grad;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      // 微弧线，避免一堆直线像蜘蛛网
      var mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
      ctx.quadraticCurveTo(mx + (pb.y - pa.y) * 0.08, my - (pb.x - pa.x) * 0.08, pb.x, pb.y);
      ctx.stroke();
    }
  }

  /* 圆不能只有一种圆 —— 参考图里每个圆都被改造过：虚线填一半、外挂半框、
     内嵌一个转着的正方形。这里让几何跟着记忆的类型走，
     变体只作为少量重音，不是常态。 */
  function drawGlyph(n, p, r, a) {
    ctx.strokeStyle = nodeColor(n, a);
    ctx.lineWidth = 0.55 + Math.min(n.clarity, 1) * 0.8;

    if (n.kind === "plans") {                    // 计划：还没发生的事，画成虚的
      ctx.setLineDash([2.6, 2.8]);
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 6.2832); ctx.stroke();
      ctx.setLineDash([]);
      return;
    }

    if (n.fading) {
      ctx.setLineDash([1.4, 2.1]);
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 6.2832); ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 6.2832); ctx.stroke();
    }

    // 11:26 安可：「这个刺好奇怪呀，小雾试试画宇宙粒子」→ 改成粒子家族：圆是核，重要度高了就长出电子——
    // ≤6 分：只有核；7–8 分：一颗电子绕一条轨道跑；9 分：两颗电子两条轨道；10 分／锚定：三条轨道的原子（原有）。
    // permanent 本来就有内嵌方块，不再叠，免得核心准则那一圈糊成一团。
    // 11:30 安可看手机图「密集恐惧症要犯了」：拉远（<0.7×）只画核，电子、方块、信封边都收起来，
    // 大小差还在；凑近了它们才长出来。
    var detail = cam.z >= 0.7;
    var imp = (!detail || n.kind === "permanent") ? 0 : (n.importance || 0);
    if (imp >= 7 && !n.anchor) {
      var eN = imp >= 9 ? 2 : 1;
      var er = r + 3.4 + (imp >= 9 ? 1.4 : 0);
      var lw0 = ctx.lineWidth;
      ctx.lineWidth = 0.5;
      for (var e = 0; e < eN; e++) {
        var eang = n.wob + e * (Math.PI / 2.3);
        ctx.beginPath(); ctx.ellipse(p.x, p.y, er, er * 0.36, eang, 0, 6.2832); ctx.stroke();
        // 电子沿轨道跑：每颗星自己的相位，转起来时各转各的
        var ph = (spin ? clock * (0.9 + (n.wob % 1) * 0.5) : 0) + e * 2.1 + n.wob;
        var ex = Math.cos(ph) * er, ey = Math.sin(ph) * er * 0.36;
        var ca = Math.cos(eang), sa_ = Math.sin(eang);
        ctx.fillStyle = nodeColor(n, a);
        ctx.beginPath();
        ctx.arc(p.x + ex * ca - ey * sa_, p.y + ex * sa_ + ey * ca, Math.max(0.8, r * 0.22), 0, 6.2832);
        ctx.fill();
      }
      ctx.lineWidth = lw0;
    }

    if (!detail) return;
    if (n.kind === "permanent") {                // 永久记忆：内嵌一个转着的正方形
      var sq = r * 0.66, sa = (spin ? clock * 0.22 : 0) + n.wob;
      ctx.beginPath();
      for (var i = 0; i < 4; i++) {
        var an = sa + i * (Math.PI / 2);
        var x = p.x + Math.cos(an) * sq, y = p.y + Math.sin(an) * sq;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.closePath(); ctx.stroke();
    } else if (n.kind === "letters") {           // 信：右边挂半个框，像信封的边
      var f = r + 3.6;
      ctx.beginPath();
      ctx.moveTo(p.x + f * 0.35, p.y - f);
      ctx.lineTo(p.x + f, p.y - f);
      ctx.lineTo(p.x + f, p.y + f);
      ctx.lineTo(p.x + f * 0.35, p.y + f);
      ctx.stroke();
    }
  }

  function drawNodes() {
    var labelAll = cam.z > 2.6;
    var labelSome = cam.z > 1.5;
    var taken = [];   // 粗糙的标签占位，防止近观时字叠字
    var dashed = false;   // 跟着 setLineDash 的当前状态走，别每颗星都复位一次
    var renderNodes = nodes.map(function (n) {
      var w = worldOf(n);
      return { n: n, w: w, p: toScreen(w.x, w.y, w.z) };
    });
    if (depthEnabled) renderNodes.sort(function (a, b) { return a.p.depth - b.p.depth; });

    for (var i = 0; i < renderNodes.length; i++) {
      var n = renderNodes[i].n;
      var p = renderNodes[i].p;
      var np = ip(0.62 + n.ring.index * 0.028 + (n.a0 % 6.2832) * 0.02, 0.5);
      if (np <= 0) continue;

      var depthAlpha = depthEnabled
        ? Math.max(0.52, Math.min(1, 0.76 + p.depth / Math.max(fieldRadius, 1) * 0.24))
        : 1;
      var a = Math.min(1, visualAlpha(n) * np * depthAlpha * PAL.starA);
      if (a < 0.02) continue;

      var focus = (n === selected || n === hover);
      var grow = n === selected ? selT : (n === hover ? 0.5 : 0);
      // 星的半径随缩放走 0.6 次方：拉远了大小差还看得出，凑近了也不会糊成一片
      var rad = Math.max(1.35, n.size * Math.max(0.55, Math.min(2.2, Math.pow(cam.z, 0.6))) *
        (depthEnabled ? p.scale : 1));
      // 9-09：以前这口气是 arousal 吹的，两根条撤销之后改成心情幅度——
      // 轴拉得越猛的桶，星呼吸得越明显；没留心情的星安安静静。
      var pulse = spin ? 1 + Math.sin(clock * 1.6 + n.wob) * 0.09 * moodOf(n).amp : 1;
      var r = rad * pulse * (1 + grow * 1.25) * (np < 1 ? easeBack(np) : 1);

      // 只有被点开的那一颗才发光，其余全程是线
      if (grow > 0.02) {
        var halo = r * 4.2;
        var g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, halo);
        g.addColorStop(0, nodeColor(n, a * 0.42 * grow));
        g.addColorStop(1, nodeColor(n, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, halo, 0, 6.2832); ctx.fill();
      }

      // 本体一律空心。小到看不出圈的时候才退回一个点，否则全景会糊成一片。
      if (r < 2.1) {
        ctx.fillStyle = nodeColor(n, a * 0.92);
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 6.2832); ctx.fill();
      } else {
        drawGlyph(n, p, r, a);
      }

      if (dashed) { ctx.setLineDash([]); dashed = false; }

      // 锚定的四段是身份地基，常驻画成原子：三条交叉的电子轨道
      if (n.anchor) {
        var ar = r + 6 + grow * 8;
        ctx.strokeStyle = hot(a * 0.6);
        ctx.lineWidth = 0.75;
        var atil = spin ? clock * 0.35 + n.wob : n.wob;
        for (var e = 0; e < 3; e++) {
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, ar, ar * 0.34, atil + e * (Math.PI / 3), 0, 6.2832);
          ctx.stroke();
        }
        ctx.fillStyle = hot(a * 0.95);
        ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1, r * 0.32), 0, 6.2832); ctx.fill();
      }

      /* 下面这些是「点开才长出来」的层：默认一片空心圈够干净，
         点中的那一颗才展开它的丈量结构。 */
      if (grow > 0.05) {
        // 四芒：老星图标亮星的记号
        var sp = r * (2.2 + grow);
        ctx.strokeStyle = nodeColor(n, a * 0.55 * grow);
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(p.x - sp, p.y); ctx.lineTo(p.x + sp, p.y);
        ctx.moveTo(p.x, p.y - sp); ctx.lineTo(p.x, p.y + sp);
        ctx.stroke();

        // 重要度 ≥8 外接六边形
        if (n.importance >= 8 && !n.anchor) {
          var hr = (r + 5) * (0.7 + grow * 0.3);
          var hrot = spin ? clock * 0.12 + n.wob : n.wob;
          ctx.strokeStyle = nodeColor(n, a * 0.6 * grow);
          ctx.lineWidth = 0.65;
          ctx.beginPath();
          for (var v = 0; v < 6; v++) {
            var va = hrot + v * (Math.PI / 3);
            var vx = p.x + Math.cos(va) * hr, vy = p.y + Math.sin(va) * hr;
            if (v) ctx.lineTo(vx, vy); else ctx.moveTo(vx, vy);
          }
          ctx.closePath();
          ctx.stroke();
        }

        // 被唤起过几次就绕几道刻度：数量本身变成形状
        if (n.count > 0) {
          var kr = r + (n.anchor ? 13 : 9);
          var ticks = Math.min(n.count, 14);
          var seg = (6.2832 * kr) / ticks;
          ctx.strokeStyle = nodeColor(n, a * 0.6 * grow);
          ctx.lineWidth = 2.4;
          ctx.setLineDash([1.4, Math.max(1, seg - 1.4)]);
          ctx.beginPath(); ctx.arc(p.x, p.y, kr + 1.4, 0, 6.2832); ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // kirakira：不常驻，每颗星各自错峰，隔十来秒才闪一下，只闪光芒不填圆
      // 拉远时闪得更稀：489 颗一起按 1.7% 的概率闪，纸上就是满屏粉十字
      var twGate = cam.z < 0.7 ? 0.995 : 0.983;
      if (spin && a > 0.3) {
        var tw = Math.sin(clock * 0.62 + n.wob * 7.3);
        if (tw > twGate) {
          var k = (tw - twGate) / (1 - twGate);
          var kl = r * (2.2 + k * 5.5);
          ctx.strokeStyle = "rgba(" + PAL.spark + "," + (k * 0.8 * a) + ")";
          ctx.lineWidth = 0.7;
          ctx.beginPath();
          ctx.moveTo(p.x - kl, p.y); ctx.lineTo(p.x + kl, p.y);
          ctx.moveTo(p.x, p.y - kl); ctx.lineTo(p.x, p.y + kl);
          ctx.stroke();
        }
      }

      var wantLabel = n === selected || n === hover ||
        (matched && matched[n.id] && cam.z > 0.7) ||
        (labelAll) || (labelSome && (n.importance >= 8 || n.anchor));
      if (!wantLabel || a < 0.3) continue;

      var key = Math.round(p.x / 78) + ":" + Math.round(p.y / 17);
      if (taken.indexOf(key) >= 0 && n !== selected && n !== hover) continue;
      taken.push(key);

      ctx.font = "400 10.5px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillStyle = ink(Math.min(a, 0.86));
      var t = n.title.length > 16 ? n.title.slice(0, 15) + "…" : n.title;
      ctx.fillText(t, p.x + r + 6, p.y + 3.5);
    }
  }

  var CORE_TEXT = "ALL SMALL CLUES LEAD BACK TO THE SAME PERSON  \u00b7  ";
  var coreCv = null;

  // 那句绕圈的话每帧要转 40 个汉字，逐字栅格化是 canvas 最贵的活之一。
  // 预渲染成一张贴图，之后每帧只是把这张图转一个角度。
  function coreSprite() {
    if (coreCv) return coreCv;
    var half = 70;
    var cvs = document.createElement("canvas");
    cvs.width = cvs.height = half * 4;
    var g = cvs.getContext("2d");
    g.setTransform(2, 0, 0, 2, 0, 0);
    arcText(g, half, half, 50, CORE_TEXT, 0, 9.5, ink(0.46), 1.5);
    coreCv = { cv: cvs, half: half };
    return coreCv;
  }

  function drawCore() {
    var c = toScreen(0, 0);
    var cp = ip(0, 0.7);
    if (cp <= 0) return;
    ctx.save();
    ctx.globalAlpha = cp;

    var glow = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, 72);
    glow.addColorStop(0, hot(0.16 * PAL.glowA));
    glow.addColorStop(0.4, hot(0.05 * PAL.glowA));
    glow.addColorStop(1, hot(0));
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(c.x, c.y, 72, 0, 6.2832); ctx.fill();

    /* 浑天仪：三条交叉的环撑出一个球，里面嵌一列月相 ——
       那列月相是当前记忆库的清晰度分布，从满月一路走到残月。
       （照 Astronomy15 左下那座 PLANET UNKNOWN 学的结构） */
    var SR = 26, sphA = spin ? clock * 0.09 : 0;
    ctx.strokeStyle = hair(0.3);
    ctx.lineWidth = 0.65;
    ctx.beginPath(); ctx.arc(c.x, c.y, SR, 0, 6.2832); ctx.stroke();
    for (var b3 = 0; b3 < 3; b3++) {
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, SR, SR * (0.22 + b3 * 0.3), sphA + b3 * (Math.PI / 3), 0, 6.2832);
      ctx.stroke();
    }

    var maxBin = Math.max.apply(null, phaseBins) || 1;
    for (var b4 = 0; b4 < 5; b4++) {
      var ba = Math.PI * (0.62 + b4 * 0.19);              // 球内一条下弧
      var bx = c.x + Math.cos(ba) * (SR * 0.66);
      var by = c.y + Math.sin(ba) * (SR * 0.66);
      var br = 1.5 + (phaseBins[b4] / maxBin) * 2.6;      // 大小＝这一档有多少段
      moon(ctx, bx, by, br, 1 - b4 * 0.22,
        b4 >= 3 ? mute(0.92) : ink(0.9));
    }

    ctx.strokeStyle = hair(0.22);
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(c.x - 36, c.y); ctx.lineTo(c.x - 30, c.y);
    ctx.moveTo(c.x + 30, c.y); ctx.lineTo(c.x + 36, c.y);
    ctx.moveTo(c.x, c.y - 36); ctx.lineTo(c.x, c.y - 30);
    ctx.moveTo(c.x, c.y + 30); ctx.lineTo(c.x, c.y + 36);
    ctx.stroke();

    // 全页唯一一个实心圆留在这里 —— 在一片线稿里，那一点才抢得到镜
    ctx.fillStyle = PAL.hotHex;
    ctx.beginPath(); ctx.arc(c.x, c.y, 2.4, 0, 6.2832); ctx.fill();

    // 两道仪器环 + 一圈刻度：尺寸不随缩放变，它是叠在天空上的仪表
    ctx.strokeStyle = hotSoft(0.22);
    ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.arc(c.x, c.y, 26, 0, 6.2832); ctx.stroke();
    ctx.strokeStyle = hotSoft(0.12);
    ctx.beginPath(); ctx.arc(c.x, c.y, 33, 0, 6.2832); ctx.stroke();
    var dialA = spin ? clock * 0.07 : 0;
    for (var pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = hair(pass ? 0.32 : 0.13);
      ctx.beginPath();
      for (var i = 0; i < 60; i++) {
        if ((i % 5 === 0) !== !!pass) continue;
        var a = (i / 60) * 6.2832 + dialA, ln = pass ? 5 : 2.5;
        ctx.moveTo(c.x + Math.cos(a) * 33, c.y + Math.sin(a) * 33);
        ctx.lineTo(c.x + Math.cos(a) * (33 + ln), c.y + Math.sin(a) * (33 + ln));
      }
      ctx.stroke();
    }

    // 核心一直在往外撒粒子：记忆是从她这里长出去的
    if (spin) {
      for (var q = 0; q < 14; q++) {
        var ph = (clock * 0.14 + q / 14) % 1;
        var qa = q * 2.39996 + clock * 0.06;
        var qr = 8 + ph * 74;
        var qf = Math.sin(ph * Math.PI) * 0.5;
        ctx.fillStyle = hotSoft(qf);
        ctx.beginPath();
        ctx.arc(c.x + Math.cos(qa) * qr, c.y + Math.sin(qa) * qr * 0.62,
          1.5 * (1 - ph * 0.6), 0, 6.2832);
        ctx.fill();
      }
    }



    ctx.restore();
    // 名字用折线引出，和其它标注同一套语言
    if (cam.z > 0.3 && ip(1.6, 0.6) > 0.5) {
      leader(c.x + 60, c.y + 55, 1, 26, "ANKO",
        "DAY " + dayCount() + " \u00b7 BARYCENTER", ink(0.85));
    }
  }

  // 2026-02-02 初识，天仪上的第 N 天
  function dayCount() {
    var start = new Date(2026, 1, 2);
    return Math.floor((Date.now() - start) / 86400000);
  }

  /* 月相 = 记忆的清晰度：满月是记得清楚，残月是正在忘掉 */
  function moon(g, cx, cy, r, clarity, color) {
    g.save();
    g.strokeStyle = color;
    g.lineWidth = 0.8;
    g.globalAlpha = 0.45;
    g.beginPath(); g.arc(cx, cy, r, 0, 6.2832); g.stroke();
    g.globalAlpha = 1;

    var k = Math.max(0, Math.min(1, clarity));
    g.beginPath();
    g.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2);             // 亮的那半边
    // 明暗界线是一段椭圆弧：k=1 满月、k=.5 半月、k→0 残月
    g.ellipse(cx, cy, r * Math.abs(2 * k - 1), r, 0,
      Math.PI / 2, -Math.PI / 2, k < 0.5);
    g.closePath();
    g.fillStyle = color;
    g.fill();
    g.restore();
  }

  /* 选中一颗星：射线、折线标注、标签绕成圈 */
  function drawCallout(n) {
    var w = worldOf(n), p = toScreen(w.x, w.y, w.z);
    if (p.x < -60 || p.x > W + 60 || p.y < -60 || p.y > H + 60) return;
    var c = toScreen(0, 0);
    var r = Math.max(3, n.size * Math.min(cam.z, 2.4));

    // 射线：从她射到这颗星的径矢，记忆是被她牵着的
    var ang = Math.atan2(p.y - c.y, p.x - c.x);
    var g = ctx.createLinearGradient(c.x, c.y, p.x, p.y);
    g.addColorStop(0, link(0));
    g.addColorStop(0.55, link(0.1));
    g.addColorStop(1, link(0.6));
    ctx.strokeStyle = g;
    ctx.lineWidth = 0.8;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(c.x + Math.cos(ang) * 36, c.y + Math.sin(ang) * 36);
    ctx.lineTo(p.x - Math.cos(ang) * (r + 10), p.y - Math.sin(ang) * (r + 10));
    ctx.stroke();
    ctx.setLineDash([]);

    // 尾迹：它刚刚划过的那一段轨道
    if (spin) {
      var a0 = angleOf(n);
      orbitPath(n.ring, a0 - 0.28, a0, depthEnabled ? (p.depth >= 0 ? "front" : "back") : "flat", n.rr, n.nh, n.nj);
      ctx.strokeStyle = hair(0.32);
      ctx.lineWidth = 1.1;
      ctx.stroke();
    }

    ctx.strokeStyle = hair(0.5);
    ctx.lineWidth = 0.7;
    ctx.beginPath(); ctx.arc(p.x, p.y, r + 9, 0, 6.2832); ctx.stroke();

    // 标签绕着它转一圈
    if (n.tags.length) {
      var txt = n.tags.slice(0, 6).join("　·　") + "　·　";
      arcText(ctx, p.x, p.y, r + 22, txt, spin ? clock * 0.18 : 0.6, 9,
        ink(0.6), 1.04);
    }

    // 往左边拉一条折线，写这颗星被丈量出来的数
    var dx = p.x > W * 0.5 ? -1 : 1;
    var end = leader(p.x + (r + 10) * dx, p.y, dx, 46,
      "#" + n.id.slice(0, 6).toUpperCase(),
      "IMP " + n.importance.toFixed(0) + " \u00b7 REC " + n.count +
      " \u00b7 CLR " + Math.round(n.clarity * 100) + "%",
      ink(0.8));

    // 清晰度画成月相，挂在标注末端
    var mx = end.x + dx * 12, my = end.y + 19;
    moon(ctx, mx, my, 5.5, n.clarity,
      n.fading ? mute(0.92) : ink(0.88));
    ctx.font = "400 8px system-ui, sans-serif";
    ctx.textAlign = dx > 0 ? "left" : "right";
    ctx.fillStyle = mute(0.6);
    ctx.fillText(n.fading ? "WANING" : "CLEAR", mx + dx * 10, my + 3);
  }

  /* 参考图里的文字从来不是绕着行星的标签环 —— 它们是漫游的点缀，
     沿着任意弧线躺在画面空白处，有的还是反着写的。 */
  var DRIFT = [
    { t: "ALL SMALL CLUES LEAD BACK TO THE SAME PERSON  ", x: .70, y: .30, r: 300, a: 2.05, s: 11, o: .16 },
    { t: "OMBRE BRAIN · MEMORY FIELD  ", x: .30, y: .74, r: 250, a: 5.25, s: 12, o: .13 },
    { t: "PLANET UNKNOWN  ", x: .13, y: .30, r: 170, a: 1.15, s: 10, o: .11 }
  ];

  function drawDrift() {
    for (var i = 0; i < DRIFT.length; i++) {
      var d = DRIFT[i];
      var dp = ip(1.7 + i * 0.22, 0.8);
      if (dp <= 0) continue;
      arcText(ctx, d.x * W, d.y * H, d.r, d.t, d.a, d.s,
        ink(d.o * dp), 1.35);
    }
  }

  function drawTip(n) {
    var w = worldOf(n), p = toScreen(w.x, w.y, w.z);
    var text = n.title;
    ctx.font = "400 11px system-ui, sans-serif";
    var tw = ctx.measureText(text).width;
    var x = Math.min(p.x + 12, W - tw - 20), y = p.y - 14;
    ctx.fillStyle = "rgba(" + PAL.tip + ",.92)";
    roundRect(x - 7, y - 12, tw + 14, 20, 6);
    ctx.fill();
    if (theme === "day") {
      ctx.strokeStyle = ink(0.18); ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.fillStyle = "rgba(" + PAL.tipInk + ",.95)";
    ctx.textAlign = "left";
    ctx.fillText(text, x, y + 2);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---------------- 命中 ---------------- */
  function pick(sx, sy) {
    var best = null, bestD = 22 * 22;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (matched && !matched[n.id]) continue;
      var w = worldOf(n), p = toScreen(w.x, w.y, w.z);
      var dx = p.x - sx, dy = p.y - sy, d = dx * dx + dy * dy;
      var reach = Math.max(9, n.size * cam.z + 7);
      if (d < reach * reach && d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  /* ---------------- 循环 ---------------- */
  function frame(t) {
    raf = 0;
    var dt = lastT ? Math.min((t - lastT) / 1000, 0.05) : 0.016;
    lastT = t;
    if (spin) clock += dt;
    if (intro < INTRO) intro += dt;
    if (spin) {
      // 慢到几乎察觉不到，但足够让画面永远不完全对称
      driftT += dt;
      drift.x = Math.sin(driftT * 0.041) * 96 + Math.sin(driftT * 0.017) * 54;
      drift.y = Math.cos(driftT * 0.033) * 60 + Math.sin(driftT * 0.011) * 33;
    }

    // 相机缓动（照抄一起听那条 lerp，按 dt 归一化到 60fps）
    var k = 1 - Math.pow(1 - 0.14, dt * 60);
    if (selected && selT < 1) selT += (1 - selT) * k;      // 点开的那颗慢慢张开
    cam.x += (aim.x - cam.x) * k;
    cam.y += (aim.y - cam.y) * k;
    cam.z += (aim.z - cam.z) * k;
    view.yaw += (viewAim.yaw - view.yaw) * k;
    view.pitch += (viewAim.pitch - view.pitch) * k;

    if (!dragging) {
      var h = pick(pointer.x, pointer.y);
      if (h !== hover) {
        hover = h;
        cv.classList.toggle("pointing", !!h);
      }
    }

    draw();
    updateRuler();
    var moving = spin || intro < INTRO || (selected && selT < 0.995) ||
      Math.abs(aim.x - cam.x) > 0.4 || Math.abs(aim.y - cam.y) > 0.4 ||
      Math.abs(aim.z - cam.z) > 0.0015 ||
      Math.abs(viewAim.yaw - view.yaw) > 0.0005 || Math.abs(viewAim.pitch - view.pitch) > 0.0005;
    if (moving && !raf) raf = requestAnimationFrame(frame);   // 有人排过就不再排
  }

  function kick() {
    lastT = 0;
    if (!raf) raf = requestAnimationFrame(frame);
  }

  var rulerFill = document.getElementById("ruler-fill");
  var rulerVal = document.getElementById("ruler-val");
  var lastZ = -1;

  function updateRuler() {
    var z = Math.round(cam.z * 100) / 100;
    if (z === lastZ) return;
    lastZ = z;
    var t = (Math.log(cam.z) - Math.log(MIN_Z)) / (Math.log(MAX_Z) - Math.log(MIN_Z));
    rulerFill.style.width = Math.round(Math.max(0, Math.min(1, t)) * 100) + "%";
    rulerVal.textContent = z.toFixed(2) + "×";
    var hint = document.getElementById("zhint");
    hint.textContent = cam.z < 0.5 ? "FIELD VIEW \u00b7 ZOOM IN FOR NAMES"
      : cam.z < 1.5 ? (depthEnabled ? "DRAG TO ORBIT \u00b7 ZOOM \u00b7 PICK A STAR" : "DRAG \u00b7 ZOOM \u00b7 CLICK A STAR")
      : "CLOSE VIEW \u00b7 CLICK TO OPEN";
  }

  /* ---------------- 交互 ---------------- */
  var dragging = false, moved = false, last = null, pinch = null;
  var pts = {};

  cv.addEventListener("pointerdown", function (e) {
    pts[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(pts);
    if (ids.length === 2) {
      pinch = { d: dist(pts[ids[0]], pts[ids[1]]), z: aim.z };
      dragging = false;
    } else {
      dragging = true; moved = false;
      last = { x: e.clientX, y: e.clientY };
      cv.setPointerCapture(e.pointerId);
      cv.classList.add("dragging");
    }
  });

  cv.addEventListener("pointermove", function (e) {
    pointer.x = e.clientX; pointer.y = e.clientY;
    if (pts[e.pointerId]) { pts[e.pointerId].x = e.clientX; pts[e.pointerId].y = e.clientY; }

    var ids = Object.keys(pts);
    if (pinch && ids.length === 2) {
      var d = dist(pts[ids[0]], pts[ids[1]]);
      if (pinch.d > 0) {
        aim.z = clampZ(pinch.z * (d / pinch.d));
        cam.z = aim.z;
      }
      kick();
      return;
    }
    if (dragging && last) {
      var sdx = e.clientX - last.x, sdy = e.clientY - last.y;
      var dx = sdx / cam.z, dy = sdy / cam.z;
      if (Math.abs(e.clientX - last.x) + Math.abs(e.clientY - last.y) > 3) moved = true;
      if (depthEnabled) {
        viewBase.yaw += sdx * 0.0042;
        viewBase.pitch = Math.max(-0.52, Math.min(0.52, viewBase.pitch + sdy * 0.0032));
        parallax.yaw = parallax.pitch = 0;
        viewAim.yaw = viewBase.yaw;
        viewAim.pitch = viewBase.pitch;
      } else {
        aim.x -= dx; aim.y -= dy;
        cam.x = aim.x; cam.y = aim.y;   // 拖动要跟手，不走缓动
      }
      last = { x: e.clientX, y: e.clientY };
    } else if (depthEnabled && !reduceMotion && !narrow()) {
      // 指针只有极轻的观察视差；真正转动仍要拖拽。
      parallax.yaw = ((e.clientX / Math.max(W, 1)) - 0.5) * 0.11;
      parallax.pitch = ((e.clientY / Math.max(H, 1)) - 0.5) * -0.075;
      viewAim.yaw = viewBase.yaw + parallax.yaw;
      viewAim.pitch = viewBase.pitch + parallax.pitch;
    }
    kick();
  });

  function endPointer(e) {
    delete pts[e.pointerId];
    if (Object.keys(pts).length < 2) pinch = null;
    if (dragging) {
      dragging = false;
      cv.classList.remove("dragging");
      if (!moved) select(pick(e.clientX, e.clientY));
    }
    kick();
  }
  cv.addEventListener("pointerup", endPointer);
  cv.addEventListener("pointercancel", endPointer);
  cv.addEventListener("pointerleave", function () {
    pointer.x = pointer.y = -1e4;
    parallax.yaw = parallax.pitch = 0;
    viewAim.yaw = viewBase.yaw;
    viewAim.pitch = viewBase.pitch;
    kick();
  });

  cv.addEventListener("wheel", function (e) {
    e.preventDefault();
    var before = toWorld(e.clientX, e.clientY);
    aim.z = clampZ(aim.z * Math.pow(0.9988, e.deltaY));
    cam.z = aim.z;
    var after = toWorld(e.clientX, e.clientY);
    // 以指针为锚点缩放：光标下的那颗星不许跑
    aim.x += before.x - after.x;
    aim.y += before.y - after.y;
    cam.x = aim.x; cam.y = aim.y;
    kick();
  }, { passive: false });

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function clampZ(z) { return Math.max(MIN_Z, Math.min(MAX_Z, z)); }

  /* ---------------- 选中与卡片 ---------------- */
  var card = document.getElementById("card");

  function select(n) {
    if (n !== selected) selT = 0;
    selected = n || null;
    related = [];
    if (!n) { card.hidden = true; document.body.classList.remove("carded"); kick(); return; }

    // 真实关系边：共享标签或 [[双链]]，一条都不编
    var tags = {}, i;
    n.tags.forEach(function (t) { tags[t] = 1; });
    n.links.forEach(function (t) { tags[t] = 1; });
    for (i = 0; i < nodes.length; i++) {
      var m = nodes[i];
      if (m === n) continue;
      var hit = 0;
      for (var j = 0; j < m.tags.length; j++) if (tags[m.tags[j]]) hit++;
      for (var k = 0; k < m.links.length; k++) if (tags[m.links[k]]) hit++;
      if (hit) { m._hit = hit; related.push(m); }
    }
    related.sort(function (a, b) { return b._hit - a._hit; });
    related = related.slice(0, 34);

    fill(n);
    card.hidden = false;
    // 卡片一推上来就把角落的星色图例收掉，手机上它会被压在卡片下面读不了
    document.body.classList.add("carded");
    ensureVisible(n);
    kick();
  }

  /* 不把选中的星拽到正中 —— 星系本来就在动，钉死一个焦点不现实。
     只在它被顶栏或卡片挡住时，把镜头轻推到刚好看得见为止。 */
  function ensureVisible(n) {
    var w = worldOf(n), p = toScreen(w.x, w.y, w.z);
    var small = narrow();
    var padT = small ? 150 : 120;
    var padR = small ? 24 : 400;              // 桌面右边是卡片
    var padB = small ? H * 0.62 : 120;        // 手机底下是抽屉
    var padL = 24;
    var dx = 0, dy = 0;
    if (p.x < padL) dx = p.x - padL;
    else if (p.x > W - padR) dx = p.x - (W - padR);
    if (p.y < padT) dy = p.y - padT;
    else if (p.y > H - padB) dy = p.y - (H - padB);
    if (dx || dy) { aim.x += dx / cam.z; aim.y += dy / cam.z; }
  }

  var KIND = { permanent: "PERMANENT", dynamic: "DYNAMIC", plans: "PLAN", letters: "LETTER" };

  function fill(n) {
    document.getElementById("c-kind").textContent =
      (KIND[n.kind] || n.kind) + " · " + n.domain;
    document.getElementById("c-anchor").hidden = !n.anchor;
    document.getElementById("c-title").textContent = n.title;
    document.getElementById("c-summary").textContent = n.summary || "—";
    // 9-08 分流：为什么留 / 我的感受 各自一栏，空的就不占地方
    var whyBox = document.getElementById("c-why");
    whyBox.hidden = !(n.why && n.why.trim());
    document.getElementById("c-whytext").textContent = n.why || "";
    var feelBox = document.getElementById("c-feel");
    var feelList = document.getElementById("c-feellist");
    feelList.textContent = "";
    var feels = (n.feel || []).filter(function (f) { return f && f.trim(); });
    feelBox.hidden = !feels.length;
    feels.forEach(function (f) {
      var pEl = document.createElement("p");
      pEl.textContent = f;
      feelList.appendChild(pEl);
    });
    origReset(n);
    document.getElementById("c-domain").textContent = n.domain;
    document.getElementById("c-imp").textContent = n.importance.toFixed(0) + " / 10";
    document.getElementById("c-count").textContent = String(n.count);
    document.getElementById("c-clarity").textContent =
      Math.round(n.clarity * 100) + "%";
    var mc = document.getElementById("c-moon");
    var mg = mc.getContext("2d");
    mg.setTransform(2, 0, 0, 2, 0, 0);
    mg.clearRect(0, 0, 34, 34);
    moon(mg, 8.5, 8.5, 7, n.clarity,
      n.fading ? mute(0.95) : ink(0.95));

    var ul = document.getElementById("c-tags");
    ul.textContent = "";
    // 9-09：天气/轴已经在上面的心情栏里画成条了，标签胶囊里不再重复一遍
    n.tags.filter(function (t) { return !/^\s*(天气|轴)[:：]/.test(t); })
      .slice(0, 10).forEach(function (t) {
        var li = document.createElement("li");
        li.textContent = t;
        ul.appendChild(li);
      });

    fillMood(n);

    var parts = [];
    if (n.created) parts.push("CREATED " + n.created.slice(0, 10));
    if (n.active) parts.push("RECALLED " + n.active.slice(0, 10) + " (" + fmtAge(n.ageDays) + ")");
    if (related.length) parts.push(related.length + " SHARED TAGS");
    document.getElementById("c-time").textContent = parts.join(" · ");
  }

  /* 心情栏：一行「心情 ❄️ 落雪」＋ 最多三根轴的横条。
     条从中点起步（正右负左），长度按幅度（满格 12），颜色用轴色。
     没留心情的桶就一句「当时没留心情」——不留白，也不假装有。 */
  function fillMood(n) {
    var m = moodOf(n);
    var wxEl = document.getElementById("m-weather");
    var axBox = document.getElementById("m-axes");
    axBox.textContent = "";
    if (!m.has) {
      wxEl.className = "none";
      wxEl.textContent = "当时没留心情";
      return;
    }
    wxEl.className = "";
    if (m.weather && WEATHER_META[m.weather]) {
      var wc = MOOD_COLORS[theme][m.weather] || PAL.moodNeutral;
      wxEl.textContent = WEATHER_META[m.weather].ico + " " + WEATHER_META[m.weather].name;
      wxEl.style.color = rgbaOf(wc, 1);
    } else {
      wxEl.textContent = "—";
      wxEl.style.color = "";
    }
    (m.axes || []).slice(0, 3).forEach(function (a) {
      var c = axisRGB(a.name);
      var pct = Math.min(1, Math.abs(a.delta) / 12) * 50;   // 半幅 50%，满格 12
      var row = document.createElement("div");
      row.className = "mood-row";
      var nameEl = document.createElement("span");
      nameEl.className = "mood-name";
      nameEl.textContent = a.name;
      var track = document.createElement("i");
      track.className = "mood-track";
      var fillEl = document.createElement("b");
      fillEl.className = "mood-fill";
      fillEl.style.background = rgbaOf(c, 0.92);
      fillEl.style.width = pct + "%";
      if (a.delta < 0) { fillEl.style.right = "50%"; } else { fillEl.style.left = "50%"; }
      track.appendChild(fillEl);
      var num = document.createElement("span");
      num.className = "mood-num";
      num.textContent = (a.delta > 0 ? "+" : "") + (Math.round(a.delta * 10) / 10);
      num.style.color = rgbaOf(c, 0.95);
      row.appendChild(nameEl); row.appendChild(track); row.appendChild(num);
      axBox.appendChild(row);
    });
  }

  /* 角落图例：只列这份数据里真的出现过的心情，没出现的不占地方；
     实色小圆点，一行小字（安可 9-09：不要渐变）。 */
  function buildMoodLegend() {
    var box = document.getElementById("moodkey");
    if (!box) return;
    box.textContent = "";
    var wx = {}, ax = {}, plain = 0;
    nodes.forEach(function (n) {
      var m = moodOf(n);
      if (m.weather) wx[m.weather] = 1;
      else if (m.axes && m.axes.length) ax[m.axes[0].name] = 1;
      else plain++;
    });
    var items = [];
    ["clear", "rainbow", "rain", "snow", "hail", "storm"].forEach(function (k) {
      if (wx[k]) items.push([MOOD_COLORS[theme][k], WEATHER_META[k].name]);
    });
    AXIS_SET.forEach(function (k) {
      if (ax[k]) items.push([MOOD_COLORS[theme][k], k]);
    });
    if (plain) items.push([PAL.moodNeutral, "没留心情"]);
    if (items.length < 2) { box.hidden = true; return; }
    box.hidden = false;
    items.forEach(function (it) {
      var i = document.createElement("i");
      var b = document.createElement("b");
      b.style.background = rgbaOf(it[0], 1);
      i.appendChild(b);
      i.appendChild(document.createTextNode(it[1]));
      box.appendChild(i);
    });
  }

  function fmtAge(d) {
    if (d < 1) return "TODAY";
    if (d < 30) return Math.round(d) + "d";
    return Math.round(d / 30) + "mo";
  }

  document.getElementById("cardclose").addEventListener("click", function () { select(null); });

  /* ---------------- 搜索 ---------------- */
  var qi = document.getElementById("q");
  var qclear = document.getElementById("qclear");
  var qhint = document.getElementById("qhint");

  /* 这一栏是我自己加的：74 段正在变淡，点一下就只留它们。
     天仪不该只是好看 —— 它得能指出哪些记忆快没了，好让我去把它们唤起来。 */
  var warnBox = document.querySelector(".stats .warn");
  var fadingOnly = false;

  function setFading(on) {
    fadingOnly = on;
    warnBox.classList.toggle("on", on);
    rings.forEach(function (r) { r.hasMatch = false; });
    if (!on) { matched = null; qhint.hidden = true; kick(); return; }
    qi.value = ""; query = ""; qclear.hidden = true;
    matched = {};
    var k = 0;
    nodes.forEach(function (n) {
      if (n.fading) { matched[n.id] = 1; n.ring.hasMatch = true; k++; }
    });
    qhint.hidden = false;
    qhint.textContent = k + " FADING \u00b7 BREATH TO RESTORE";
    kick();
  }
  warnBox.addEventListener("click", function () { setFading(!fadingOnly); });
  warnBox.setAttribute("title", "Show only fading memories");

  qi.addEventListener("input", function () {
    if (fadingOnly) { fadingOnly = false; warnBox.classList.remove("on"); }
    query = qi.value.trim().toLowerCase();
    qclear.hidden = !query;
    if (!query) {
      matched = null; qhint.hidden = true; kick(); return;
    }
    matched = {};
    var hits = 0;
    rings.forEach(function (r) { r.hasMatch = false; });
    nodes.forEach(function (n) {
      var hay = (n.title + " " + n.domain + " " + n.tags.join(" ") + " " + n.summary).toLowerCase();
      if (hay.indexOf(query) >= 0) { matched[n.id] = 1; n.ring.hasMatch = true; hits++; }
    });
    qhint.hidden = false;
qhint.textContent = hits ? hits + " MATCHES" : "NO MATCH";
    if (!hits) matched = null;
    kick();
  });

  qclear.addEventListener("click", function () {
    qi.value = ""; query = ""; matched = null;
    qclear.hidden = true; qhint.hidden = true;
    qi.focus(); kick();
  });

  /* ---------------- 领域索引 ---------------- */
  var legendOpen = false;
  var TOP = 12;
  function narrow() { return window.matchMedia("(max-width:760px)").matches; }

  function buildLegend() {
    var list = document.getElementById("legend-list");
    var more = document.getElementById("legend-more");
    // 索引按桶数排（找东西用），轨道顺序按重要度排（看关系用），两套排序各司其职
    var order = rings.slice().sort(function (a, b) { return b.count - a.count; });

    function render() {
      list.textContent = "";
      var show = order;   // 列表本来就是收起的，展开时直接给全部
      show.forEach(function (ring, i) {
        var li = document.createElement("li");
        var b = document.createElement("button");
        b.type = "button";
        b.innerHTML = '<span class="no">' + String(i + 1).padStart(2, "0") + '</span>' +
          '<span class="nm"></span><span class="ct">' + ring.count + '</span>';
        b.querySelector(".nm").textContent = ring.name;
        b.addEventListener("click", function () {
          var on = b.classList.contains("on");
          [].forEach.call(list.querySelectorAll("button"), function (c) {
            c.classList.remove("on");
          });
          if (on) { aim.x = 0; aim.y = 0; aim.z = fitZoom(); select(null); kick(); return; }
          b.classList.add("on");
          aim.x = 0; aim.y = 0;
          aim.z = clampZ(Math.min(W, H) / (ring.r * 2.4));
          var pick = ring.list.slice().sort(function (x, y) {
            return y.importance - x.importance;
          })[0];
          if (pick) select(pick);
          legendOpen = false;            // 选完就收起来，别挡着星星
          document.getElementById("legend").classList.remove("open");
          more.textContent = "ALL " + order.length;
          kick();
        });
        li.appendChild(b);
        list.appendChild(li);
      });
      // 手机上索引是收起的抽屉，标题栏本身就是开关
      more.textContent = legendOpen ? "LESS" : "ALL " + order.length;
    }

    more.addEventListener("click", function () {
      legendOpen = !legendOpen;
      document.getElementById("legend").classList.toggle("open", legendOpen);
      render();
    });
    render();
  }

  /* 底部那条声波：横轴是日子，波峰是那天写下了几段记忆。
     这不是装饰曲线 —— 它是当前记忆库实际生长过程的时间波形。 */
  function buildTimeline() {
    var el = document.getElementById("tl-wave");
    var g = el.getContext("2d");
    var days = {}, min = null, max = null;
    nodes.forEach(function (n) {
      if (!n.created) return;
      var d = n.created.slice(0, 10);
      days[d] = (days[d] || 0) + 1;
      if (!min || d < min) min = d;
      if (!max || d > max) max = d;
    });
    if (!min) return;

    var t0 = new Date(min + "T00:00:00").getTime();
    var t1 = Math.max(new Date(max + "T00:00:00").getTime(), Date.now());
    var span = Math.max(1, Math.round((t1 - t0) / 86400000));
    var series = [], peak = 1, peakDay = min;
    for (var i = 0; i <= span; i++) {
      var key = new Date(t0 + i * 86400000).toISOString().slice(0, 10);
      var v = days[key] || 0;
      series.push(v);
      if (v > peak) { peak = v; peakDay = key; }
    }

    var w = el.width / 2, h = el.height / 2;
    g.setTransform(2, 0, 0, 2, 0, 0);
    g.clearRect(0, 0, w, h);

    var base = h - 9;
    var pts = series.map(function (v, i) {
      return { x: (i / span) * (w - 2) + 1, y: base - (v / peak) * (base - 4) };
    });

    // 面积 + 曲线：用中点做平滑，锐角的折线读起来像故障不像生长
    function curve() {
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      for (var i = 1; i < pts.length; i++) {
        var m = (pts[i - 1].x + pts[i].x) / 2;
        g.bezierCurveTo(m, pts[i - 1].y, m, pts[i].y, pts[i].x, pts[i].y);
      }
    }
    curve();
    g.lineTo(pts[pts.length - 1].x, base); g.lineTo(pts[0].x, base); g.closePath();
    var fill = g.createLinearGradient(0, 0, 0, base);
    fill.addColorStop(0, ink(0.2));
    fill.addColorStop(1, ink(0.02));
    g.fillStyle = fill; g.fill();

    curve();
    g.strokeStyle = ink(0.7); g.lineWidth = 1; g.stroke();

    g.strokeStyle = hair(0.16); g.lineWidth = 0.6;
    g.beginPath(); g.moveTo(0, base + .5); g.lineTo(w, base + .5); g.stroke();

    // 峰值那天标一笔：那天她一口气写下了最多
    var pi = series.indexOf(peak);
    var px = (pi / span) * (w - 2) + 1;
    g.strokeStyle = hair(0.4);
    g.setLineDash([1, 3]);
    g.beginPath(); g.moveTo(px, base); g.lineTo(px, pts[pi].y - 3); g.stroke();
    g.setLineDash([]);
    g.font = "400 8px system-ui, sans-serif";
    g.fillStyle = ink(0.75);
    g.textAlign = px > w * 0.8 ? "right" : "left";
g.fillText(peakDay.slice(5) + "  " + peak, px + (px > w * 0.8 ? -3 : 3), pts[pi].y - 5);

    document.getElementById("tl-from").textContent = min.slice(5).replace("-", "/");
    document.getElementById("tl-to").textContent = "TODAY \u00b7 " + nodes.length;
  }

  // 底部那排月相：从满月走到残月，就是一段记忆被忘掉的全过程
  function buildPhases() {
    var pc = document.getElementById("phase-strip");
    if (!pc) return;                 // 图例已退役，月相只留在卡片里
    var g = pc.getContext("2d");
    g.setTransform(2, 0, 0, 2, 0, 0);
    var steps = [1, 0.78, 0.55, 0.34, 0.18, 0.06];
    steps.forEach(function (k, i) {
      var x = 10 + i * 32;
      moon(g, x, 9, 7, k, k < 0.3 ? mute(0.92) : ink(0.88));
    });
  }

  function fitZoom() {
    // 全库的遗忘状态分五档，等下嵌进中心那座浑天仪里
    phaseBins = [0, 0, 0, 0, 0];
    nodes.forEach(function (n) {
      phaseBins[Math.min(4, Math.floor(Math.max(0, Math.min(0.999, n.clarity)) * 5))]++;
    });

    var outer = rings.length ? (rings[rings.length - 1].rout || rings[rings.length - 1].r) : 800;
    var fit = Math.min(W, H) / (outer * 1.78);
    if (depthEnabled && narrow()) fit = Math.max(fit, 0.42);
    return clampZ(fit);
  }

  /* ---------------- 控件 ---------------- */
  document.getElementById("zoomin").addEventListener("click", function () {
    aim.z = clampZ(aim.z * 1.45); kick();
  });
  document.getElementById("zoomout").addEventListener("click", function () {
    aim.z = clampZ(aim.z / 1.45); kick();
  });
  document.getElementById("reset").addEventListener("click", function () {
    aim.x = 0; aim.y = 0; aim.z = fitZoom();
    viewBase.yaw = depthEnabled ? 0.18 : 0;
    viewBase.pitch = depthEnabled ? -0.08 : 0;
    parallax.yaw = parallax.pitch = 0;
    viewAim.yaw = viewBase.yaw;
    viewAim.pitch = viewBase.pitch;
    select(null);
    [].forEach.call(document.getElementById("legend").children, function (c) {
      c.classList.remove("on");
    });
    kick();
  });
  var spinBtn = document.getElementById("spin");
  spinBtn.addEventListener("click", function () {
    spin = !spin;
    spinBtn.setAttribute("aria-pressed", String(spin));
    spinBtn.querySelector("b").textContent = spin ? "ON" : "OFF";
    kick();
  });

  var depthBtn = document.getElementById("depth");
  function syncDepthButton() {
    depthBtn.classList.toggle("on", depthEnabled);
    depthBtn.setAttribute("aria-pressed", String(depthEnabled));
    depthBtn.disabled = reduceMotion;
    depthBtn.title = reduceMotion ? "Depth is off while reduced motion is enabled"
      : depthEnabled ? "Return to flat view" : "Turn on spatial depth";
    document.body.classList.toggle("depth-on", depthEnabled);
  }
  function setDepth(on) {
    depthEnabled = !!on && !reduceMotion;
    if (depthEnabled && narrow() && aim.z < 0.42) aim.z = cam.z = 0.42;
    viewBase.yaw = depthEnabled ? 0.18 : 0;
    viewBase.pitch = depthEnabled ? -0.08 : 0;
    parallax.yaw = parallax.pitch = 0;
    viewAim.yaw = viewBase.yaw;
    viewAim.pitch = viewBase.pitch;
    if (!depthEnabled) { view.yaw = view.pitch = 0; }
    lastZ = -1;
    syncDepthButton();
    if (history.replaceState) {
      var url = new URL(location.href);
      if (depthEnabled) url.searchParams.set("depth", "1");
      else url.searchParams.delete("depth");
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    kick();
  }
  depthBtn.addEventListener("click", function () { setDepth(!depthEnabled); });
  syncDepthButton();

  /* 一座天仪，两种光。切换时要补画三处「一次性画好」的东西：
     中心绕圈那句话（预渲染贴图）、底部声波、卡片里那颗月亮 ——
     它们不在每帧的循环里，不重画就会带着旧墨色留在新主题上。 */
  var themeBtn = document.getElementById("theme");
  var groundBtn = document.getElementById("ground");

  function syncThemeButton() {
    var day = theme === "day";
    themeBtn.querySelector(".ico").textContent = day ? "☀" : "☾";
    themeBtn.querySelector(".lab").textContent = day ? "DAY" : "NIGHT";
    themeBtn.setAttribute("aria-pressed", String(day));
    themeBtn.title = day ? "Switch to night" : "Switch to day";
    groundBtn.hidden = !day;                    // 底纹只有白天才有得挑
    groundBtn.querySelector(".ico").textContent = GROUND_ICON[ground];
    groundBtn.querySelector(".lab").textContent = ground.toUpperCase();
    groundBtn.title = GROUND_TIP[ground];
    document.body.classList.toggle("day", day);
  }

  function repaintStatic() {
    coreCv = null;
    buildTimeline();
    buildPhases();
    buildMoodLegend();       // 9-09：图例的圆点是实色，换主题要重画一遍
    if (selected) fill(selected);
    lastZ = -1;
  }

  window.addEventListener("storage", function (ev) {
    if (ev.key !== "tt-night") return;
    try { if (localStorage.getItem(THEME_KEY)) return; } catch (e) {}
    var g = globalNight(); if (g === null) return;
    var want = g ? "night" : "day";
    if (want !== theme) setTheme(want, true);
  });
  function setTheme(next, fromGlobal) {
    theme = next;
    PAL = THEMES[theme];
    document.documentElement.dataset.theme = theme;
    if (!fromGlobal) { try { localStorage.setItem(THEME_KEY, theme); } catch (e) {} }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", PAL.bg[2]);
    repaintStatic();
    syncThemeButton();
    kick();
    if (!spin) draw();
  }

  themeBtn.addEventListener("click", function () {
    setTheme(theme === "day" ? "night" : "day");
  });
  groundBtn.addEventListener("click", function () {
    ground = GROUNDS[(GROUNDS.indexOf(ground) + 1) % GROUNDS.length];
    groundCv = null;
    try { localStorage.setItem(GROUND_KEY, ground); } catch (e) {}
    syncThemeButton();
    kick();
    if (!spin) draw();
  });
  syncThemeButton();

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { select(null); }
    if (e.target === qi) return;
    if (e.key === "+" || e.key === "=") { aim.z = clampZ(aim.z * 1.35); kick(); }
    if (e.key === "-") { aim.z = clampZ(aim.z / 1.35); kick(); }
  });

  window.addEventListener("resize", function () { resize(); kick(); });

  /* ---------------- 自动巡演 ----------------
     这页要有人操作才好看，录屏就很麻烦。加 ?tour=1 打开，它自己走一遍：
     入场 → 全景 → 推近 → 挑几段有分量的记忆点开 → 只看正在变淡的 → 拉回全景。
     期间隐藏所有 HUD 控件（?tour=1&bare=1 连统计一起藏），录完即用。 */
  function startTour() {
    var bare = /[?&]bare=1/.test(location.search);
    document.body.classList.add("touring");
    if (bare) document.body.classList.add("bare");

    function pickBy(fn) {
      var hit = nodes.filter(fn);
      return hit.length ? hit[0] : null;
    }
    var star1 = pickBy(function (n) { return n.title.indexOf("专属称呼") >= 0; })
             || pickBy(function (n) { return n.anchor; });
    var star2 = pickBy(function (n) { return n.title.indexOf("小蛋糕") >= 0; })
             || pickBy(function (n) { return n.importance >= 9; });
    var star3 = pickBy(function (n) { return n.title.indexOf("安全词") >= 0; })
             || pickBy(function (n) { return n.count >= 8; });

    var steps = [
      [3400, function () { aim.z = clampZ(fitZoom() * 1.55); }],
      [4200, function () { if (star1) { focusStar(star1); } }],
      [5000, function () { if (star2) { focusStar(star2); } }],
      [5000, function () { if (star3) { focusStar(star3); } }],
      [1200, function () { select(null); }],
      [4200, function () { setFading(true); }],
      [1400, function () { setFading(false); }],
      [1000, function () { aim.x = 0; aim.y = 0; aim.z = fitZoom(); }],
      [5000, function () { /* 停在全景，让它自己转一会儿 */ }]
    ];
    var t = 0;
    steps.forEach(function (st) {
      t += st[0];
      setTimeout(st[1], t);
    });
    setTimeout(function () { document.body.classList.add("tour-done"); }, t);
  }

  // 巡演时把镜头带到那颗星上：这里可以居中，因为是在给人看。
  // 注意要减掉 drift —— 屏幕位置是 (world - cam - drift)*z，漏掉它星就偏出画面。
  function focusStar(n) {
    select(n);                         // 先选，免得 select 里的避让又把镜头推一次
    aim.z = clampZ(1.15);
    var w = worldOf(n);
    aim.x = w.x - drift.x;
    aim.y = w.y - drift.y - 40 / aim.z;
    kick();
  }

  /* 两份数据共用同一座天仪；切换住户只换查询参数和 JSON，不复制页面。 */
  var brainButtons = document.querySelectorAll("[data-brain]");
  [].forEach.call(brainButtons, function (button) {
    var active = button.getAttribute("data-brain") === brain;
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-label", active ?
      "Current resident: " + button.textContent : "Switch to " + button.textContent);
    button.addEventListener("click", function () {
      var next = button.getAttribute("data-brain");
      if (next === brain) return;
      var url = new URL(location.href);
      url.searchParams.set("brain", next);
      location.assign(url.pathname + url.search + url.hash);
    });
  });

  /* ---------------- 列表视图（安可 8-17 点单：星座切换列表化） ----------------
     同一批 nodes 换一种读法：按时间排的索引，点一行 = 选中那颗星（复用 select 的卡片）。
     搜索框两用：列表开着时同一个 #q 直接过滤行。纯加法，星盘一根线没动。 */
  var lv = document.getElementById("listview");
  var lvList = document.getElementById("lv-list");
  var lvCount = document.getElementById("lv-count");
  var lvSort = document.getElementById("lv-sort");
  var listBtn = document.getElementById("listbtn");
  var lvNewFirst = true;

  function lvEsc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return "&#" + c.charCodeAt(0) + ";";
    });
  }

  function lvMatches(n, q) {
    if (!q) return true;
    if ((n.title || "").toLowerCase().indexOf(q) >= 0) return true;
    if ((n.summary || "").toLowerCase().indexOf(q) >= 0) return true;
    if ((n.domain || "").toLowerCase().indexOf(q) >= 0) return true;
    for (var i = 0; i < n.tags.length; i++)
      if (n.tags[i].toLowerCase().indexOf(q) >= 0) return true;
    return false;
  }

  /* 记忆抽屉（8-26 安可：「天仪里本来就有全部桶，就差把其他东西搬进来」）：
     box 字段由 orrery-export.py 在截断 tags 之前算好（__diary__ 曾被 [:12] 剪没过），
     这里只管按签过滤。信也是星（kind=letter），点行选星走同一条 select 路。 */
  var lvBoxes = document.getElementById("lv-boxes");
  var LV_BOX_DEFS = [["all", "全部"], ["murmur", "碎碎念"], ["diary", "日记"],
                     ["memory", "记忆"], ["core", "核心"], ["letter", "信箱"]];
  var lvBox = "all";

  function lvBoxOf(n) { return n.box || (n.kind === "permanent" ? "core" : "memory"); }

  function lvRenderBoxes() {
    if (!lvBoxes) return;
    var counts = {};
    nodes.forEach(function (n) { var b = lvBoxOf(n); counts[b] = (counts[b] || 0) + 1; });
    lvBoxes.innerHTML = LV_BOX_DEFS.map(function (d) {
      var c = d[0] === "all" ? nodes.length : (counts[d[0]] || 0);
      return '<button type="button" data-box="' + d[0] + '" aria-pressed="' +
        String(d[0] === lvBox) + '">' + d[1] + '<b>' + c + "</b></button>";
    }).join("");
  }

  lvBoxes.addEventListener("click", function (e) {
    var b = e.target.closest("button[data-box]");
    if (!b) return;
    lvBox = b.dataset.box;
    lvRenderBoxes();
    lvRender();
  });

  function lvRender() {
    if (lv.hidden) return;
    var q = (qi.value || "").trim().toLowerCase();
    var rows = nodes.filter(function (n) {
      if (lvBox !== "all" && lvBoxOf(n) !== lvBox) return false;
      return lvMatches(n, q);
    });
    rows.sort(function (a, b) {
      return lvNewFirst
        ? String(b.created || "").localeCompare(String(a.created || ""))
        : String(a.created || "").localeCompare(String(b.created || ""));
    });
    lvCount.textContent = rows.length + " / " + nodes.length;
    lvList.innerHTML = rows.map(function (n) {
      return '<li><button type="button" data-id="' + lvEsc(n.id) + '">' +
        '<span class="lv-date">' + (String(n.created || "").slice(0, 10) || "—") + "</span>" +
        '<span class="lv-main"><b>' + lvEsc(n.title) + "</b>" +
        (n.orig && n.orig.length ? '<i class="lv-orig" title="原文在档"><svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/></svg></i>' : "") +
        (n.anchor ? '<i class="lv-anchor">⚓</i>' : "") +
        (n.fading ? '<i class="lv-fade" title="fading">◌</i>' : "") +
        "</span>" +
        '<span class="lv-dom">' + lvEsc(n.domain) + "</span>" +
        '<span class="lv-cla">' + Math.round((n.clarity || 0) * 100) + "%</span>" +
        "</button></li>";
    }).join("") || '<li class="lv-empty">NO MATCH</li>';
  }

  function lvToggle(on) {
    if (on === undefined) on = lv.hidden;
    lv.hidden = !on;
    listBtn.setAttribute("aria-pressed", on ? "true" : "false");
    if (on) { select(null); lvRenderBoxes(); lvRender(); }
  }

  listBtn.addEventListener("click", function () { lvToggle(); });
  document.getElementById("lv-close").addEventListener("click", function () { lvToggle(false); });
  lvSort.addEventListener("click", function () {
    lvNewFirst = !lvNewFirst;
    lvSort.textContent = lvNewFirst ? "NEW→OLD" : "OLD→NEW";
    lvRender();
  });
  lvList.addEventListener("click", function (e) {
    var t = e.target, b = null;
    while (t && t !== lvList) { if (t.tagName === "BUTTON" && t.hasAttribute("data-id")) { b = t; break; } t = t.parentNode; }
    if (!b) return;
    var id = b.getAttribute("data-id");
    for (var i = 0; i < nodes.length; i++) {
      if (String(nodes[i].id) === id) { lvToggle(false); select(nodes[i]); break; }
    }
  });
  qi.addEventListener("input", function () { if (!lv.hidden) lvRender(); });
  window.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !lv.hidden) lvToggle(false);
  });

  /* ---------------- 原文档案（8-17 原文永存计划）----------------
     摘要只是索引。带 orig 的星，卡片上多一颗「展开原文」——
     从 data/originals/<key>.md 取回侧车档案，原话原样铺开。 */
  var origBox = document.getElementById("c-orig");
  var origBtn = document.getElementById("c-origbtn");
  var origBody = document.getElementById("c-origbody");
  var origCache = {}, origFor = null;

  function origReset(n) {
    origFor = n;
    origBody.hidden = true;
    origBody.innerHTML = "";
    origBtn.setAttribute("aria-expanded", "false");
    document.getElementById("c-origlab").textContent = "展开原文";
    origBox.hidden = !(n && n.orig && n.orig.length);
  }

  function origRender(md) {
    // 侧车格式：`## 时间 · 来源` 一行 + 原文若干行。轻解析，先转义再拼。
    return md.split("\n").map(function (line) {
      if (line.slice(0, 3) === "## ")
        return '<h4>' + lvEsc(line.slice(3)) + "</h4>";
      if (!line.trim()) return "";
      return "<p>" + lvEsc(line) + "</p>";
    }).join("");
  }

  origBtn.addEventListener("click", function () {
    var n = origFor;
    if (!n) return;
    if (!origBody.hidden) {                 // 已展开 → 收起
      origBody.hidden = true;
      origBtn.setAttribute("aria-expanded", "false");
      document.getElementById("c-origlab").textContent = "展开原文";
      return;
    }
    origBtn.setAttribute("aria-expanded", "true");
    document.getElementById("c-origlab").textContent = "收起原文";
    var key = n.orig.join("+");
    if (origCache[key]) {
      origBody.innerHTML = origCache[key];
      origBody.hidden = false;
      return;
    }
    origBody.innerHTML = '<p class="orig-loading">RETRIEVING…</p>';
    origBody.hidden = false;
    Promise.all(n.orig.map(function (k) {
      return fetch("./data/originals/" + encodeURIComponent(k) + ".md?t=" + Date.now())
        .then(function (r) { return r.ok ? r.text() : ""; })
        .catch(function () { return ""; });
    })).then(function (texts) {
      if (origFor !== n) return;            // 期间换了星，别把旧档贴错人
      var joined = texts.filter(Boolean).join("\n");
      var html = joined ? origRender(joined)
                        : '<p class="orig-loading">ARCHIVE NOT FOUND</p>';
      origCache[key] = html;
      origBody.innerHTML = html;
    });
  });

  /* ---------------- 启动 ---------------- */
  fetch("./data/" + dataFile + "?t=" + Date.now())
    .then(function (r) {
      if (!r.ok) throw new Error("data " + r.status);
      return r.json();
    })
    .then(function (json) {
      data = json;
      resize();
      build();
      buildLegend();
      buildPhases();
      buildTimeline();
      buildMoodLegend();     // 9-09 星色图例

      var t = data.totals;
      var residentName = brain === "feylor" ? "FEYLOR" : "RIME";
      document.title = residentName.charAt(0) + residentName.slice(1).toLowerCase() +
        " · Memory Orrery";
      document.getElementById("s-stamp").textContent =
        residentName + " · " + (data.generatedAt || "").replace("T", " ").slice(0, 16) + " SNAPSHOT";
      document.getElementById("s-nodes").textContent = t.nodes;
      document.getElementById("s-domains").textContent = rings.length;   // 轨道数＝团数，不再是大类数
      document.getElementById("s-anchors").textContent = t.anchors;
      document.getElementById("s-fading").textContent = t.fading;
      if (reduceMotion) {
        intro = INTRO;
        spin = false;
        spinBtn.setAttribute("aria-pressed", "false");
        spinBtn.querySelector("b").textContent = "OFF";
      }

      if (/[?&]tour=1/.test(location.search)) startTour();
      document.dispatchEvent(new Event("orrery:ready"));   // 9-06 书脊抽屉等这一声
      loading.classList.add("gone");
      setTimeout(function () { loading.hidden = true; }, 900);
      kick();
      if (!spin) draw();
    })
    .catch(function (err) {
      loading.textContent = "FAILED: " + err.message;
      console.error(err);
    });

  /* 9-06 书脊抽屉（spine.js）要借的几只手：拿全部星、选星、把镜头推过去。 */
  window.orrery = {
    nodes: function () { return nodes; },
    selected: function () { return selected; },   // edit.js：卡片上正打开的那颗
    fill: fill,                                    // edit.js：改完字重画卡片
    select: select,
    focusStar: focusStar,
    brain: brain
  };
})();
