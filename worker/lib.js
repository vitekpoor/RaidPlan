// Shared helpers for the Eternal Shadows Worker.

export const SHEET_ID = "1CUG3oyufoNs5CrY68WMJVVHLJz-52uFQMuOtv5q3ECI";   // guild Google Sheet (Roster tab is still human-edited there)
export const ROSTER_CACHE_SECONDS = 600;

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
};

export function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS, ...extra },
  });
}

/** Same as Apps Script simNameKey_: lower case, no diacritics, trimmed. */
export function nameKey(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Same as Apps Script simSpecKey_ / simClassKey_: lower-case letters only ("Death Knight" → "deathknight"). */
export function specKey(s) {
  return String(s || "").toLowerCase().replace(/[^a-z]/g, "");
}

export function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export function nowIso() {
  return new Date().toISOString();
}

/** "21.9. 14:05" in the guild's time zone (Apps Script used the sheet's zone, Europe/Prague). */
export function whenText(d = new Date()) {
  const p = {};
  new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Prague", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(d).forEach((x) => { p[x.type] = x.value; });
  return `${p.day}.${p.month}. ${p.hour}:${p.minute}`;
}

export function requireAuth(request, env) {
  if (!env.API_TOKEN) return json({ ok: false, error: "API_TOKEN secret is not configured on the Worker" }, 503);
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") || "");
  if (!m || !timingSafeEqual(m[1].trim(), env.API_TOKEN)) return json({ ok: false, error: "unauthorized" }, 401);
  return null;
}

export function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Split a migration file into statements: drop "--" comment lines, split on ";". */
export function splitSql(sql) {
  return sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n")
    .split(";").map((s) => s.trim()).filter(Boolean);
}

/** RFC 4180-ish CSV → array of rows (arrays of strings). */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Roster as a flat list [{ player, main, mainClass, mainRole, alt, altClass, altRole, ... }].
 * Source = D1 tables roster_players / roster_characters (worker/roster.js). While those are empty
 * (before the one-time import) it falls back to the Google Sheet "Roster" tab (gviz CSV, edge-cached 10 min).
 */
export async function fetchRoster(env, ctx, origin) {
  const { loadRoster, flatRoster } = await import("./roster.js");
  const players = await loadRoster(env);
  if (players.length) return flatRoster(players);
  return fetchRosterSheet(env, ctx, origin);
}

export async function fetchRosterSheet(env, ctx, origin) {
  const cache = caches.default;
  const key = new Request(`${origin}/__cache/roster`, { method: "GET" });
  let res = await cache.match(key);
  if (!res) {
    const sheet = env.SHEET_ID || SHEET_ID;
    const url = `https://docs.google.com/spreadsheets/d/${sheet}/gviz/tq?tqx=out:csv&headers=1&sheet=Roster`;
    const r = await fetch(url, { headers: { "user-agent": "eternal-shadows-worker" } });
    if (!r.ok) throw new Error(`Roster sheet HTTP ${r.status}`);
    const text = await r.text();
    if (!/^"?Hráč/i.test(text.trim())) throw new Error("Roster sheet: unexpected header");
    res = new Response(text, { headers: { "content-type": "text/csv; charset=utf-8", "cache-control": `public, s-maxage=${ROSTER_CACHE_SECONDS}` } });
    if (ctx) ctx.waitUntil(cache.put(key, res.clone()));
  }
  return rosterFromCsv(await res.text());
}

export function rosterFromCsv(text) {
  const table = parseCsv(text);
  const head = (table.shift() || []).map((h) => String(h || "").trim().toLowerCase());
  const HEAD = ["Hráč", "Main char", "Main classa", "Main role", "Alt char", "Alt classa", "Alt role"];
  const col = {};
  HEAD.forEach((h, i) => { const j = head.indexOf(h.toLowerCase()); col[h] = j >= 0 ? j : i; });
  const out = [];
  for (const v of table) {
    const g = (h) => String(v[col[h]] == null ? "" : v[col[h]]).trim();
    const player = g("Hráč"), main = g("Main char");
    if (!player || !main) continue;
    const mainRole = g("Main role").toLowerCase();
    out.push({ player, main, mainClass: g("Main classa"), mainRole, alt: g("Alt char"), altClass: g("Alt classa"), altRole: g("Alt role").toLowerCase() || mainRole });
  }
  return out;
}

/** Character → roster player name (main or alt), "" when unknown. */
export function playerOf(roster, character) {
  const key = nameKey(character);
  for (const r of roster) {
    if ((r.main && nameKey(r.main) === key) || (r.alt && nameKey(r.alt) === key)) return r.player;
  }
  return "";
}

/** One CSV line (RFC 4180 quoting). */
export function csvLine(cells) {
  return cells.map((c) => { const s = String(c == null ? "" : c); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(",");
}

/** Today's date "yyyy-mm-dd" in Europe/Prague. */
export function todayPrague(d = new Date()) {
  const p = {};
  new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Prague", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d).forEach((x) => { p[x.type] = x.value; });
  return `${p.year}-${p.month}-${p.day}`;
}

export function addDays(iso, n) {
  return new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
}

// ---- admin login: token "<expiry ms>.<base64url hmac-sha256(expiry, ADMIN_PASSWORD)>", 30 days

const ADMIN_TOKEN_DAYS = 30;

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function adminLogin(request, env) {
  if (!env.ADMIN_PASSWORD) return json({ ok: false, error: "ADMIN_PASSWORD secret is not configured on the Worker" }, 503);
  let body = {};
  try { body = await request.json(); } catch (e) { /* empty */ }
  if (!timingSafeEqual(String(body.pw || ""), env.ADMIN_PASSWORD)) return json({ ok: false, error: "Špatné heslo." }, 401);
  const exp = String(Date.now() + ADMIN_TOKEN_DAYS * 86400000);
  return json({ ok: true, token: exp + "." + (await hmac(env.ADMIN_PASSWORD, exp)), expires: new Date(Number(exp)).toISOString() });
}

/** Admin = API_TOKEN bearer or a valid login token. Returns a Response when denied, null when allowed. */
export async function requireAdmin(request, env) {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") || "");
  const tok = m ? m[1].trim() : "";
  if (!tok) return json({ ok: false, error: "unauthorized" }, 401);
  if (env.API_TOKEN && timingSafeEqual(tok, env.API_TOKEN)) return null;
  const parts = tok.split(".");
  if (parts.length === 2 && env.ADMIN_PASSWORD && /^\d+$/.test(parts[0]) && Number(parts[0]) > Date.now()) {
    if (timingSafeEqual(parts[1], await hmac(env.ADMIN_PASSWORD, parts[0]))) return null;
  }
  return json({ ok: false, error: "unauthorized" }, 401);
}
