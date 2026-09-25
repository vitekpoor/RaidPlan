#!/usr/bin/env node
// Flopik runner: Warcraft Logs → engine.js → Worker API (D1). Runs in GitHub Actions (.github/workflows/flopik.yml)
// on a page request (POST /api/flopik/refresh dispatches it with the report code) and on a cron during raid evenings.
//
//   node tools/flopik/wcl_refresh.mjs --code <report>      compute the missing / outdated pulls of one report
//   node tools/flopik/wcl_refresh.mjs --live                every guild report whose last fight ended < 90 min ago (cron)
//   node tools/flopik/wcl_refresh.mjs --all                 every guild report (backfill)
//   options: --no-dmg (skip damage breakdowns + reference logs), --no-parse, --reports-only, --dry-run
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
const opt = { codes: [], live: false, all: false, dmg: true, parse: true, reportsOnly: false, dryRun: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--code") opt.codes.push(W.reportCode(args[++i]));
  else if (a === "--live") opt.live = true;
  else if (a === "--all") opt.all = true;
  else if (a === "--no-dmg") opt.dmg = false;
  else if (a === "--no-parse") opt.parse = false;
  else if (a === "--reports-only") opt.reportsOnly = true;
  else if (a === "--dry-run") opt.dryRun = true;
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
  const stored = (await api("GET", `/api/flopik/pulls?report=${code}`)).pulls || [];
  const have = {};   // fight → { ver, parse }
  for (const p of stored) have[String(p.fight)] = { ver: Number(p.ver) || 1, parse: p.meta && p.meta.summary ? p.meta.summary.parse : undefined };
  const fights = (rep.fights || []).filter((f) => (f.endTime - f.startTime) / 1000 >= MIN_DUR).sort((a, b) => a.startTime - b.startTime);
  const todo = fights.filter((f) => !have[String(f.id)] || have[String(f.id)].ver < (engine.flopikBossFor(f.encounterID, f.name).ver || 1));
  log(`▶ ${code} „${rep.title}“: ${fights.length} pullů, uloženo ${stored.length}, k výpočtu ${todo.length}`);
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
        const r = await post("/api/flopik/pulls/parse", { report: code, fight: f.id, players: rk, state });
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
