#!/usr/bin/env node
// Flopik runner: Warcraft Logs → engine.js → Worker API (D1). Runs in GitHub Actions (.github/workflows/flopik.yml)
// on a page request (POST /api/flopik/refresh dispatches it with the report code) and on a cron during raid evenings.
//
//   node tools/flopik/wcl_refresh.mjs --code <report>      compute the missing / outdated pulls of one report
//   node tools/flopik/wcl_refresh.mjs --live                every guild report whose last fight ended < 90 min ago (cron)
//   node tools/flopik/wcl_refresh.mjs --all                 every guild report (backfill)
//   options: --no-dmg (skip damage breakdowns + reference logs), --no-parse, --reports-only, --dry-run,
//            --force (recompute every fight of the report even when it is stored – e.g. to merge a night uploaded twice),
//            --fights 12,13 (with --code: only these WCL fight ids, always recomputed)
//
// env: WCL_CLIENT_ID, WCL_CLIENT_SECRET (fallback tools/flopik/flopik.config.json wcl_client_id / wcl_client_secret),
//      ES_API_URL (default https://eternal-shadows.vitek-poor.workers.dev), ES_API_TOKEN (fallback tools/roster/sim_runner.config.json api_token).
// engine.js stays a plain ES5 script (shared with the browser harness) – it is loaded with `new Function`.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as W from "./wcl_lib.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIN_DUR = 30;              // s – shorter pulls are not recorded
const LIVE_MS = 90 * 60000;      // --live: reports whose last fight ended less than this ago
const REF_MAX_AGE_MS = 7 * 86400000, REF_ERR_AGE_MS = 86400000;
const PARSE_RETRY_MS = 2 * 86400000;
const WCL_RETRIES = 6;           // 429/5xx backoff: 10 s, 20 s, 40 s, 80 s, 120 s, 120 s (≈ 6.5 min max, job timeout is 30 min)

const engine = new Function(readFileSync(path.join(HERE, "engine.js"), "utf8") + "\nreturn { flopikAnalyze, flopikBossFor, flopikFilterFor, FLOPIK_BOSSES };")();

function readJson(p) { try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {}; } catch (e) { return {}; } }
const flopikCfg = readJson(path.join(HERE, "flopik.config.json"));
const runnerCfg = readJson(path.join(HERE, "..", "roster", "sim_runner.config.json"));
const ENV = {
  wclId: process.env.WCL_CLIENT_ID || flopikCfg.wcl_client_id || "",
  wclSecret: process.env.WCL_CLIENT_SECRET || flopikCfg.wcl_client_secret || "",
  api: (process.env.ES_API_URL || runnerCfg.api_url || "https://eternal-shadows.vitek-poor.workers.dev").replace(/\/+$/, ""),
  token: process.env.ES_API_TOKEN || runnerCfg.api_token || "",
};

const args = process.argv.slice(2);
const opt = { codes: [], live: false, all: false, dmg: true, parse: true, reportsOnly: false, dryRun: false, force: false, fights: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--code") opt.codes.push(W.reportCode(args[++i]));
  else if (a === "--live") opt.live = true;
  else if (a === "--all") opt.all = true;
  else if (a === "--no-dmg") opt.dmg = false;
  else if (a === "--no-parse") opt.parse = false;
  else if (a === "--reports-only") opt.reportsOnly = true;
  else if (a === "--dry-run") opt.dryRun = true;
  else if (a === "--force") opt.force = true;
  else if (a === "--fights") opt.fights = String(args[++i] || "").split(/[\s,]+/).filter(Boolean).map(Number);
  else if (W.reportCode(a)) opt.codes.push(W.reportCode(a));
}

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

// ------------------------------------------------------------------ Worker API
async function api(method, p, body) {
  const r = await fetch(ENV.api + p, { method, headers: { "content-type": "application/json", authorization: `Bearer ${ENV.token}` }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let d; try { d = JSON.parse(text); } catch (e) { throw new Error(`API ${p}: HTTP ${r.status} ${text.slice(0, 160)}`); }
  if (!r.ok || !d.ok) throw new Error(`API ${p}: HTTP ${r.status} ${d.error || text.slice(0, 160)}`);
  return d;
}
const post = (p, body) => (opt.dryRun ? Promise.resolve({ ok: true, dryRun: true }) : api("POST", p, body));

// ------------------------------------------------------------------- helpers
const tzFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
function prague(ms) { const s = tzFmt.format(new Date(ms)); return { date: s.slice(0, 10), time: s.slice(11, 19) }; }   // "2026-09-21 18:51:07"

const SAME_PULL_MS = 15000;      // the same pull in two uploads of one night: start times differ by ~1 s (Worker uses the same tolerance)
function secOf(t) { const m = /^(\d{1,2}):(\d{2}):(\d{2})/.exec(String(t || "")); return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null; }
/** Stored pull p = WCL fight f (same boss, start within SAME_PULL_MS)? `when` = Prague date/time of the fight start. */
function samePull(p, f, startMs, when) {
  const sameBoss = (p.bossId != null && Number(p.bossId) === Number(f.encounterID)) || String(p.boss) === String(f.name);
  if (!sameBoss || String(p.date) !== when.date) return false;
  if (p.startMs != null) return Math.abs(Number(p.startMs) - startMs) <= SAME_PULL_MS;
  const a = secOf(p.start), b = secOf(when.time);
  return a != null && b != null && Math.abs(a - b) * 1000 <= SAME_PULL_MS;
}

const REFS = { loaded: false, map: {} };
async function ensureRef(gql, encId, difficulty, spec) {
  if (!REFS.loaded) { REFS.map = (await api("GET", "/api/flopik/refs")).refs || {}; REFS.loaded = true; }
  const key = W.refKey(encId, difficulty, spec), cur = REFS.map[key];
  if (cur) {
    const age = Date.now() - Date.parse(cur.fetched || 0), isErr = !!(cur.data && cur.data.error);
    if (age < (isErr ? REF_ERR_AGE_MS : REF_MAX_AGE_MS)) return "fresh";
  }
  const ref = await W.referenceLog(gql, encId, difficulty, spec);
  ref.fetchedAt = new Date().toISOString();
  await post("/api/flopik/refs", { ref });
  REFS.map[key] = { ...ref, fetched: ref.fetchedAt };
  log(`   ref ${key}: ${ref.player ? `${ref.player} (${ref.guild}) ${ref.amount}` : "chyba – " + (ref.data && ref.data.error)}`);
  return ref.player ? "ok" : "error";
}

async function refreshReport(gql, code) {
  const rep = await W.reportInfo(gql, code);
  if (!rep) throw new Error(`report ${code} nenalezen`);
  if (!rep.guild || rep.guild.id !== W.GUILD.id) throw new Error(`report ${code} nepatří guildě ${W.GUILD.name}`);
  // stored = every pull inside the report's time window, also rows computed from a second upload of the same night
  // (its fight ids differ) – a fight is "stored" when a row of the same boss starts within SAME_PULL_MS of it
  const stored = (await api("GET", `/api/flopik/pulls?report=${code}`)).pulls || [];
  const fights = (rep.fights || []).filter((f) => (f.endTime - f.startTime) / 1000 >= MIN_DUR).sort((a, b) => a.startTime - b.startTime);
  const have = {};   // fight id → { ver, parse, row }
  for (const f of fights) {
    const startMs = rep.startTime + f.startTime, when = prague(startMs);
    const row = stored.find((p) => (p.report === code && String(p.fight) === String(f.id)) || samePull(p, f, startMs, when));
    if (row) have[String(f.id)] = { ver: Number(row.ver) || 1, parse: row.meta && row.meta.summary ? row.meta.summary.parse : undefined, row };
  }
  const todo = fights.filter((f) => opt.fights.length ? opt.fights.includes(f.id) : (opt.force || !have[String(f.id)] || have[String(f.id)].ver < (engine.flopikBossFor(f.encounterID, f.name).ver || 1)));
  log(`▶ ${code} „${rep.title}“: ${fights.length} pullů, uloženo ${Object.keys(have).length}${stored.length !== Object.keys(have).length ? ` (v okně reportu ${stored.length})` : ""}, k výpočtu ${todo.length}${opt.force ? " (force)" : ""}${opt.fights.length ? " (fights " + opt.fights.join(",") + ")" : ""}`);
  let added = 0, parsed = 0;
  for (const f of todo) {
    const boss = engine.flopikBossFor(f.encounterID, f.name);
    const events = await W.fightEvents(gql, code, f.id, engine.flopikFilterFor(boss));
    const res = engine.flopikAnalyze(f, events, rep.masterData.actors, rep.startTime);
    const when = prague(res.startMs);
    res.date = when.date; res.start = when.time; res.report = code; res.fight = f.id;
    if (opt.dmg) {
      try {
        const specs = await W.attachDamage(gql, code, f, res);
        for (const spec of Object.keys(specs)) await ensureRef(gql, specs[spec], res.difficulty || W.DIFFICULTY[f.difficulty] || "Mythic", spec);
      } catch (e) { log(`   ⚠ dmg breakdown ${f.id}: ${e.message}`); }
    }
    if (opt.parse && f.kill) {
      try {
        const rk = await W.rankings(gql, code, f.id);
        let n = 0;
        (res.players || []).forEach((p) => { if (rk[p.name]) { p.parse = rk[p.name]; n++; } });
        res.summary = res.summary || {}; res.summary.parse = n ? "ok" : "pending";
      } catch (e) { res.summary = res.summary || {}; res.summary.parse = "pending"; res.summary.parseError = String(e.message); }
    }
    const r = await post("/api/flopik/pulls", { pull: res });
    added++;
    log(`   ✅ ${res.date} ${res.start} ${res.boss} ${res.kill ? "KILL" : "wipe"} ${Math.round(res.dur)} s → pull ${r.pull || "?"} (${(res.players || []).length} hráčů, ${events.length} událostí)`);
  }
  if (opt.parse) {
    for (const f of fights) {
      const h = have[String(f.id)];
      if (!f.kill || !h || todo.includes(f)) continue;
      if (h.parse === "ok" || h.parse === "none") continue;
      try {
        const rk = await W.rankings(gql, code, f.id);
        const state = Object.keys(rk).length ? "ok" : (Date.now() - (rep.startTime + f.endTime) > PARSE_RETRY_MS ? "none" : "pending");
        // the stored row may come from the other upload of the night – patch by its own report + fight
        const r = await post("/api/flopik/pulls/parse", { report: h.row.report || code, fight: h.row.report ? h.row.fight : f.id, players: rk, state });
        parsed += r.patched || 0;
        log(`   parse fight ${f.id}: ${state} (${r.patched || 0} hráčů)`);
      } catch (e) { log(`   ⚠ parse fight ${f.id}: ${e.message}`); }
    }
  }
  return { fights: fights.length, added, parsed };
}

async function main() {
  if (!ENV.token && !opt.dryRun) throw new Error("chybí ES_API_TOKEN (nebo api_token v tools/roster/sim_runner.config.json)");
  const gql = W.makeWcl(ENV.wclId, ENV.wclSecret, null, { retries: WCL_RETRIES, log });   // 429 = shared runner IP is rate-limited – wait it out
  const reports = await W.guildReports(gql);
  await post("/api/flopik/reports", { reports });
  log(`Warcraft Logs: ${reports.length} reportů guildy → uloženo`);
  if (opt.reportsOnly) return;
  let codes = opt.codes.filter(Boolean);
  if (opt.all) codes = reports.map((r) => r.code);
  else if (opt.live) codes = reports.filter((r) => Date.now() - (r.end || r.start) < LIVE_MS).map((r) => r.code);
  if (!codes.length) { log(opt.live ? "Žádný živý report – nic k výpočtu." : "Zadej --code <report>, --live nebo --all."); return; }
  const totals = { fights: 0, added: 0, parsed: 0 }, failed = [];
  for (const code of codes) {
    try {
      const r = await refreshReport(gql, code);
      totals.fights += r.fights; totals.added += r.added; totals.parsed += r.parsed;
    } catch (e) { failed.push(`${code}: ${e.message}`); log(`⚠ ${code}: ${e.message}`); }
  }
  log(`Hotovo: ${codes.length} reportů, ${totals.fights} pullů, nově ${totals.added}, parse doplněn ${totals.parsed}` + (failed.length ? `; selhalo ${failed.length}` : ""));
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error("CHYBA:", e.message); process.exit(1); });
