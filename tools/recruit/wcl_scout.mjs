#!/usr/bin/env node
// Nábor – scouting of players from the guilds ranked below us on the realm for web/scout.html.
//
// raider.io does the cheap discovery, Warcraft Logs only the parses (the parse percentile exists nowhere else):
//   1. realm raid ranking (raider.io /api/v1/raiding/raid-rankings, mythic – the table at
//      https://raider.io/<raid>/realm-rankings/<region>/<realm>/mythic) → our rank → guilds ranked below us up to --max-rank
//   2. per guild: the rosters of its first kills on the queried difficulty (raider.io /api/guilds/boss-kills, every boss
//      killed) = the characters that actually raid there (≈ 25–35 per guild; the server-wide WCL parse harvest used
//      before cost 900+ points and returned 2000+ characters incl. alts and ex-members)
//   3. Warcraft Logs zoneRankings per character (≈ 5 points per difficulty; 3600 points/hour): best / median performance
//      average + per-boss parses, WCL picks dps or hps by the character's role. --diff auto (default) screens only on the
//      difficulty the guild raids (mythic when it has >= 3 mythic kills, else heroic) and then fetches the other
//      difficulty just for the players that qualified; both / hc / my force it.
//      Players with best average >= --min-avg (on any queried difficulty) are kept.
//   4. raider.io (undocumented /api/characters/<region>/<realm>/<name>): About (biography), BattleTag, Discord, socials,
//      looking-for-guild profiles, item level
//   5. POST everything to the Worker (/api/scout/run, /guilds, /players) guild by guild – a finished run prunes older rows
//
// Typical run (auto): 16 guilds × ~28 characters × 5 points ≈ 2300 points, ~15 minutes; --diff both ≈ 4600 points = one
// wait for the hourly reset. The script watches rateLimitData, sleeps until the reset when it gets close to the limit
// and pauses between WCL calls (the API also rate-limits requests → 429).
//
//   node tools/recruit/wcl_scout.mjs [--min-avg 95] [--max-rank 20] [--diff auto|both|hc|my] [--dry-run] [--out dir] [--no-rio]
//                                    [--region eu --realm drakthul --raid the-venomous-abyss --zone 53 --our-guild "Eternal Shadows"]
//                                    [--guilds "Salt Mines,Other"]   (only these guilds, skips the rank filter)
//
// env: WCL_CLIENT_ID, WCL_CLIENT_SECRET (fallback tools/flopik/flopik.config.json wcl_client_id / wcl_client_secret),
//      ES_API_URL (default https://eternal-shadows.vitek-poor.workers.dev), ES_API_TOKEN (fallback tools/roster/sim_runner.config.json api_token).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch (e) { return {}; } };
const flopikCfg = readJson(path.join(ROOT, "tools", "flopik", "flopik.config.json"));
const runnerCfg = readJson(path.join(ROOT, "tools", "roster", "sim_runner.config.json"));

const OPT = {
  minAvg: 95, maxRank: 20, diff: "auto", dryRun: false, out: "", rio: true, reason: "",
  region: "eu", realm: "drakthul", raid: "the-venomous-abyss", expansion: 11, zone: 53, ourGuild: "Eternal Shadows", guilds: "",
  maxPoints: 3300,          // sleep until the reset when pointsSpentThisHour passes this
  pause: 400,               // ms between WCL calls (the API also rate-limits requests, not only points)
  wclId: process.env.WCL_CLIENT_ID || flopikCfg.wcl_client_id || "",
  wclSecret: process.env.WCL_CLIENT_SECRET || flopikCfg.wcl_client_secret || "",
  api: (process.env.ES_API_URL || "https://eternal-shadows.vitek-poor.workers.dev").replace(/\/+$/, ""),
  token: process.env.ES_API_TOKEN || runnerCfg.api_token || "",
};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], v = process.argv[i + 1];
  if (a === "--min-avg") { OPT.minAvg = Number(v); i++; }
  else if (a === "--max-rank") { OPT.maxRank = Number(v); i++; }
  else if (a === "--diff") { OPT.diff = ["auto", "both", "hc", "my"].includes(v) ? v : "auto"; i++; }
  else if (a === "--dry-run") OPT.dryRun = true;
  else if (a === "--out") { OPT.out = v; i++; }
  else if (a === "--no-rio") OPT.rio = false;
  else if (a === "--reason") { OPT.reason = v || ""; i++; }
  else if (a === "--region") { OPT.region = v; i++; }
  else if (a === "--realm") { OPT.realm = v; i++; }
  else if (a === "--raid") { OPT.raid = v; i++; }
  else if (a === "--expansion") { OPT.expansion = Number(v); i++; }
  else if (a === "--zone") { OPT.zone = Number(v); i++; }
  else if (a === "--our-guild") { OPT.ourGuild = v; i++; }
  else if (a === "--guilds") { OPT.guilds = v || ""; i++; }
  else if (a === "--max-points") { OPT.maxPoints = Number(v); i++; }
  else if (a === "--pause") { OPT.pause = Number(v) || 0; i++; }
  else { console.error("unknown argument " + a); process.exit(2); }
}

const DIFF = { hc: 4, my: 5 };                       // WCL difficulty ids
const RIO_DIFF = { hc: "heroic", my: "mythic" };     // raider.io difficulty slugs
const AUTO_MYTHIC_KILLS = 3;                         // --diff auto: mythic once the guild has this many mythic kills
const UA = "eternal-shadows scout (+https://eternal-shadows.vitek-poor.workers.dev)";

const LOG = [];
function log(...a) { const s = a.join(" "); LOG.push(s); console.log(s); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nkey = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const round = (v) => (v == null ? null : Math.round(Number(v) * 10) / 10);

// -------------------------------------------------------------------------------------------------- raider.io ----
async function rio(p, params) {
  const url = "https://raider.io" + p + "?" + new URLSearchParams(params).toString();
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
    if (r.status === 429 || r.status >= 500) { await sleep(2000 * attempt); continue; }
    const t = await r.text();
    let d; try { d = JSON.parse(t); } catch (e) { d = null; }
    if (!r.ok) { const err = new Error(`raider.io ${p} HTTP ${r.status}: ${(d && d.message) || t.slice(0, 120)}`); err.status = r.status; throw err; }
    return d;
  }
  throw new Error(`raider.io ${p}: too many retries`);
}

/** raid encounters of the raid (slug + name) */
async function raidEncounters() {
  const d = await rio("/api/v1/raiding/static-data", { expansion_id: OPT.expansion });
  const raid = (d.raids || []).find((r) => r.slug === OPT.raid);
  if (!raid) throw new Error(`raider.io static-data: raid ${OPT.raid} not found (${(d.raids || []).map((r) => r.slug).join(", ")})`);
  return { name: raid.name, encounters: (raid.encounters || []).map((e) => ({ slug: e.slug, name: e.name })) };
}

/** realm ranking of the raid (mythic = the table on raider.io/<raid>/realm-rankings/…/mythic): [{ rank, guild, kills: {hc, my} }] */
async function realmRanking() {
  const byName = new Map();
  for (const diff of ["my", "hc"]) {
    for (let page = 0; page < 5; page++) {
      const d = await rio("/api/v1/raiding/raid-rankings", { raid: OPT.raid, difficulty: RIO_DIFF[diff], region: OPT.region, realm: OPT.realm, limit: 100, page });
      const rows = d.raidRankings || [];
      for (const r of rows) {
        const g = r.guild || {}, k = nkey(g.name) + "|" + ((g.realm && g.realm.slug) || "");
        const e = byName.get(k) || { rioId: g.id, name: g.name, faction: g.faction || "", realmSlug: (g.realm && g.realm.slug) || OPT.realm, realmName: (g.realm && g.realm.name) || "", path: g.path || "", rank: null, regionRank: null, kills: { hc: [], my: [] } };
        e.kills[diff] = (r.encountersDefeated || []).map((x) => x.slug);
        if (diff === "my") { e.rank = r.rank; e.regionRank = r.regionRank; }
        byName.set(k, e);
      }
      if (rows.length < 100) break;
      await sleep(200);
    }
  }
  return [...byName.values()];
}

/** characters of the guild's first kills on the queried difficulties (= its current raiders; the heroic+mythic union of a
 *  whole season is twice as many, mostly ex-members) → Map key → { name, realm, class, spec, role, ilvl, kills } */
async function guildRoster(g, encs, diffs) {
  const jobs = [];
  const want = diffs.filter((d) => g.kills[d].length).length ? diffs : ["hc", "my"];     // a guild without kills on the queried difficulty → any kill
  for (const diff of want) for (const slug of g.kills[diff]) if (encs.some((e) => e.slug === slug)) jobs.push({ diff, slug });
  const roster = new Map();
  let hidden = 0, errors = 0;
  const run = async (j) => {
    let d;
    try { d = await rio("/api/guilds/boss-kills", { region: OPT.region, realm: g.realmSlug, guild: g.name, raid: OPT.raid, difficulty: RIO_DIFF[j.diff], boss: j.slug }); }
    catch (e) { if (e.status !== 400) errors++; return; }
    const k = d.killDetails || {};
    if (k.guildPrivacy && k.guildPrivacy.raidComps === false) hidden++;
    for (const m of k.roster || []) {
      const c = m.character || {}; if (!c.name) continue;
      const realm = (c.realm && c.realm.slug) || g.realmSlug, key = nkey(c.name) + "-" + realm;
      const e = roster.get(key) || { name: c.name, realm, class: (c.class && c.class.name) || "", spec: "", role: "", specs: {}, ilvl: null, kills: { hc: 0, my: 0 } };
      const sp = c.spec || {};
      if (sp.name) { e.specs[sp.name] = (e.specs[sp.name] || 0) + 1; if (!e.role) e.role = sp.role || ""; }
      if (c.itemLevelEquipped != null) e.ilvl = Math.max(e.ilvl || 0, Number(c.itemLevelEquipped));
      e.kills[j.diff]++;
      roster.set(key, e);
    }
  };
  // 4 parallel lanes like rio_comps.mjs (≈ 0.1 s per call, no rate limit seen)
  let i = 0;
  await Promise.all([0, 1, 2, 3].map(async () => { while (i < jobs.length) { const j = jobs[i++]; await run(j); await sleep(150); } }));
  for (const e of roster.values()) e.spec = Object.entries(e.specs).sort((a, b) => b[1] - a[1]).map((x) => x[0])[0] || "";
  return { roster, hidden, errors, calls: jobs.length };
}

async function rioProfile(name, realm) {
  const url = `https://raider.io/api/characters/${OPT.region}/${realm}/${encodeURIComponent(name)}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
    if (r.status === 404) return null;
    if (r.status === 429 || r.status >= 500) { await sleep(3000 * attempt); continue; }
    if (!r.ok) return null;
    const d = await r.json();
    const cd = d.characterDetails || {}, ch = cd.character || {}, cu = cd.characterCustomizations || {};
    const spec = ch.spec && ch.spec.name;
    return {
      ilvl: ch.itemLevelEquipped != null ? Number(ch.itemLevelEquipped) : null, spec: spec || "", thumb: ch.thumbnailUrl || "",
      bio: String(cu.biography || "").trim(), battletag: String(cu.bnet_battletag || "").trim(), discord: String(cu.discord_profile || "").trim(),
      socials: Object.fromEntries(["twitch", "twitter", "youtube", "wowhead"].map((k) => [k, String(cu[k + "_profile"] || "").trim()]).filter(([, v]) => v)),
      recruitment: Array.isArray(ch.recruitmentProfiles) ? ch.recruitmentProfiles : [],
      guild: ch.guild ? { name: ch.guild.name, realm: ch.guild.realm } : null,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------- Warcraft Logs ----
let wclToken = "";
let points = { spent: 0, limit: 3600, resetIn: 3600 };
async function wclAuth() {
  if (!OPT.wclId || !OPT.wclSecret) throw new Error("missing WCL_CLIENT_ID / WCL_CLIENT_SECRET");
  const r = await fetch("https://www.warcraftlogs.com/oauth/token", {
    method: "POST", headers: { authorization: "Basic " + Buffer.from(OPT.wclId + ":" + OPT.wclSecret).toString("base64"), "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(`WCL oauth HTTP ${r.status}`);
  wclToken = (await r.json()).access_token;
}
/** GraphQL query; every call also reads rateLimitData and sleeps through the hourly reset when the budget is nearly spent */
async function gql(query, variables = {}) {
  if (points.spent > OPT.maxPoints) {
    const wait = Math.max(30, points.resetIn + 10);
    log(`  … WCL points ${points.spent.toFixed(0)}/${points.limit} – waiting ${wait}s for the hourly reset`);
    await sleep(wait * 1000);
    points.spent = 0;
  }
  const q = query.replace(/\}\s*$/, " rateLimitData { limitPerHour pointsSpentThisHour pointsResetIn } }");
  for (let attempt = 1; attempt <= 6; attempt++) {
    if (OPT.pause) await sleep(OPT.pause);
    const r = await fetch("https://www.warcraftlogs.com/api/v2/client", {
      method: "POST", headers: { authorization: "Bearer " + wclToken, "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify({ query: q, variables }),
    });
    if (r.status === 429 || r.status >= 500) { const w = 15 * attempt; log(`  WCL HTTP ${r.status} – retry in ${w}s`); await sleep(w * 1000); continue; }
    if (r.status === 401 && attempt === 1) { await wclAuth(); continue; }
    if (!r.ok) throw new Error(`WCL HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    const rl = d.data && d.data.rateLimitData;
    if (rl) points = { spent: rl.pointsSpentThisHour, limit: rl.limitPerHour, resetIn: rl.pointsResetIn };
    if (d.errors && !d.data) throw new Error("WCL: " + d.errors.map((e) => e.message).join("; ").slice(0, 300));
    return d.data;
  }
  throw new Error("WCL: too many retries");
}

/** WCL guild id + world/server progress rank for the raider.io guilds (by name on the guild's realm; cheap, batched) */
async function wclGuilds(guilds) {
  const out = {};
  for (let i = 0; i < guilds.length; i += 20) {
    const chunk = guilds.slice(i, i + 20);
    const q = "{ guildData { " + chunk.map((g, k) => `g${k}: guild(name: ${JSON.stringify(g.name)}, serverSlug: ${JSON.stringify(g.realmSlug)}, serverRegion: ${JSON.stringify(OPT.region)}) { id zoneRanking(zoneId: ${OPT.zone}) { progress { serverRank { number } worldRank { number } } } }`).join(" ") + " } }";
    let d;
    try { d = await gql(q); } catch (e) { log(`  WARN WCL guild lookup: ${e.message}`); continue; }
    chunk.forEach((g, k) => {
      const w = d.guildData && d.guildData[`g${k}`]; if (!w || !w.id) return;
      const p = (w.zoneRanking && w.zoneRanking.progress) || {};
      out[nkey(g.name) + "|" + g.realmSlug] = { id: w.id, serverRank: p.serverRank ? p.serverRank.number : null, worldRank: p.worldRank ? p.worldRank.number : null };
    });
  }
  return out;
}

function perBoss(z) {
  return ((z && z.rankings) || []).filter((r) => r.rankPercent != null).map((r) => ({
    id: r.encounter.id, boss: r.encounter.name, best: round(r.rankPercent), median: round(r.medianPercent), kills: r.totalKills || 0, spec: r.spec || "",
  }));
}

/** zoneRankings of the wanted difficulties for a batch of characters (5 per query ≈ 25 points per difficulty) → [{ c, hc, my, hidden }] */
async function parses(chars, diffs) {
  const out = [];
  for (let i = 0; i < chars.length; i += 5) {
    const chunk = chars.slice(i, i + 5);
    const q = "{ characterData { " + chunk.map((c, k) => `c${k}: character(name: ${JSON.stringify(c.name)}, serverSlug: ${JSON.stringify(c.realm)}, serverRegion: ${JSON.stringify(OPT.region)}) { id name hidden server { slug } ${diffs.map((d) => `${d}: zoneRankings(zoneID: ${OPT.zone}, difficulty: ${DIFF[d]})`).join(" ")} }`).join(" ") + " } }";
    let d;
    try { d = await gql(q); } catch (e) { log(`  WARN parses ${chunk.map((c) => c.name).join(", ")}: ${e.message}`); continue; }
    chunk.forEach((c, k) => {
      const ch = d.characterData && d.characterData[`c${k}`];
      if (!ch) return;
      out.push({ c, realm: (ch.server && ch.server.slug) || c.realm, hidden: !!ch.hidden, hc: ch.hc || null, my: ch.my || null });
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- Worker API ----
async function post(p, body) {
  if (OPT.dryRun) return { ok: true, dry: true };
  if (!OPT.token) throw new Error("missing ES_API_TOKEN (or api_token in tools/roster/sim_runner.config.json)");
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch(OPT.api + p, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${OPT.token}`, "user-agent": UA }, body: JSON.stringify(body) });
    const t = await r.text();
    if (r.ok) return JSON.parse(t);
    if (attempt === 3) throw new Error(`${p} HTTP ${r.status}: ${t.slice(0, 200)}`);
    await sleep(2000 * attempt);
  }
}

// ---------------------------------------------------------------------------------------------------- main ----
const runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 6);
/** which WCL difficulties to query for a guild */
function diffsFor(g) {
  if (OPT.diff === "both") return ["hc", "my"];
  if (OPT.diff === "hc" || OPT.diff === "my") return [OPT.diff];
  return g.kills.my.length >= AUTO_MYTHIC_KILLS ? ["my"] : ["hc"];
}

async function main() {
  const startedAt = new Date().toISOString();
  log(`scout run ${runId} – min avg ${OPT.minAvg}, max rank ${OPT.maxRank}, diff ${OPT.diff}, realm ${OPT.realm} (${OPT.region}), raid ${OPT.raid} / WCL zone ${OPT.zone}${OPT.dryRun ? ", DRY RUN" : ""}`);
  const raid = await raidEncounters();
  const ranking = await realmRanking();
  const us = ranking.find((g) => nkey(g.name) === nkey(OPT.ourGuild));
  const ourRank = us ? us.rank : null;
  if (!us) log(`WARN our guild "${OPT.ourGuild}" is not in the mythic realm ranking – scouting every guild up to rank ${OPT.maxRank}`);
  log(`${raid.name}: ${raid.encounters.length} bosses; realm ranking: ${ranking.filter((g) => g.rank).length} guilds with mythic kills; ${OPT.ourGuild}: realm rank ${ourRank ?? "?"} (${us ? us.kills.my.length : "?"}/${raid.encounters.length} M, ${us ? us.kills.hc.length : "?"}/${raid.encounters.length} HC)`);
  await post("/api/scout/run", { runId, phase: "start", startedAt, ourRank, ourGuild: OPT.ourGuild, minAvg: OPT.minAvg, maxRank: OPT.maxRank, diff: OPT.diff, reason: OPT.reason, zone: raid.name });

  const only = OPT.guilds ? new Set(OPT.guilds.split(",").map((s) => nkey(s)).filter(Boolean)) : null;
  const keep = ranking.filter((g) => only ? only.has(nkey(g.name)) : g.rank != null && nkey(g.name) !== nkey(OPT.ourGuild) && (ourRank == null || g.rank > ourRank) && g.rank <= OPT.maxRank)
    .sort((a, b) => (a.rank || 999) - (b.rank || 999) || a.name.localeCompare(b.name));
  if (only) { const missing = [...only].filter((n) => !keep.some((g) => nkey(g.name) === n)); if (missing.length) log(`WARN not in the realm ranking: ${missing.join(", ")}`); }
  log(`guilds to scout (${keep.length}): ` + keep.map((g) => `#${g.rank} ${g.name} (${g.kills.my.length}M/${g.kills.hc.length}HC, ${diffsFor(g).join("+")})`).join(", "));

  await wclAuth();
  const wg = await wclGuilds(keep);
  const guildRows = keep.map((g) => {
    const w = wg[nkey(g.name) + "|" + g.realmSlug] || {};
    g.id = w.id || g.rioId;                                   // WCL guild id (the page keys by it); raider.io id when WCL does not know the guild
    return { id: g.id, name: g.name, faction: g.faction, serverRank: g.rank, worldRank: w.worldRank ?? null, candidates: 0, players: 0 };
  });
  await post("/api/scout/guilds", { runId, guilds: guildRows });

  const all = [];
  let done = 0, candidates = 0;
  for (const g of keep) {
    const row = guildRows[done];
    const diffs = diffsFor(g);
    const pts0 = points.spent;
    const { roster, hidden, errors, calls } = await guildRoster(g, raid.encounters, diffs);
    const chars = [...roster.values()];
    row.candidates = chars.length; candidates += chars.length;
    log(`\n#${g.rank} ${g.name} (${g.realmName || g.realmSlug}): ${chars.length} raiders from ${calls} first-kill rosters${hidden ? `, ${hidden} hidden comps` : ""}${errors ? `, ${errors} errors` : ""} → WCL ${diffs.join("+")}`);
    const rows = chars.length ? await parses(chars, diffs) : [];
    const passes = (r) => !r.hidden && ["hc", "my"].some((d) => r[d] && r[d].bestPerformanceAverage != null && r[d].bestPerformanceAverage >= OPT.minAvg);
    // auto: the few players who qualify on the screened difficulty also get the other one (≈ 5 points each), so both
    // columns are filled without querying both difficulties for every raider
    const other = OPT.diff === "auto" ? (diffs[0] === "my" ? "hc" : "my") : null;
    const hit = other ? rows.filter(passes) : [];
    if (hit.length) {
      const extra = await parses(hit.map((r) => r.c), [other]);
      for (const x of extra) { const r = hit.find((h) => h.c === x.c); if (r) r[other] = x[other]; }
    }
    const found = [];
    for (const r of rows) {
      if (!passes(r)) continue;
      const hcBest = r.hc && r.hc.bestPerformanceAverage, myBest = r.my && r.my.bestPerformanceAverage;
      const hcB = perBoss(r.hc), myB = perBoss(r.my);
      const specCount = {};
      [...hcB, ...myB].forEach((b) => { if (b.spec) specCount[b.spec] = (specCount[b.spec] || 0) + b.kills + 1; });
      Object.entries(r.c.specs).forEach(([s, n]) => { specCount[s] = (specCount[s] || 0) + n; });
      const spec = Object.entries(specCount).sort((a, b) => b[1] - a[1]).map((x) => x[0])[0] || r.c.spec || "";
      const p = {
        key: nkey(r.c.name) + "-" + r.realm, name: r.c.name, realm: r.realm, class: r.c.class, spec, role: r.c.role || "dps",
        guildId: g.id, guildName: g.name, ilvl: r.c.ilvl,
        hcBest: round(hcBest), hcMedian: round(r.hc && r.hc.medianPerformanceAverage), hcKills: hcB.reduce((s, b) => s + b.kills, 0),
        myBest: round(myBest), myMedian: round(r.my && r.my.medianPerformanceAverage), myKills: myB.reduce((s, b) => s + b.kills, 0),
        wclUrl: `https://www.warcraftlogs.com/character/${OPT.region}/${r.realm}/${encodeURIComponent(r.c.name)}`,
        rioUrl: `https://raider.io/characters/${OPT.region}/${r.realm}/${encodeURIComponent(r.c.name)}`,
        bio: "", battletag: "", discord: "", socials: {}, recruitment: [], data: { hc: hcB, my: myB, diffs: other ? [...diffs, other] : diffs, firstKills: r.c.kills },
      };
      if (OPT.rio) {
        try {
          const prof = await rioProfile(r.c.name, r.realm);
          if (prof) {
            if (prof.ilvl != null) p.ilvl = prof.ilvl;
            p.bio = prof.bio; p.battletag = prof.battletag; p.discord = prof.discord; p.socials = prof.socials; p.recruitment = prof.recruitment;
            p.data.thumb = prof.thumb; p.data.rioGuild = prof.guild; if (!p.spec && prof.spec) p.spec = prof.spec;
          } else p.data.rio = "not found";
        } catch (e) { p.data.rio = "error: " + String(e.message).slice(0, 100); }
        await sleep(150);
      }
      found.push(p);
    }
    row.players = found.length;
    all.push(...found);
    done++;
    log(`  → ${found.length} players with ${OPT.minAvg}+: ` + found.map((p) => `${p.name} (${p.spec} ${p.hcBest ?? "-"}/${p.myBest ?? "-"}${p.battletag || p.discord ? " ✉" : ""})`).join(", ") + ` [${Math.round(points.spent - pts0)} pts, ${Math.round(points.spent)} this hour]`);
    if (found.length) await post("/api/scout/players", { runId, players: found });
    await post("/api/scout/guilds", { runId, guilds: [row] });
    await post("/api/scout/run", { runId, phase: "progress", done, of: keep.length, players: all.length, candidates, points: Math.round(points.spent) });
  }

  log(`\ndone: ${all.length} players from ${keep.length} guilds (${candidates} raiders checked), ${Math.round(points.spent)} WCL points this hour`);
  if (OPT.dryRun) {
    const dir = OPT.out || path.join(HERE, "out");
    mkdirSync(dir, { recursive: true });
    const f = path.join(dir, "scout.json");
    writeFileSync(f, JSON.stringify({ runId, startedAt, ourRank, guilds: guildRows, players: all }, null, 1));
    log("dry run – written to " + f);
    return;
  }
  await post("/api/scout/run", { runId, phase: "finish", done, of: keep.length, players: all.length, candidates, guilds: keep.length, points: Math.round(points.spent), prune: true, log: LOG.slice(-80).join("\n") });
}

main().catch(async (e) => {
  console.error("FAILED:", e && e.stack || e);
  try { await post("/api/scout/run", { runId, phase: "error", error: String(e && e.message || e).slice(0, 300), log: LOG.slice(-40).join("\n") }); } catch (e2) { /* ignore */ }
  process.exit(1);
});
