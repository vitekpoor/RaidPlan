// Eternal Shadows – přihlášení admina v hlavičce (vpravo nahoře) na všech stránkách.
// Token (POST /api/admin/login {pw} → "<exp>.<hmac>", 30 dní) je v localStorage `esAdminToken` a posílá se jako
// "Authorization: Bearer …" na admin endpointy (PUT /api/roster, PUT /api/lineups, DELETE /api/absence, …).
// Stránky čtou window.esAuth.token() a reagují na esAuth.onChange(fn).
(function () {
  var API_BASE = /(^|\.)workers\.dev$/.test(location.hostname) ? "" : "https://eternal-shadows.vitek-poor.workers.dev";
  var KEY = "esAdminToken";
  var listeners = [], box = null;
  function token() { try { return localStorage.getItem(KEY) || null; } catch (e) { return null; } }
  function setToken(t) { try { if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY); } catch (e) {} emit(); }
  function emit() { var t = token(); listeners.forEach(function (fn) { try { fn(t); } catch (e) {} }); renderBtn(); }
  function login(pw) {
    return fetch(API_BASE + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pw: pw }) })
      .then(function (r) { return r.json(); }).then(function (d) { if (!d.ok) throw new Error(d.error || "přihlášení selhalo"); setToken(d.token); return d; });
  }
  function logout() { setToken(null); }
  function check() {
    var t = token(); if (!t) return Promise.resolve(false);
    return fetch(API_BASE + "/api/admin/check", { headers: { "Authorization": "Bearer " + t } })
      .then(function (r) { if (r.status === 401) { setToken(null); return false; } return true; }).catch(function () { return true; });
  }
  function headers(extra) { var h = extra || {}; var t = token(); if (t) h["Authorization"] = "Bearer " + t; return h; }

  function renderBtn() {
    if (!box) return;
    var t = token();
    box.innerHTML = t
      ? '<button type="button" class="es-auth-btn on" title="přihlášený admin"><span class="dot"></span>Admin</button><div class="es-auth-pop" hidden><p>Přihlášený raid leader – můžeš upravovat roster, sestavy, docházku a absence.</p><button type="button" class="es-auth-out">Odhlásit</button></div>'
      : '<button type="button" class="es-auth-btn">Přihlásit</button><div class="es-auth-pop" hidden><label>Heslo admina<input type="password" autocomplete="current-password" placeholder="heslo"></label><button type="button" class="es-auth-go">Přihlásit</button><span class="es-auth-err"></span></div>';
    var btn = box.querySelector(".es-auth-btn"), pop = box.querySelector(".es-auth-pop");
    btn.addEventListener("click", function (ev) { ev.stopPropagation(); pop.hidden = !pop.hidden; if (!pop.hidden) { var i = pop.querySelector("input"); if (i) i.focus(); } });
    pop.addEventListener("click", function (ev) { ev.stopPropagation(); });
    var out = box.querySelector(".es-auth-out"); if (out) out.addEventListener("click", function () { logout(); });
    var go = box.querySelector(".es-auth-go"), inp = pop.querySelector("input"), err = box.querySelector(".es-auth-err");
    function doLogin() {
      if (!inp.value) { err.textContent = "Zadej heslo."; return; }
      go.disabled = true; err.textContent = "";
      login(inp.value).catch(function (e) { err.textContent = e.message; }).then(function () { go.disabled = false; });
    }
    if (go) { go.addEventListener("click", doLogin); inp.addEventListener("keydown", function (ev) { if (ev.key === "Enter") doLogin(); }); }
  }
  function mount() {
    var nav = document.querySelector(".main-nav"); if (!nav) return;
    box = document.createElement("div"); box.className = "es-auth"; nav.appendChild(box);
    renderBtn();
    document.addEventListener("click", function () { var p = box.querySelector(".es-auth-pop"); if (p) p.hidden = true; });
    check();
  }
  window.addEventListener("storage", function (e) { if (e.key === KEY) emit(); });
  window.esAuth = { token: token, login: login, logout: logout, check: check, headers: headers, onChange: function (fn) { listeners.push(fn); } };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
