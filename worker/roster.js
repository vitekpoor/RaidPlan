// Roster: players + their characters (tables roster_players, roster_characters – 0003).
//   GET  /api/roster          (public, edge-cached 60 s) { players: [{ id, name, bench, note, characters: [{ id, name, class, role, spec, main }] }] }
//   GET  /api/roster.csv      (public) sheet-compatible CSV: "Hráč","Main char","Main classa","Main role","","Alt char","Alt classa",
//                             "Alt role","Poznámka","Main spec","Alt spec" + a "LAVIČKA" separator row before bench players –
//                             the same layout the Google Sheet "Roster" tab had, so loot.html, addon/build_roster.py,
//                             tools/raidplan/raidplan.py and the Apps Script getRoster_ only needed a new URL.
//   PUT  /api/roster          (admin) full replace: { players: [{ id?, name, bench, note, characters: [{ name, class, role, spec, main }] }] }
//                             a player with id keeps that row (renames allowed); without id it is matched by name; player names are unique
//   POST /api/admin/login     { pw } → { token } (secret ADMIN_PASSWORD); GET /api/admin/check (admin) → { ok }
// Admin = "Authorization: Bearer <token>" where token is either the API_TOKEN or a login token
// "<expiry>.<hmac-sha256(expiry, ADMIN_PASSWORD)>" valid for 30 days (see requireAdmin in lib.js).

import { json, nameKey, nowIso, csvLine, CORS } from "./lib.js";

export const CLASSES = ["Death Knight", "Demon Hunter", "Druid", "Evoker", "Hunter", "Mage", "Monk", "Paladin", "Priest", "Rogue", "Shaman", "Warlock", "Warrior"];
export const ROLES = ["tank", "heal", "dps"];
const ROSTER_CACHE_SECONDS = 60;

/** All players with characters, roster order (main roster first, bench last). */
export async function loadRoster(env) {
  const players = (await env.DB.prepare("SELECT * FROM roster_players ORDER BY bench, sort_order, id").all()).results;
  const chars = (await env.DB.prepare("SELECT * FROM roster_characters ORDER BY player_id, is_main DESC, sort_order, id").all()).results;
  const byPlayer = new Map();
  for (const c of chars) {
    if (!byPlayer.has(c.player_id)) byPlayer.set(c.player_id, []);
    byPlayer.get(c.player_id).push({ id: c.id, name: c.name, class: c.class, role: c.role, spec: c.spec, main: !!c.is_main });
  }
  return players.map((p) => ({ id: p.id, name: p.name, bench: !!p.bench, note: p.note || "", updatedAt: p.updated_at, characters: byPlayer.get(p.id) || [] }));
}

/** Flat view used by the sim queue / absence code (same fields the old sheet reader produced). */
export function flatRoster(players) {
  return players.map((p) => {
    const main = p.characters.find((c) => c.main) || p.characters[0] || {};
    const alt = p.characters.find((c) => c !== main) || {};
    return { player: p.name, main: main.name || "", mainClass: main.class || "", mainRole: main.role || "", mainSpec: main.spec || "",
             alt: alt.name || "", altClass: alt.class || "", altRole: alt.role || main.role || "", altSpec: alt.spec || "",
             bench: p.bench, note: p.note, characters: p.characters };
  });
}

export function rosterCacheKey(url) {
  return new Request(new URL("/api/roster", url.origin).toString(), { method: "GET" });
}

export async function getRoster(env, ctx, url) {
  const cache = caches.default, key = rosterCacheKey(url);
  const hit = await cache.match(key);
  if (hit) return hit;
  const players = await loadRoster(env);
  let updated = null;
  players.forEach((p) => { if (!updated || p.updatedAt > updated) updated = p.updatedAt; });
  const res = json({ ok: true, updated, count: players.length, players }, 200, { "cache-control": `public, max-age=0, s-maxage=${ROSTER_CACHE_SECONDS}` });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

export async function getRosterCsv(env) {
  const players = await loadRoster(env);
  const lines = [csvLine(["Hráč", "Main char", "Main classa", "Main role", "", "Alt char", "Alt classa", "Alt role", "Poznámka", "Main spec", "Alt spec"])];
  let benchStarted = false;
  for (const f of flatRoster(players)) {
    if (f.bench && !benchStarted) { lines.push(csvLine(["LAVIČKA", "", "", "", "", "", "", "", "", "", ""])); benchStarted = true; }
    lines.push(csvLine([f.player, f.main, f.mainClass, f.mainRole, "", f.alt, f.altClass, f.alt ? f.altRole : "", f.note, f.mainSpec, f.altSpec]));
  }
  return new Response(lines.join("\r\n") + "\r\n", {
    headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store", ...CORS },
  });
}

/** PUT /api/roster – full replace (players keep their ids when the name stays the same). */
export async function putRoster(request, env, ctx, url) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: "body must be JSON" }, 400); }
  const players = Array.isArray(body.players) ? body.players : null;
  if (!players) return json({ ok: false, error: "players must be an array" }, 400);
  if (players.length > 200) return json({ ok: false, error: "too many players" }, 400);
  const seen = new Set(), charSeen = new Set(), clean = [];
  for (const p of players) {
    const name = String((p && p.name) || "").trim();
    if (!name) return json({ ok: false, error: "player name is required" }, 400);
    const key = nameKey(name);
    if (seen.has(key)) return json({ ok: false, error: `duplicate player ${name}` }, 400);
    seen.add(key);
    const chars = Array.isArray(p.characters) ? p.characters : [];
    const cs = [];
    for (const c of chars) {
      const cn = String((c && c.name) || "").trim();
      if (!cn) continue;
      const ck = nameKey(cn);
      if (charSeen.has(ck)) return json({ ok: false, error: `character ${cn} is listed twice` }, 400);
      charSeen.add(ck);
      const role = String(c.role || "dps").toLowerCase();
      if (!ROLES.includes(role)) return json({ ok: false, error: `${cn}: role must be tank/heal/dps` }, 400);
      cs.push({ name: cn, key: ck, class: String(c.class || "").trim(), role, spec: String(c.spec || "").trim().toLowerCase(), main: !!c.main });
    }
    if (cs.length && !cs.some((c) => c.main)) cs[0].main = true;
    if (cs.filter((c) => c.main).length > 1) return json({ ok: false, error: `${name}: only one main character` }, 400);
    const id = Number(p.id) > 0 ? Number(p.id) : null;
    clean.push({ id, name, key, bench: p.bench ? 1 : 0, note: String(p.note || "").trim(), characters: cs });
  }
  const now = nowIso();
  const stmts = [];
  // players not in the payload are removed (matched by id when the page sent one, else by name)
  const keys = clean.map((p) => p.key), ids = clean.map((p) => p.id).filter(Boolean);
  const cond = [];
  if (keys.length) cond.push(`name_key NOT IN (${keys.map((_, i) => `?${i + 1}`).join(", ")})`);
  if (ids.length) cond.push(`id NOT IN (${ids.map((_, i) => `?${keys.length + i + 1}`).join(", ")})`);
  stmts.push(env.DB.prepare(`DELETE FROM roster_players${cond.length ? " WHERE " + cond.join(" AND ") : ""}`).bind(...keys, ...ids));
  clean.forEach((p, i) => {
    if (p.id) {
      // existing row: keep its id even when the player is renamed
      stmts.push(env.DB.prepare("UPDATE roster_players SET name = ?2, name_key = ?3, sort_order = ?4, bench = ?5, note = ?6, updated_at = ?7 WHERE id = ?1")
        .bind(p.id, p.name, p.key, i, p.bench, p.note, now));
    }
    stmts.push(env.DB.prepare(
      `INSERT INTO roster_players (name, name_key, sort_order, bench, note, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(name_key) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order, bench = excluded.bench, note = excluded.note, updated_at = excluded.updated_at`
    ).bind(p.name, p.key, i, p.bench, p.note, now));
    stmts.push(env.DB.prepare("DELETE FROM roster_characters WHERE player_id = (SELECT id FROM roster_players WHERE name_key = ?1)").bind(p.key));
    p.characters.forEach((c, j) => {
      stmts.push(env.DB.prepare(
        `INSERT INTO roster_characters (player_id, name, name_key, class, role, spec, is_main, sort_order)
         VALUES ((SELECT id FROM roster_players WHERE name_key = ?1), ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
      ).bind(p.key, c.name, c.key, c.class, c.role, c.spec, c.main ? 1 : 0, j));
    });
  });
  await env.DB.batch(stmts);
  ctx.waitUntil(caches.default.delete(rosterCacheKey(url)));
  return json({ ok: true, players: clean.length, characters: clean.reduce((n, p) => n + p.characters.length, 0) });
}
