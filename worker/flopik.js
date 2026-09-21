// Flopik – per-pull fails from Warcraft Logs (tables flopik_* – 0004). Replaces the Apps Script FLOPIK sections.
//   GET  /api/flopik/reports              guild reports for the dropdown (from WCL when secrets WCL_CLIENT_ID/SECRET are set
//                                         and the cached list is older than 2 min; otherwise the list the runner stored)
//   GET  /api/flopik/pulls                light list of all pulls (no players) – nights index
//   GET  /api/flopik/pulls?report=CODE    pulls of one report with meta + players (edge-cached 30 s)
//   POST /api/flopik/pulls                (auth) { pull } – upsert one pull (same key rules as flopikRecordPull_)
//   POST /api/flopik/pulls/parse          (auth) { report, fight, players: {name: parse}, state, error } – patch parses into a stored kill
//   GET  /api/flopik/refs                 rank 1 reference breakdowns { key: ref }
//   POST /api/flopik/refs                 (auth) { ref } | { refs: [...] } – upsert
//   POST /api/flopik/reports              (auth) { reports: [...] } – replace the cached guild report list
//   GET  /api/flopik/refwin?key&end       reference breakdown cut at `end` s (WCL secrets in the Worker; cached 6 h)
//   POST /api/flopik/refresh { code }     dispatch the GitHub Actions runner (flopik.yml) for a report; deduped 2 min
//   GET  /api/flopik/status?code          { lastDispatch, lastPull } for the page's "computing…" indicator
// The pulls themselves are computed by tools/flopik/wcl_refresh.mjs (Node, GitHub Actions) with tools/flopik/engine.js –
// a fight's events are megabytes of JSON, more than the free Worker CPU budget allows.

import { json, nowIso, numOrNull } from "./lib.js";
import { makeWcl, guildReports, reportCode, referenceWindow, GUILD } from "../tools/flopik/wcl_lib.js";

const PULLS_CACHE_SECONDS = 30;
const REPORTS_MAX_AGE_MS = 120000;
const REFWIN_MAX_AGE_MS = 6 * 3600000;
const DISPATCH_DEDUPE_MS = 120000;
const GITHUB_REPO_DEFAULT = "vitekpoor/RaidPlan";
const WORKFLOW = "flopik.yml";

function pullsCacheKey(url, report) {
  return new Request(new URL("/api/flopik/pulls" + (report ? "?report=" + encodeURIComponent(report) : ""), url.origin).toString(), { method: "GET" });
}

async function invalidatePulls(ctx, url, report) {
  const c = caches.default;
  ctx.waitUntil(Promise.all([c.delete(pullsCacheKey(url, "")), report ? c.delete(pullsCacheKey(url, report)) : Promise.resolve()]));
}

function wclFor(env) {
  if (!env.WCL_CLIENT_ID || !env.WCL_CLIENT_SECRET) return null;
  const store = {
    async get() { const r = await env.DB.prepare("SELECT value FROM meta WHERE key = 'wcl_token'").first(); try { return r ? JSON.parse(r.value) : null; } catch (e) { return null; } },
    async set(tok) { await env.DB.prepare("INSERT INTO meta (key, value, updated_at) VALUES ('wcl_token', ?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = ?2").bind(JSON.stringify(tok), nowIso()).run(); },
  };
  return makeWcl(env.WCL_CLIENT_ID, env.WCL_CLIENT_SECRET, store);
}

// ---------------------------------------------------------------- reports ----

export async function getReports(env, ctx, url) {
  const cache = caches.default, key = new Request(new URL("/api/flopik/reports", url.origin).toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  let rows = (await env.DB.prepare("SELECT * FROM flopik_reports ORDER BY start_ms DESC").all()).results;
  let source = "db", error = null;
  const newest = rows.reduce((m, r) => (r.fetched_at > m ? r.fetched_at : m), "");
  const gql = wclFor(env);
  if (gql && (!rows.length || Date.now() - Date.parse(newest || 0) > REPORTS_MAX_AGE_MS)) {
    try {
      const list = await guildReports(gql);
      await storeReports(env, list);
      rows = list.map((r) => ({ code: r.code, title: r.title, start_ms: r.start, end_ms: r.end, zone: r.zone }));
      source = "wcl";
    } catch (e) { error = String((e && e.message) || e); }
  }
  const reports = rows.map((r) => ({ code: r.code, title: r.title, start: r.start_ms, end: r.end_ms, zone: r.zone }));
  const res = json({ ok: true, guild: GUILD, reports, source, error, fetchedAt: newest || null }, 200, { "cache-control": "public, max-age=0, s-maxage=60" });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

async function storeReports(env, list) {
  const now = nowIso();
  const stmts = [env.DB.prepare("DELETE FROM flopik_reports")];
  for (const r of list) {
    stmts.push(env.DB.prepare("INSERT OR REPLACE INTO flopik_reports (code, title, start_ms, end_ms, zone, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(String(r.code), String(r.title || ""), numOrNull(r.start), numOrNull(r.end), String(r.zone || ""), now));
  }
  await env.DB.batch(stmts);
}

export async function postReports(request, env, ctx, url) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: "body must be JSON" }, 400); }
  const list = Array.isArray(body.reports) ? body.reports.filter((r) => r && r.code) : [];
  await storeReports(env, list);
  ctx.waitUntil(caches.default.delete(new Request(new URL("/api/flopik/reports", url.origin).toString())));
  return json({ ok: true, reports: list.length });
}

// ------------------------------------------------------------------ pulls ----

function rowToPull(r, players) {
  let meta = {};
  try { meta = JSON.parse(r.meta || "{}"); } catch (e) { meta = {}; }
  const out = { id: r.id, report: r.report, fight: r.fight, date: r.date, no: r.pull_no, boss: r.boss, bossKey: r.boss_key, bossId: r.boss_id,
                difficulty: r.difficulty, start: r.start, startMs: r.start_ms, dur: r.dur, kill: !!r.kill, ver: r.ver, writtenAt: r.written_at };
  if (players) {
    out.meta = meta;
    out.players = players.map((p) => { let d = {}; try { d = JSON.parse(p.data || "{}"); } catch (e) { d = {}; } d.name = p.name; return d; });
  }
  return out;
}

export async function getPulls(env, ctx, url) {
  const raw = url.searchParams.get("report") || "";
  // "d:YYYY-MM-DD" = pulls recorded from a local combat log (no WCL report) on that day
  const localDay = /^d:\d{4}-\d{2}-\d{2}$/.test(raw) ? raw.slice(2) : "";
  const report = localDay ? raw : reportCode(raw);
  const cache = caches.default, key = pullsCacheKey(url, report);
  const hit = await cache.match(key);
  if (hit) return hit;
  let body;
  if (report) {
    const where = localDay ? "report = '' AND date = ?1" : "report = ?1";
    const arg = localDay || report;
    const pulls = (await env.DB.prepare(`SELECT * FROM flopik_pulls WHERE ${where} ORDER BY start_ms, start, id`).bind(arg).all()).results;
    const players = (await env.DB.prepare(`SELECT p.* FROM flopik_players p JOIN flopik_pulls f ON f.id = p.pull_id WHERE f.${where} ORDER BY p.pull_id, p.id`).bind(arg).all()).results;
    const byPull = new Map();
    for (const p of players) { if (!byPull.has(p.pull_id)) byPull.set(p.pull_id, []); byPull.get(p.pull_id).push(p); }
    body = { ok: true, report, pulls: pulls.map((r) => rowToPull(r, byPull.get(r.id) || [])) };
  } else {
    const pulls = (await env.DB.prepare("SELECT id, report, fight, date, pull_no, boss, boss_key, boss_id, difficulty, start, start_ms, dur, kill, ver, written_at FROM flopik_pulls ORDER BY date, start, id").all()).results;
    body = { ok: true, pulls: pulls.map((r) => rowToPull(r, null)) };
  }
  const res = json(body, 200, { "cache-control": `public, max-age=0, s-maxage=${PULLS_CACHE_SECONDS}` });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

/** POST /api/flopik/pulls { pull } – port of flopikRecordPull_: same report+fight (or date+boss+start) overwrites, pull number = order within the day and boss. */
export async function postPull(request, env, ctx, url) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: "body must be JSON" }, 400); }
  const pull = body.pull || body;
  const date = String(pull.date || ""), start = String(pull.start || ""), bossKey = String(pull.bossKey || "");
  if (!date || !start || !bossKey) return json({ ok: false, error: "chybí date / start / bossKey" }, 400);
  const report = reportCode(pull.report || "") || "", fight = pull.fight == null || pull.fight === "" ? null : Number(pull.fight);
  const existing = (await env.DB.prepare("SELECT id, pull_no, report, fight, start FROM flopik_pulls WHERE date = ?1 AND boss_key = ?2 ORDER BY pull_no").bind(date, bossKey).all()).results;
  let pullNo = 0, maxNo = 0;
  const del = [];
  for (const r of existing) {
    const same = r.start === start || (report && r.report === report && String(r.fight) === String(fight));
    if (same) { pullNo = pullNo || r.pull_no; del.push(r.id); } else if (r.pull_no > maxNo) maxNo = r.pull_no;
  }
  if (!pullNo) pullNo = maxNo + 1;
  const summary = pull.summary || {};
  const meta = { bossId: pull.bossId, deaths: pull.deaths, cutoff: pull.cutoff == null ? null : pull.cutoff, cols: pull.cols || [], stats: pull.stats || [],
                 legend: pull.legend || [], description: pull.description || "", summary, deathList: pull.deathList || [] };
  const now = nowIso();
  const stmts = del.map((id) => env.DB.prepare("DELETE FROM flopik_pulls WHERE id = ?1").bind(id));
  stmts.push(env.DB.prepare(
    `INSERT INTO flopik_pulls (report, fight, date, pull_no, boss, boss_key, boss_id, difficulty, start, start_ms, dur, kill, ver, meta, written_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`
  ).bind(report, fight, date, pullNo, String(pull.boss || bossKey), bossKey, numOrNull(pull.bossId), String(pull.difficulty || ""), start,
         numOrNull(pull.startMs), Number(pull.dur) || 0, pull.kill ? 1 : 0, Number(summary.ver) || 1, JSON.stringify(meta), now));
  for (const p of pull.players || []) {
    const data = {};
    Object.keys(p || {}).forEach((k) => { if (k !== "name") data[k] = p[k]; });
    stmts.push(env.DB.prepare(
      `INSERT INTO flopik_players (pull_id, name, data) VALUES ((SELECT id FROM flopik_pulls WHERE date = ?1 AND boss_key = ?2 AND start = ?3 ORDER BY id DESC LIMIT 1), ?4, ?5)`
    ).bind(date, bossKey, start, String(p.name || ""), JSON.stringify(data)));
  }
  await env.DB.batch(stmts);
  await invalidatePulls(ctx, url, report);
  return json({ ok: true, pull: pullNo, rows: 1 + (pull.players || []).length, replaced: del.length });
}

/** POST /api/flopik/pulls/parse – attach parses to a stored kill without recomputing it. */
export async function patchParse(request, env, ctx, url) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: "body must be JSON" }, 400); }
  const report = reportCode(body.report || ""), fight = Number(body.fight);
  if (!report || !(fight >= 0)) return json({ ok: false, error: "chybí report / fight" }, 400);
  const row = await env.DB.prepare("SELECT id, meta FROM flopik_pulls WHERE report = ?1 AND fight = ?2").bind(report, fight).first();
  if (!row) return json({ ok: false, error: "pull není uložený" }, 404);
  let meta = {};
  try { meta = JSON.parse(row.meta || "{}"); } catch (e) { meta = {}; }
  meta.summary = meta.summary || {};
  if (body.state) meta.summary.parse = String(body.state);
  if (body.error) meta.summary.parseError = String(body.error); else delete meta.summary.parseError;
  const stmts = [env.DB.prepare("UPDATE flopik_pulls SET meta = ?2 WHERE id = ?1").bind(row.id, JSON.stringify(meta))];
  const players = (await env.DB.prepare("SELECT id, name, data FROM flopik_players WHERE pull_id = ?1").bind(row.id).all()).results;
  let n = 0;
  for (const p of players) {
    const parse = (body.players || {})[p.name];
    if (!parse) continue;
    let d = {};
    try { d = JSON.parse(p.data || "{}"); } catch (e) { d = {}; }
    d.parse = parse;
    stmts.push(env.DB.prepare("UPDATE flopik_players SET data = ?2 WHERE id = ?1").bind(p.id, JSON.stringify(d)));
    n++;
  }
  await env.DB.batch(stmts);
  await invalidatePulls(ctx, url, report);
  return json({ ok: true, patched: n, state: meta.summary.parse });
}

// ------------------------------------------------------------------- refs ----

export async function getRefs(env) {
  const rows = (await env.DB.prepare("SELECT * FROM flopik_refs").all()).results;
  const refs = {};
  for (const r of rows) {
    let data = {};
    try { data = JSON.parse(r.data || "{}"); } catch (e) { data = {}; }
    refs[r.key] = { key: r.key, bossId: r.boss_id, difficulty: r.difficulty, spec: r.spec, metric: r.metric, name: r.player, server: r.server, guild: r.guild,
                    code: r.report, fight: r.fight, dur: Number(r.dur) || 0, amount: Number(r.amount) || 0, data, fetched: r.fetched_at };
  }
  return json({ ok: true, count: rows.length, refs }, 200, { "cache-control": "public, max-age=0, s-maxage=60" });
}

export async function postRefs(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: "body must be JSON" }, 400); }
  const list = Array.isArray(body.refs) ? body.refs : [body.ref || body];
  const stmts = [];
  for (const r of list) {
    if (!r || !r.key) continue;
    stmts.push(env.DB.prepare(
      `INSERT OR REPLACE INTO flopik_refs (key, boss_id, difficulty, spec, metric, player, server, guild, report, fight, dur, amount, data, fetched_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
    ).bind(String(r.key), numOrNull(r.bossId), String(r.difficulty || ""), String(r.spec || ""), String(r.metric || "dps"), String(r.player || r.name || ""),
           String(r.server || ""), String(r.guild || ""), String(r.report || r.code || ""), numOrNull(r.fight), numOrNull(r.dur), numOrNull(r.amount),
           JSON.stringify(r.data || {}), r.fetchedAt || nowIso()));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, refs: stmts.length });
}

export async function getRefWindow(env, url) {
  const key = String(url.searchParams.get("key") || ""), end = Math.max(1, Math.round(Number(url.searchParams.get("end")) || 0));
  if (!key || !url.searchParams.get("end")) return json({ ok: false, error: "chybí key / end" }, 400);
  const ck = `${key}|${end}`;
  const hit = await env.DB.prepare("SELECT data, fetched_at FROM flopik_refwin WHERE key = ?1").bind(ck).first();
  if (hit && Date.now() - Date.parse(hit.fetched_at) < REFWIN_MAX_AGE_MS) { try { return json(JSON.parse(hit.data)); } catch (e) { /* recompute */ } }
  const gql = wclFor(env);
  if (!gql) return json({ ok: false, error: "Warcraft Logs klient není ve Workeru nastavený (secrets WCL_CLIENT_ID / WCL_CLIENT_SECRET)" }, 503);
  const ref = await env.DB.prepare("SELECT * FROM flopik_refs WHERE key = ?1").bind(key).first();
  if (!ref || !ref.report) return json({ ok: false, error: `referenční log pro ${key} není uložený` }, 404);
  try {
    const out = await referenceWindow(gql, { key: ref.key, report: ref.report, fight: ref.fight, player: ref.player, metric: ref.metric, spec: ref.spec }, end);
    await env.DB.prepare("INSERT OR REPLACE INTO flopik_refwin (key, data, fetched_at) VALUES (?1, ?2, ?3)").bind(ck, JSON.stringify(out), nowIso()).run();
    return json(out);
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e) }, 502);
  }
}

// ---------------------------------------------------------------- refresh ----

export async function refresh(request, env) {
  let body = {};
  try { body = await request.json(); } catch (e) { /* empty */ }
  const code = reportCode(body.code || "");
  if (!code) return json({ ok: false, error: "chybí code" }, 400);
  if (!env.GITHUB_TOKEN) return json({ ok: false, error: "runner není napojený (Worker secret GITHUB_TOKEN)" }, 503);
  const key = "flopik_dispatch_" + code;
  const last = await env.DB.prepare("SELECT value FROM meta WHERE key = ?1").bind(key).first();
  if (last && Date.now() - Date.parse(last.value) < DISPATCH_DEDUPE_MS) return json({ ok: true, dispatched: false, lastDispatch: last.value, message: "výpočet už běží" });
  const repo = env.GITHUB_REPO || GITHUB_REPO_DEFAULT;
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json", "user-agent": "eternal-shadows-worker" },
    body: JSON.stringify({ ref: "main", inputs: { code, reason: String(body.reason || "page").slice(0, 80) } }),
  });
  if (r.status !== 204) return json({ ok: false, error: `GitHub API HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` }, 502);
  const now = nowIso();
  await env.DB.prepare("INSERT INTO meta (key, value, updated_at) VALUES (?1, ?2, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?2").bind(key, now).run();
  return json({ ok: true, dispatched: true, lastDispatch: now, message: "výpočet spuštěn v GitHub Actions – nové pully se objeví za 1–3 minuty" });
}

export async function status(env, url) {
  const code = reportCode(url.searchParams.get("code") || "");
  if (!code) return json({ ok: false, error: "chybí code" }, 400);
  const last = await env.DB.prepare("SELECT value FROM meta WHERE key = ?1").bind("flopik_dispatch_" + code).first();
  const pull = await env.DB.prepare("SELECT MAX(written_at) AS w, COUNT(*) AS n FROM flopik_pulls WHERE report = ?1").bind(code).first();
  const lastDispatch = last ? last.value : null;
  const running = !!lastDispatch && Date.now() - Date.parse(lastDispatch) < 10 * 60000 && (!pull.w || pull.w < lastDispatch);
  return json({ ok: true, code, lastDispatch, lastPull: pull.w || null, pulls: Number(pull.n) || 0, running });
}
