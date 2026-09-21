// Shared helpers for the Eternal Shadows Worker.

export const SHEET_ID = "1CUG3oyufoNs5CrY68WMJVVHLJz-52uFQMuOtv5q3ECI";   // guild Google Sheet (Roster tab is still human-edited there)
export const ROSTER_CACHE_SECONDS = 600;

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
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
 * Roster from the Google Sheet (gviz CSV, tab "Roster"; header-mapped like getRoster_ in Apps Script,
 * the live tab has an empty column between "Main role" and "Alt char"). Cached at the edge for 10 minutes.
 * → [{ player, main, mainClass, mainRole, alt, altClass, altRole }]
 */
export async function fetchRoster(env, ctx, origin) {
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
