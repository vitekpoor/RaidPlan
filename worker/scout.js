// Nábor – admin-only scouting of players from the guilds ranked below us on the server: Warcraft Logs parse averages
// (95+ on heroic or mythic) + raider.io contact info. Written by tools/recruit/wcl_scout.mjs (GitHub Actions scout.yml),
// shown on web/scout.html (the page and its menu item exist only for a logged-in admin). D1 tables scout_guilds,
// scout_players (migration 0010), scout_notes (admin's contact notes, 0011), run info in meta key scout_run.
//
//   GET  /api/scout                    (admin) { ok, run, guilds: [...], players: [...] }
//   GET  /api/scout/status             (admin) { ok, run, lastDispatch, running }
//   POST /api/scout/refresh            (admin) dispatch scout.yml { minAvg?, maxRank?, maxRankHc?, diff?, reason? } (Worker secret GITHUB_TOKEN), deduped 10 min
//   POST /api/scout/note               (admin) { key, status, contactedAt, note } → scout_notes (migration 0011; survives the scrape's
//                                              upsert + prune, a player who drops out and returns gets the note back)
//   POST /api/scout/run                (auth)  { runId, phase: start | progress | finish | error, ...info } → meta scout_run
//                                              (finish with prune: true deletes guilds/players of other runs)
//   POST /api/scout/guilds             (auth)  { runId, guilds: [{ id, name, faction, serverRank (mythic), hcRank, worldRank, progress, candidates, players }] } upsert
//   POST /api/scout/players            (auth)  { runId, players: [{ key, name, realm, class, spec, role, faction, guildId, guildName, ilvl,
//                                                hcBest, hcMedian, hcKills, myBest, myMedian, myKills, wclUrl, rioUrl, bio, battletag,
//                                                discord, socials, recruitment, data }] } upsert

import { json, nowIso } from "./lib.js";

const WORKFLOW = "scout.yml";
const GITHUB_REPO_DEFAULT = "vitekpoor/RaidPlan";
const DISPATCH_DEDUPE_MS = 10 * 60000;
const RUNNING_MS = 5 * 3600000;   // a full scrape can take a couple of hours (WCL points per hour)

async function metaGet(env, key) {
  const r = await env.DB.prepare("SELECT value FROM meta WHERE key = ?1").bind(key).first();
  if (!r) return null;
  try { return JSON.parse(r.value); } catch (e) { return r.value; }
}
async function metaSet(env, key, value) {
  const now = nowIso();
  await env.DB.prepare("INSERT INTO meta (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3")
    .bind(key, typeof value === "string" ? value : JSON.stringify(value), now).run();
}
const parse = (s, dflt) => { try { const v = JSON.parse(s); return v == null ? dflt : v; } catch (e) { return dflt; } };
const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const str = (v, max = 2000) => String(v == null ? "" : v).slice(0, max);

export async function getScout(env) {
  const run = await metaGet(env, "scout_run");
  // mythic-ranked guilds first (by mythic rank), then the heroic-only ones by heroic rank
  const guilds = (await env.DB.prepare("SELECT * FROM scout_guilds ORDER BY (server_rank IS NULL), server_rank, hc_rank, name").all()).results
    .map((g) => ({ id: g.id, name: g.name, faction: g.faction, serverRank: g.server_rank, hcRank: g.hc_rank, worldRank: g.world_rank, progress: g.progress || "", candidates: g.candidates, players: g.players, fetchedAt: g.fetched_at }));
  const players = (await env.DB.prepare(
    `SELECT p.*, n.status AS n_status, n.contacted_at AS n_contacted, n.note AS n_note, n.updated_at AS n_updated
     FROM scout_players p LEFT JOIN scout_notes n ON n.key = p.key ORDER BY p.guild_name, p.name`).all()).results.map((r) => ({
    key: r.key, name: r.name, realm: r.realm, class: r.class, spec: r.spec, role: r.role, faction: r.faction || "", guildId: r.guild_id, guildName: r.guild_name, ilvl: r.ilvl,
    hcBest: r.hc_best, hcMedian: r.hc_median, hcKills: r.hc_kills, myBest: r.my_best, myMedian: r.my_median, myKills: r.my_kills,
    wclUrl: r.wcl_url, rioUrl: r.rio_url, bio: r.bio, battletag: r.battletag, discord: r.discord,
    socials: parse(r.socials, {}), recruitment: parse(r.recruitment, []), data: parse(r.data, {}), fetchedAt: r.fetched_at,
    note: r.n_updated ? { status: r.n_status || "", contactedAt: r.n_contacted || "", note: r.n_note || "", updatedAt: r.n_updated } : null,
  }));
  // notes of players no longer in the scrape (dropped below the threshold, left the server…) – shown in their own block
  const orphans = (await env.DB.prepare(
    "SELECT n.* FROM scout_notes n LEFT JOIN scout_players p ON p.key = n.key WHERE p.key IS NULL AND (n.status <> '' OR n.note <> '') ORDER BY n.updated_at DESC").all()).results
    .map((n) => ({ key: n.key, name: n.name, status: n.status, contactedAt: n.contacted_at, note: n.note, updatedAt: n.updated_at }));
  return json({ ok: true, run, guilds, players, orphans }, 200, { "cache-control": "no-store" });
}

export async function postRun(request, env) {
  let b;
  try { b = await request.json(); } catch (e) { return json({ ok: false, error: "invalid JSON" }, 400); }
  const runId = str(b.runId, 64);
  if (!runId) return json({ ok: false, error: "runId required" }, 400);
  const prev = (await metaGet(env, "scout_run")) || {};
  const cur = prev.runId === runId ? prev : { runId, startedAt: b.startedAt || nowIso() };
  const { prune, ...info } = b;
  const run = { ...cur, ...info, updatedAt: nowIso() };
  if (b.phase === "finish") run.finishedAt = run.finishedAt || nowIso();
  if (b.log) run.log = str(b.log, 20000);
  await metaSet(env, "scout_run", run);
  let pruned = 0;
  if (b.phase === "finish" && prune) {
    const r1 = await env.DB.prepare("DELETE FROM scout_players WHERE run_id <> ?1").bind(runId).run();
    const r2 = await env.DB.prepare("DELETE FROM scout_guilds WHERE run_id <> ?1").bind(runId).run();
    pruned = ((r1.meta && r1.meta.changes) || 0) + ((r2.meta && r2.meta.changes) || 0);
  }
  return json({ ok: true, run, pruned });
}

export async function postGuilds(request, env) {
  let b;
  try { b = await request.json(); } catch (e) { return json({ ok: false, error: "invalid JSON" }, 400); }
  const runId = str(b.runId, 64), now = nowIso();
  const guilds = Array.isArray(b.guilds) ? b.guilds : [];
  if (!guilds.length) return json({ ok: true, guilds: 0 });
  const stmt = env.DB.prepare(
    `INSERT INTO scout_guilds (id, name, faction, server_rank, world_rank, candidates, players, run_id, fetched_at, hc_rank, progress)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT(id) DO UPDATE SET name = ?2, faction = ?3, server_rank = ?4, world_rank = ?5, candidates = ?6, players = ?7, run_id = ?8, fetched_at = ?9, hc_rank = ?10, progress = ?11`);
  await env.DB.batch(guilds.filter((g) => Number(g.id)).map((g) => stmt.bind(
    Number(g.id), str(g.name, 200), str(g.faction, 20), num(g.serverRank), num(g.worldRank), Number(g.candidates) || 0, Number(g.players) || 0, runId, now, num(g.hcRank), str(g.progress, 60))));
  return json({ ok: true, guilds: guilds.length });
}

export async function postPlayers(request, env) {
  let b;
  try { b = await request.json(); } catch (e) { return json({ ok: false, error: "invalid JSON" }, 400); }
  const runId = str(b.runId, 64), now = nowIso();
  const players = Array.isArray(b.players) ? b.players : [];
  if (!players.length) return json({ ok: true, players: 0 });
  const stmt = env.DB.prepare(
    `INSERT INTO scout_players (key, name, realm, class, spec, role, guild_id, guild_name, ilvl, hc_best, hc_median, hc_kills, my_best, my_median, my_kills,
       wcl_url, rio_url, bio, battletag, discord, socials, recruitment, data, run_id, fetched_at, faction)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)
     ON CONFLICT(key) DO UPDATE SET name = ?2, realm = ?3, class = ?4, spec = ?5, role = ?6, guild_id = ?7, guild_name = ?8, ilvl = ?9,
       hc_best = ?10, hc_median = ?11, hc_kills = ?12, my_best = ?13, my_median = ?14, my_kills = ?15, wcl_url = ?16, rio_url = ?17, bio = ?18,
       battletag = ?19, discord = ?20, socials = ?21, recruitment = ?22, data = ?23, run_id = ?24, fetched_at = ?25, faction = ?26`);
  const rows = players.filter((p) => p && p.key && p.name).map((p) => stmt.bind(
    str(p.key, 120), str(p.name, 60), str(p.realm, 60), str(p.class, 30), str(p.spec, 30), str(p.role, 10), num(p.guildId), str(p.guildName, 200), num(p.ilvl),
    num(p.hcBest), num(p.hcMedian), Number(p.hcKills) || 0, num(p.myBest), num(p.myMedian), Number(p.myKills) || 0,
    str(p.wclUrl, 300), str(p.rioUrl, 300), str(p.bio, 4000), str(p.battletag, 100), str(p.discord, 100),
    JSON.stringify(p.socials || {}).slice(0, 2000), JSON.stringify(p.recruitment || []).slice(0, 8000), JSON.stringify(p.data || {}).slice(0, 20000), runId, now,
    ["alliance", "horde"].includes(String(p.faction || "").toLowerCase()) ? String(p.faction).toLowerCase() : ""));
  // D1 batch limit is generous, but keep statements per batch modest
  for (let i = 0; i < rows.length; i += 50) await env.DB.batch(rows.slice(i, i + 50));
  return json({ ok: true, players: rows.length });
}

const NOTE_STATUS = ["", "contacted", "replied", "talking", "declined", "joined", "skip"];

/** admin's note on a player: empty status + empty note deletes the row */
export async function postNote(request, env) {
  let b;
  try { b = await request.json(); } catch (e) { return json({ ok: false, error: "invalid JSON" }, 400); }
  const key = str(b.key, 120);
  if (!key) return json({ ok: false, error: "key required" }, 400);
  const status = NOTE_STATUS.includes(b.status) ? b.status : "";
  const contactedAt = /^\d{4}-\d{2}-\d{2}$/.test(String(b.contactedAt || "")) ? b.contactedAt : "";
  const note = str(b.note, 4000).trim();
  const now = nowIso();
  if (!status && !note && !contactedAt) {
    await env.DB.prepare("DELETE FROM scout_notes WHERE key = ?1").bind(key).run();
    return json({ ok: true, note: null });
  }
  const name = str(b.name, 60) || ((await env.DB.prepare("SELECT name FROM scout_players WHERE key = ?1").bind(key).first()) || {}).name || key;
  await env.DB.prepare(
    `INSERT INTO scout_notes (key, name, status, contacted_at, note, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(key) DO UPDATE SET name = ?2, status = ?3, contacted_at = ?4, note = ?5, updated_at = ?6`).bind(key, name, status, contactedAt, note, now).run();
  return json({ ok: true, note: { status, contactedAt, note, updatedAt: now } });
}

export async function refresh(request, env) {
  let body = {};
  try { body = await request.json(); } catch (e) { /* empty */ }
  if (!env.GITHUB_TOKEN) return json({ ok: false, error: "runner není napojený (Worker secret GITHUB_TOKEN)" }, 503);
  const key = "scout_dispatch";
  const last = await metaGet(env, key);
  if (last && Date.now() - Date.parse(last) < DISPATCH_DEDUPE_MS) return json({ ok: true, dispatched: false, lastDispatch: last, message: "scraping už běží" });
  const repo = env.GITHUB_REPO || GITHUB_REPO_DEFAULT;
  const inputs = {
    min_avg: String(Math.min(100, Math.max(0, Number(body.minAvg) || 95))),
    max_rank: String(Math.min(100, Math.max(1, parseInt(body.maxRank, 10) || 20))),
    max_rank_hc: String(Math.min(200, Math.max(1, parseInt(body.maxRankHc, 10) || 40))),
    diff: ["auto", "both", "hc", "my"].includes(body.diff) ? body.diff : "auto",
    reason: str(body.reason || "page", 80),
  };
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json", "user-agent": "eternal-shadows-worker" },
    body: JSON.stringify({ ref: "main", inputs }),
  });
  if (r.status !== 204) return json({ ok: false, error: `GitHub API HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` }, 502);
  const now = nowIso();
  await metaSet(env, key, now);
  return json({ ok: true, dispatched: true, lastDispatch: now, message: "scraping Warcraft Logs spuštěn v GitHub Actions – podle počtu hráčů trvá 10 min až 2 h (limit bodů WCL API)" });
}

export async function status(env) {
  const [run, lastDispatch] = await Promise.all([metaGet(env, "scout_run"), metaGet(env, "scout_dispatch")]);
  const active = run && (run.phase === "start" || run.phase === "progress") && Date.now() - Date.parse(run.startedAt || 0) < RUNNING_MS;
  const pending = !!lastDispatch && Date.now() - Date.parse(lastDispatch) < DISPATCH_DEDUPE_MS && (!run || !run.startedAt || run.startedAt < lastDispatch);
  return json({ ok: true, run, lastDispatch, running: !!active || pending }, 200, { "cache-control": "no-store" });
}
