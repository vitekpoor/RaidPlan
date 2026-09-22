#!/usr/bin/env node
// Meta sestavy: raider.io boss rankings → first-kill rosters of the top guilds → Worker API (D1 table rio_comps).
// The page web/comps.html aggregates them (most played spec composition per boss = "best roster" + the closest real
// kill roster = "alternative"). Runs in GitHub Actions (.github/workflows/comps.yml: weekly cron + dispatch from the
// page via POST /api/comps/refresh) or by hand.
//
//   node tools/raidplan/rio_comps.mjs                          all bosses of the raid, mythic, world, up to 100 kills each
//   node tools/raidplan/rio_comps.mjs --boss ulatek,the-coiled-altar
//   options: --raid <slug> (default the-venomous-abyss)   --difficulty mythic|heroic|normal   --region world|eu|us|…
//            --kills N (default 100)   --dry-run (print, do not POST)   --out <dir> (also write <dir>/<boss>.json)
//
// raider.io endpoints (undocumented, the same ones the site uses – see the page source of /:raid/boss-rankings/…):
//   GET /api/v1/raiding/static-data?expansion_id=11                → raids[].encounters[] {slug, name}
//   GET /api/raids/boss-rankings?raid&boss&difficulty&region&page  → bossRankings.rankedGuilds[] (100 per page, page 0-based)
//   GET /api/guilds/boss-kills?region&realm&guild&raid&difficulty&boss → killDetails.roster[] (20 characters of the FIRST kill)
// Only guilds that actually defeated the boss are taken (the ranking also lists guilds still progressing on it);
// kills whose roster raider.io does not know (no log / hidden comps) are stored without a roster and skipped by the page.
// env: ES_API_URL (default https://eternal-shadows.vitek-poor.workers.dev), ES_API_TOKEN (fallback tools/roster/sim_runner.config.json api_token).

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RIO = "https://raider.io";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) EternalShadows-comps/1.0 (+https://eternal-shadows.vitek-poor.workers.dev)";
const CONCURRENCY = 4;         // parallel boss-kills requests
const PAUSE_MS = 150;          // between requests of one lane – be nice to raider.io
const EXPANSION_ID = 11;       // Midnight

function readJson(p) { try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {}; } catch (e) { return {}; } }
const runnerCfg = readJson(path.join(HERE, "..", "roster", "sim_runner.config.json"));
const ENV = {
  api: (process.env.ES_API_URL || runnerCfg.api_url || "https://eternal-shadows.vitek-poor.workers.dev").replace(/\/+$/, ""),
  token: process.env.ES_API_TOKEN || runnerCfg.api_token || "",
};

const args = process.argv.slice(2);
const opt = { raid: "the-venomous-abyss", bosses: [], difficulty: "mythic", region: "world", kills: 100, dryRun: false, out: "" };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--raid") opt.raid = args[++i];
  else if (a === "--boss") opt.bosses.push(...String(args[++i] || "").split(",").map((s) => s.trim()).filter(Boolean));
  else if (a === "--difficulty") opt.difficulty = args[++i];
  else if (a === "--region") opt.region = args[++i];
  else if (a === "--kills") opt.kills = Math.max(1, parseInt(args[++i], 10) || 100);
  else if (a === "--dry-run") opt.dryRun = true;
  else if (a === "--out") opt.out = args[++i];
}
if (opt.bosses.length === 1 && opt.bosses[0] === "all") opt.bosses = [];

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ raider.io
async function rio(p, params) {
  const u = new URL(RIO + p);
  Object.entries(params || {}).forEach(([k, v]) => { if (v != null && v !== "") u.searchParams.set(k, v); });
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(u, { headers: { "user-agent": UA, accept: "application/json" } });
    const text = await r.text();
    let d = null; try { d = JSON.parse(text); } catch (e) { /* not json */ }
    if (r.status === 429 || r.status >= 500) {
      if (attempt >= 4) throw new Error(`raider.io ${p}: HTTP ${r.status} after ${attempt} attempts`);
      const wait = 2000 * attempt;
      log(`  raider.io HTTP ${r.status} – waiting ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    if (!r.ok) { const err = new Error(`raider.io ${p}: HTTP ${r.status} ${(d && d.message) || text.slice(0, 120)}`); err.status = r.status; err.body = d; throw err; }
    return d;
  }
}

async function encounters(raid) {
  const d = await rio("/api/v1/raiding/static-data", { expansion_id: EXPANSION_ID });
  const r = (d.raids || []).find((x) => x.slug === raid);
  if (!r) throw new Error(`raid "${raid}" not in raider.io static data (${(d.raids || []).map((x) => x.slug).join(", ")})`);
  return r.encounters.map((e, i) => ({ slug: e.slug, name: e.name, ordinal: i }));
}

async function rankings(boss, limit) {
  const out = [];
  for (let page = 0; out.length < limit; page++) {
    const d = await rio("/api/raids/boss-rankings", { raid: opt.raid, boss, difficulty: opt.difficulty, region: opt.region, page });
    const list = (d.bossRankings && d.bossRankings.rankedGuilds) || [];
    if (!list.length) break;
    // the ranking also lists guilds still progressing on the boss (encountersDefeated without it) – kills come first
    const killed = list.filter((r) => (r.encountersDefeated || []).some((e) => e.slug === boss));
    out.push(...killed);
    if (killed.length < list.length || list.length < 100) break;   // pageSize is 100 – a short page is the last one
    await sleep(PAUSE_MS);
  }
  return out.slice(0, limit);
}

function member(m) {
  const c = m.character || {};
  return {
    name: c.name || "",
    class: (c.class && c.class.slug) || "",
    spec: (c.spec && c.spec.slug) || "",
    role: (c.spec && c.spec.role) || "",       // tank | healer | dps
    melee: !!(c.spec && c.spec.is_melee),
    ilvl: c.itemLevelEquipped != null ? Math.round(c.itemLevelEquipped * 10) / 10 : null,
  };
}

async function killOf(rank, boss) {
  const g = rank.guild || {};
  const params = { region: (g.region && g.region.slug) || "", realm: (g.realm && g.realm.slug) || "", guild: g.name || "", raid: opt.raid, difficulty: opt.difficulty, boss };
  const first = ((rank.encountersDefeated || []).find((e) => e.slug === boss) || {}).firstDefeated || null;
  const base = { rank: rank.rank, guild: g.name || "", realm: (g.realm && g.realm.name) || "", realmSlug: params.realm, region: params.region, firstDefeated: first };
  let d;
  try { d = await rio("/api/guilds/boss-kills", params); }
  catch (e) { return { ...base, error: e.message.replace(/^raider\.io [^:]*: /, ""), roster: [] }; }
  const k = (d && d.killDetails) || {};
  const roster = (k.roster || []).map(member).filter((m) => m.spec);
  return {
    ...base,
    defeatedAt: (k.kill && k.kill.defeatedAt) || first,
    durationMs: (k.kill && k.kill.durationMs) || null,
    ilvlAvg: k.kill && k.kill.itemLevelEquippedAvg != null ? Math.round(k.kill.itemLevelEquippedAvg * 10) / 10 : null,
    compsHidden: !!(k.guildPrivacy && k.guildPrivacy.raidComps === false),
    roster,
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); await sleep(PAUSE_MS); }
  }));
  return out;
}

// ------------------------------------------------------------------ Worker API
async function api(method, p, body) {
  const r = await fetch(ENV.api + p, { method, headers: { "content-type": "application/json", authorization: `Bearer ${ENV.token}` }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let d; try { d = JSON.parse(text); } catch (e) { throw new Error(`API ${p}: HTTP ${r.status} ${text.slice(0, 160)}`); }
  if (!r.ok || !d.ok) throw new Error(`API ${p}: HTTP ${r.status} ${d.error || text.slice(0, 160)}`);
  return d;
}

// ------------------------------------------------------------------ main
async function main() {
  if (!opt.dryRun && !ENV.token) throw new Error("ES_API_TOKEN is not set (or use --dry-run)");
  const all = await encounters(opt.raid);
  const wanted = opt.bosses.length ? opt.bosses.map((s) => {
    const e = all.find((x) => x.slug === s || x.name.toLowerCase() === s.toLowerCase());
    if (!e) throw new Error(`boss "${s}" not in ${opt.raid}: ${all.map((x) => x.slug).join(", ")}`);
    return e;
  }) : all;
  log(`${opt.raid} ${opt.difficulty} ${opt.region}: ${wanted.map((e) => e.slug).join(", ")} (up to ${opt.kills} kills each)`);
  if (opt.out) mkdirSync(opt.out, { recursive: true });
  let failed = 0;
  for (const boss of wanted) {
    const t0 = Date.now();
    let ranks;
    try { ranks = await rankings(boss.slug, opt.kills); }
    catch (e) { log(`${boss.slug}: rankings failed – ${e.message}`); failed++; continue; }
    if (!ranks.length) { log(`${boss.slug}: no kills yet`); continue; }
    const kills = await mapLimit(ranks, CONCURRENCY, (r) => killOf(r, boss.slug));
    const withRoster = kills.filter((k) => k.roster.length), hidden = kills.filter((k) => k.compsHidden).length, errors = kills.filter((k) => k.error);
    const payload = { raid: opt.raid, difficulty: opt.difficulty, region: opt.region, boss: { slug: boss.slug, name: boss.name, ordinal: boss.ordinal },
                      fetchedAt: new Date().toISOString(), requested: opt.kills, kills };
    log(`${boss.slug}: ${ranks.length} guilds, ${withRoster.length} rosters (${hidden} hidden, ${errors.length} errors) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    errors.slice(0, 3).forEach((k) => log(`  ${k.rank}. ${k.guild} (${k.region}/${k.realm}): ${k.error}`));
    if (opt.out) writeFileSync(path.join(opt.out, `${boss.slug}.json`), JSON.stringify(payload, null, 1));
    if (opt.dryRun) { if (!opt.out) console.log(JSON.stringify({ ...payload, kills: payload.kills.slice(0, 2) }, null, 1)); continue; }
    try { const res = await api("POST", "/api/comps", payload); log(`  stored (${res.kills} kills, ${JSON.stringify(payload).length} bytes)`); }
    catch (e) { log(`  store failed – ${e.message}`); failed++; }
  }
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
