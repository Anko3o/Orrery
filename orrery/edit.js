/* 卡片的 ⋯ · 编辑 / 遗忘 / 删除（9-07 粗版）
 * 走同源小路 /ob-api/{brain}/…（Caddy 反代到各自那颗 OB），登录也经这里，cookie 只认各自前缀。
 * 天仪读的是 12 分钟一导的快照，改完先在页面上就地更新，快照下一轮自然追上。 */
(function () {
  "use strict";
  var O = window.orrery; if (!O) return;
  var card = document.getElementById("card");
  var more = document.getElementById("cardmore"), menu = document.getElementById("c-menu");
  var login = document.getElementById("c-login"), pass = document.getElementById("c-pass"), note = document.getElementById("c-loginnote");
  var flash = document.getElementById("c-flash");
  var title = document.getElementById("c-title"), summary = document.getElementById("c-summary");
  if (!card || !more || !menu) return;
  var BASE = "/ob-api/" + (O.brain === "feylor" ? "feylor" : "rime");
  var pending = null;    // 登录成功后要重放的动作

  function api(path, opts) {
    opts = opts || {};
    return fetch(BASE + path, {
      method: opts.method || "GET",
      credentials: "same-origin",
      headers: opts.body ? { "Content-Type": "application/json" } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = {}; try { j = t ? JSON.parse(t) : {}; } catch (e) { j = { error: t.slice(0, 120) }; }
        if (r.status === 401) { var e = new Error("unauthorized"); e.auth = true; throw e; }
        if (!r.ok || j.ok === false) throw new Error(j.error || ("HTTP " + r.status));
        return j;
      });
    });
  }
  function say(msg, ms) {
    flash.textContent = msg; flash.hidden = !msg;
    clearTimeout(say.t); if (ms) say.t = setTimeout(function () { flash.hidden = true; }, ms);
  }
  function closeMenu() { menu.hidden = true; more.setAttribute("aria-expanded", "false"); disarm(); }
  function disarm() { var d = menu.querySelector('[data-act="delete"]'); d.classList.remove("armed"); d.innerHTML = "✕ 删除 <small>再点一次确认</small>"; }
  function needLogin(then) {
    pending = then; login.hidden = false; note.textContent = ""; setTimeout(function () { pass.focus(); }, 60);
  }
  function guard(fn) {
    return fn().catch(function (e) {
      if (e.auth) { needLogin(function () { guard(fn); }); return; }
      say("没成：" + e.message, 4000);
    });
  }

  more.addEventListener("click", function (e) {
    e.stopPropagation();
    var open = menu.hidden; menu.hidden = !open; more.setAttribute("aria-expanded", String(open));
    if (!open) disarm();
  });
  document.addEventListener("click", function (e) { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); });

  login.addEventListener("submit", function (e) {
    e.preventDefault();
    var pw = pass.value; if (!pw) return;
    note.textContent = "…";
    api("/auth/login", { method: "POST", body: { password: pw } }).then(function () {
      pass.value = ""; login.hidden = true; note.textContent = "";
      var p = pending; pending = null; if (p) p();
    }).catch(function (e) { note.textContent = e.auth ? "密码不对" : ("没成：" + e.message); });
  });

  /* ---- 编辑 ---- */
  var editBox = null;
  function startEdit(n) {
    if (editBox) return;
    editBox = document.createElement("div"); editBox.className = "c-edit";
    editBox.innerHTML =
      '<input type="text" value="" placeholder="标题">' +
      '<textarea placeholder="正文"></textarea>' +
      '<div class="row"><button type="button" class="cancel">取消</button><button type="button" class="save">保存</button></div>';
    editBox.querySelector("input").value = n.title || "";
    editBox.querySelector("textarea").value = n.summary || "";
    summary.parentNode.insertBefore(editBox, summary);
    card.classList.add("editing");
    editBox.querySelector(".cancel").addEventListener("click", stopEdit);
    editBox.querySelector(".save").addEventListener("click", function () {
      var t = editBox.querySelector("input").value.trim(), c = editBox.querySelector("textarea").value;
      if (!t) { say("标题不能空", 2500); return; }
      var body = {}; if (t !== n.title) body.title = t; if (c !== n.summary) body.content = c;
      if (!Object.keys(body).length) { stopEdit(); return; }
      guard(function () {
        return api("/api/bucket/" + encodeURIComponent(n.id) + "/edit", { method: "PATCH", body: body }).then(function () {
          if (body.title != null) n.title = t;
          if (body.content != null) n.summary = c;
          stopEdit(); O.fill(n); say("改好了 · 天仪快照 12 分钟内跟上", 3500);
        });
      });
    });
    setTimeout(function () { editBox.querySelector("input").focus(); }, 60);
  }
  function stopEdit() { if (editBox) { editBox.remove(); editBox = null; } card.classList.remove("editing"); }

  /* ---- 遗忘（toggle dont_surface）---- */
  function forget(n) {
    guard(function () {
      return api("/api/bucket/" + encodeURIComponent(n.id) + "/forget", { method: "POST", body: {} }).then(function (j) {
        n.dont_surface = !!j.dont_surface;
        card.classList.toggle("forgotten", n.dont_surface);
        say(n.dont_surface ? "遗忘了 · 它会变淡，不会消失" : "想起来了 · 取消遗忘", 3500);
      });
    });
  }

  /* ---- 删除（OB 是「申请删除→归档」，不是焚毁）---- */
  function del(n) {
    guard(function () {
      return api("/api/bucket/" + encodeURIComponent(n.id) + "?confirm=true", { method: "DELETE", body: { reason: "安可在天仪上删的" } }).then(function () {
        say("已申请删除 · 进 OB 归档区，机务舱可撤回", 4000);
        card.classList.add("forgotten");
      });
    });
  }

  menu.addEventListener("click", function (e) {
    e.stopPropagation();   // 菜单里的点击不交给外面的「点空白收起」——删除第一击会换掉按钮内文，e.target 会从 DOM 里消失
    var b = e.target.closest("button[data-act]"); if (!b) return;
    var n = O.selected(); if (!n) return;
    var act = b.dataset.act;
    if (act === "delete" && !b.classList.contains("armed")) {
      b.classList.add("armed"); b.innerHTML = "✕ 真的删？ <small>再点一次</small>"; return;
    }
    closeMenu();
    if (act === "edit") startEdit(n);
    else if (act === "forget") forget(n);
    else if (act === "delete") del(n);
  });

  /* 换一颗星就收拾干净 */
  var lastId = null;
  new MutationObserver(function () {
    var n = O.selected(); var id = n ? n.id : null;
    if (id !== lastId) { lastId = id; stopEdit(); closeMenu(); login.hidden = true; flash.hidden = true; card.classList.toggle("forgotten", !!(n && n.dont_surface)); }
  }).observe(card, { attributes: true, childList: true, subtree: true });
})();
