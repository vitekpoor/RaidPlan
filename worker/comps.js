// Meta sestavy (raider.io first-kill rosters of the top guilds) – D1 table rio_comps (migration 0006).
//
//   GET  /api/comps?raid=&difficulty=            { ok, raid, difficulty, updated, bosses: [{ slug, name, ordinal, region, kills, rosters, fetchedAt }] }
//   GET  /api/comps?boss=<slug>[&raid&difficulty] the same + boss: { …, requested, kills: [{ rank, guild, realm, region, defeatedAt, durationMs,
//                                                 ilvlAvg, roster: [{ name, class, spec, role, melee, ilvl }] }] }
//   POST /api/comps                              (auth) upsert one boss: the payload of tools/raidplan/rio_comps.mjs
//                                                { raid, difficulty, region, boss: { slug, name, ordinal }, fetchedAt, requested, kills }
//   POST /api/comps/refresh { boss?, kills? }    (admin) dispatch .github/workflows/comps.yml (Worker secret GITHUB_TOKEN); deduped 5 min
//   GET  /api/comps/status                       { lastDispatch, lastFetch, running } for the page's "computing…" indicator
// The aggregation (best / alternative roster) happens on the page (web/comps.html) so the "top N kills" choice stays interactive.

import { json, nowIso } from "./lib.js";

export const DEFAULT_RAID = "the-venomous-abyss";
const WORKFLOW = "comps.yml";
const GITHUB_REPO_DEFAULT = "vitekpoor/RaidPlan";
const DISPATCH_DEDUPE_MS = 5 * 60000;
const RUNNING_MS = 15 * 60000;
const MAX_DATA_BYTES = 900000;   // D1 value limit is 1 MB

function scope(url) {
  return { raid: (url.searchParams.get("raid") || DEFAULT_RAID).trim(), difficulty: (url.searchParams.get("difficulty") || "mythic").trim().toLowerCase() };
}

export async function getComps(env, url) {
  const { raid, difficulty } = scope(url);
  const boss = (url.searchParams.get("boss") || "").trim();
  const rows = (await env.DB.prepare(
    "SELECT boss_slug, boss_name, ordinal, region, kills, rosters, fetched_at FROM rio_comps WHERE raid = ?1 AND difficulty = ?2 ORDER BY ordinal, boss_slug"
  ).bind(raid, difficulty).all()).results;
  const bosses = rows.map((r) => ({ slug: r.boss_slug, name: r.boss_name, ordinal: r.ordinal, region: r.region, kills: r.kills, rosters: r.rosters, fetchedAt: r.fetched_at }));
  let updated = null;
  bosses.forEach((b) => { if (!updated || b.fetchedAt > updated) updated = b.fetchedAt; });
  const out = { ok: true, raid, difficulty, updated, bosses };
  if (boss) {
    const r = await env.DB.prepare("SELECT * FROM rio_comps WHERE raid = ?1 AND difficulty = ?2 AND boss_slug = ?3").bind(raid, difficulty, boss).first();
    if (!r) return json({ ok: false, error: `no data for boss ${boss}` }, 404);
    let data = {};
    try { data = JSON.parse(r.data || "{}"); } catch (e) { data = {}; }
    out.boss = { slug: r.boss_slug, name: r.boss_name, ordinal: r.ordinal, region: r.region, kills: r.kills, rosters: r.rosters, fetchedAt: r.fetched_at,
                 requested: data.requested || null, kills: data.kills || [] };
  }
  return json(out, 200, { "cache-control": "public, max-age=60" });
}

export async function postComps(request, env) {
  let b;
  try { b = await request.json(); } catch (e) { return json({ ok: false, error: "invalid JSON" }, 400); }
  const raid = String(b.raid || "").trim(), difficulty = String(b.difficulty || "mythic").trim().toLowerCase();
  const boss = b.boss || {};
  if (!raid || !boss.slug) return json({ ok: false, error: "raid and boss.slug are required" }, 400);
  if (!Array.isArray(b.kills)) return json({ ok: false, error: "kills must be an array" }, 400);
  const kills = b.kills.map((k) => ({
    rank: Number(k.rank) || 0, guild: String(k.guild || ""), realm: String(k.realm || ""), realmSlug: String(k.realmSlug || ""), region: String(k.region || ""),
    defeatedAt: k.defeatedAt || null, durationMs: k.durationMs != null ? Number(k.durationMs) : null, ilvlAvg: k.ilvlAvg != null ? Number(k.ilvlAvg) : null,
    compsHidden: !!k.compsHidden, error: k.error ? String(k.error).slice(0, 200) : undefined,
    roster: (Array.isArray(k.roster) ? k.roster : []).map((m) => ({
      name: String(m.name || ""), class: String(m.class || ""), spec: String(m.spec || ""), role: String(m.role || ""), melee: !!m.melee, ilvl: m.ilvl != null ? Number(m.ilvl) : null,
    })).filter((m) => m.spec),
  }));
  const data = JSON.stringify({ region: String(b.region || "world"), requested: Number(b.requested) || kills.length, kills });
  if (data.length > MAX_DATA_BYTES) return json({ ok: false, error: `payload too large (${data.length} bytes) – lower --kills` }, 413);
  const fetchedAt = b.fetchedAt || nowIso();
  await env.DB.prepare(
    `INSERT INTO rio_comps (raid, boss_slug, difficulty, boss_name, ordinal, region, kills, rosters, fetched_at, data)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(raid, boss_slug, difficulty) DO UPDATE SET boss_name = ?4, ordinal = ?5, region = ?6, kills = ?7, rosters = ?8, fetched_at = ?9, data = ?10`
  ).bind(raid, String(boss.slug), difficulty, String(boss.name || boss.slug), Number(boss.ordinal) || 0, String(b.region || "world"),
         kills.length, kills.filter((k) => k.roster.length).length, fetchedAt, data).run();
  return json({ ok: true, boss: boss.slug, kills: kills.length, rosters: kills.filter((k) => k.roster.length).length, bytes: data.length });
}

// ---------------------------------------------------------------- refresh (GitHub Actions dispatch) ----
export async function refresh(request, env) {
  let body = {};
  try { body = await request.json(); } catch (e) { /* empty */ }
  if (!env.GITHUB_TOKEN) return json({ ok: false, error: "runner není napojený (Worker secret GITHUB_TOKEN)" }, 503);
  const boss = String(body.boss || "all").replace(/[^a-z0-9,'-]/gi, "").slice(0, 200) || "all";
  const kills = String(Math.min(500, Math.max(1, parseInt(body.kills, 10) || 100)));
  const key = "comps_dispatch";
  const last = await env.DB.prepare("SELECT value FROM meta WHERE key = ?1").bind(key).first();
  if (last && Date.now() - Date.parse(last.value) < DISPATCH_DEDUPE_MS) return json({ ok: true, dispatched: false, lastDispatch: last.value, message: "stahování už běží" });
  const repo = env.GITHUB_REPO || GITHUB_REPO_DEFAULT;
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json", "user-agent": "eternal-shadows-worker" },
    body: JSON.stringify({ ref: "main", inputs: { boss, kills, reason: String(body.reason || "page").slice(0, 80) } }),
  });
  if (r.status !== 204) return json({ ok: false, error: `GitHub API HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` }, 502);
  const now = nowIso();
  await env.DB.prepare("INSERT INTO meta (key, value, updated_at) VALUES (?1, ?2, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?2").bind(key, now).run();
  return json({ ok: true, dispatched: true, lastDispatch: now, message: "stahování z raider.io spuštěno v GitHub Actions – data se obnoví za 1–3 minuty" });
}

export async function status(env) {
  const last = await env.DB.prepare("SELECT value FROM meta WHERE key = ?1").bind("comps_dispatch").first();
  const f = await env.DB.prepare("SELECT MAX(fetched_at) AS f FROM rio_comps").first();
  const lastDispatch = last ? last.value : null;
  const running = !!lastDispatch && Date.now() - Date.parse(lastDispatch) < RUNNING_MS && (!f.f || f.f < lastDispatch);
  return json({ ok: true, lastDispatch, lastFetch: f.f || null, running });
}
