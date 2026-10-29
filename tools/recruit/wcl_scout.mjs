#!/usr/bin/env node
// Nábor – scouting of players from the guilds ranked below us on the server (Warcraft Logs) for web/scout.html.
//
// What it does (all through the WCL v2 API – the warcraftlogs.com pages sit behind a human challenge):
//   1. our guild's progress rank on the server (guild zoneRanking) → we look at guilds ranked below it, up to --max-rank
//   2. candidate characters = everyone in the server's top-100 parse rankings of every boss, per class (dps metric; hps
//      for the healing classes), heroic + mythic – 95+ average players are always in there; the entries carry the guild
//   3. guilds of the candidates → progress rank on the server → keep "below us … max rank"
//   4. per candidate of a kept guild: zoneRankings heroic + mythic (best / median performance average, per-boss parses;
//      WCL picks dps or hps by the character's role) → keep players with best average >= --min-avg on either difficulty
//   5. raider.io (undocumented /api/characters/<region>/<realm>/<name>): About (biography), BattleTag, Discord, socials,
//      looking-for-guild profiles, item level
//   6. POST everything to the Worker (/api/scout/run, /guilds, /players) guild by guild – a finished run prunes older rows
//
// WCL API budget: 3600 points/hour. Candidate harvest ≈ 800 points, each character ≈ 10 points (two difficulties);
// the script watches rateLimitData and sleeps until the hourly reset when it gets close to the limit.
//
//   node tools/recruit/wcl_scout.mjs [--min-avg 95] [--max-rank 20] [--dry-run] [--out dir] [--no-rio]
//                                    [--server-id 286 --server-slug drakthul --region eu --zone 53 --our-guild 91339]
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
  minAvg: 95, maxRank: 20, dryRun: false, out: "", rio: true, pages: 1, reason: "",
  serverId: 286, serverSlug: "drakthul", region: "eu", zone: 53, ourGuild: 91339, guilds: "",
  maxPoints: 3300,          // sleep until the reset when pointsSpentThisHour passes this
  wclId: process.env.WCL_CLIENT_ID || flopikCfg.wcl_client_id || "",
  wclSecret: process.env.WCL_CLIENT_SECRET || flopikCfg.wcl_client_secret || "",
  api: (process.env.ES_API_URL || "https://eternal-shadows.vitek-poor.workers.dev").replace(/\/+$/, ""),
  token: process.env.ES_API_TOKEN || runnerCfg.api_token || "",
};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], v = process.argv[i + 1];
  if (a === "--min-avg") { OPT.minAvg = Number(v); i++; }
  else if (a === "--max-rank") { OPT.maxRank = Number(v); i++; }
  else if (a === "--dry-run") OPT.dryRun = true;
  else if (a === "--out") { OPT.out = v; i++; }
  else if (a === "--no-rio") OPT.rio = false;
  else if (a === "--pages") { OPT.pages = Math.max(1, Number(v) || 1); i++; }
  else if (a === "--reason") { OPT.reason = v || ""; i++; }
  else if (a === "--server-id") { OPT.serverId = Number(v); i++; }
  else if (a === "--server-slug") { OPT.serverSlug = v; i++; }
  else if (a === "--region") { OPT.region = v; i++; }
  else if (a === "--zone") { OPT.zone = Number(v); i++; }
  else if (a === "--our-guild") { OPT.ourGuild = Number(v); i++; }
  else if (a === "--guilds") { OPT.guilds = v || ""; i++; }
  else if (a === "--max-points") { OPT.maxPoints = Number(v); i++; }
  else { console.error("unknown argument " + a); process.exit(2); }
}

// WCL className values (no spaces); hps rankings only make sense for the classes with a healing spec
const CLASSES = ["DeathKnight", "DemonHunter", "Druid", "Evoker", "Hunter", "Mage", "Monk", "Paladin", "Priest", "Rogue", "Shaman", "Warlock", "Warrior"];
const HEALER_CLASSES = new Set(["Druid", "Evoker", "Monk", "Paladin", "Priest", "Shaman"]);
const HEALER_SPECS = new Set(["Restoration", "Preservation", "Mistweaver", "Holy", "Discipline"]);
const TANK_SPECS = new Set(["Blood", "Vengeance", "Guardian", "Brewmaster", "Protection"]);
const CLASS_LABEL = { DeathKnight: "Death Knight", DemonHunter: "Demon Hunter" };
const DIFF = { hc: 4, my: 5 };
const UA = "eternal-shadows scout (+https://eternal-shadows.vitek-poor.workers.dev)";

const LOG = [];
function log(...a) { const s = a.join(" "); LOG.push(s); console.log(s); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nkey = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const role = (spec, cls) => (TANK_SPECS.has(spec) && !(spec === "Protection" && !["Paladin", "Warrior"].includes(cls)) ? "tank" : HEALER_SPECS.has(spec) && !(spec === "Holy" && !["Paladin", "Priest"].includes(cls)) ? "healer" : "dps");

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
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = await fetch("https://www.warcraftlogs.com/api/v2/client", {
      method: "POST", headers: { authorization: "Bearer " + wclToken, "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify({ query: q, variables }),
    });
    if (r.status === 429 || r.status >= 500) { const w = 20 * attempt; log(`  WCL HTTP ${r.status} – retry in ${w}s`); await sleep(w * 1000); continue; }
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

async function ourRank() {
  const d = await gql(`{ guildData { guild(id: ${OPT.ourGuild}) { id name zoneRanking(zoneId: ${OPT.zone}) { progress { serverRank { number } worldRank { number } } } } } }`);
  const g = d.guildData.guild || {};
  const p = (g.zoneRanking && g.zoneRanking.progress) || {};
  return { name: g.name || "?", serverRank: p.serverRank ? p.serverRank.number : null, worldRank: p.worldRank ? p.worldRank.number : null };
}

async function encounters() {
  const d = await gql(`{ worldData { zone(id: ${OPT.zone}) { name encounters { id name } } } }`);
  return { zoneName: d.worldData.zone.name, list: d.worldData.zone.encounters };
}

/** candidates: every character in the server's parse rankings (per boss, per class, dps + hps, HC + M) → { key: {...} } */
async function harvest(encs) {
  const cand = new Map();
  let calls = 0;
  for (const e of encs) {
    for (const diff of [DIFF.hc, DIFF.my]) {
      for (const cls of CLASSES) {
        for (const metric of HEALER_CLASSES.has(cls) ? ["dps", "hps"] : ["dps"]) {
          for (let page = 1; page <= OPT.pages; page++) {
            const d = await gql(`{ worldData { encounter(id: ${e.id}) { characterRankings(serverSlug: "${OPT.serverSlug}", serverRegion: "${OPT.region}", difficulty: ${diff}, metric: ${metric}, className: "${cls}", page: ${page}) } } }`);
            calls++;
            const cr = d.worldData.encounter.characterRankings || {};
            for (const r of cr.rankings || []) {
              if (!r.guild || !r.guild.id) continue;
              const key = nkey(r.name) + "-" + OPT.serverSlug;
              const c = cand.get(key) || { name: r.name, class: r.class, specs: {}, guildId: r.guild.id, guildName: r.guild.name, seen: 0 };
              c.specs[r.spec] = (c.specs[r.spec] || 0) + 1; c.seen++;
              if (r.guild.id !== c.guildId) { c.guildId = r.guild.id; c.guildName = r.guild.name; } // latest guild wins (rankings are newest first-ish)
              cand.set(key, c);
            }
            if (!cr.hasMorePages) break;
          }
        }
      }
    }
    log(`  ${e.name}: ${cand.size} candidates so far (${calls} calls, ${points.spent.toFixed(0)} pts)`);
  }
  return cand;
}

/** { guildId: { id, name, faction, serverRank, worldRank } } for the candidates' guilds */
async function guildRanks(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const q = "{ guildData { " + chunk.map((id, k) => `g${k}: guild(id: ${id}) { id name faction { name } zoneRanking(zoneId: ${OPT.zone}) { progress { serverRank { number } worldRank { number } } } }`).join(" ") + " } }";
    const d = await gql(q);
    for (const g of Object.values(d.guildData)) {
      if (!g || !g.id) continue;
      const p = (g.zoneRanking && g.zoneRanking.progress) || {};
      out[g.id] = { id: g.id, name: g.name, faction: (g.faction && g.faction.name) || "", serverRank: p.serverRank ? p.serverRank.number : null, worldRank: p.worldRank ? p.worldRank.number : null };
    }
  }
  return out;
}

function perBoss(z) {
  return ((z && z.rankings) || []).filter((r) => r.rankPercent != null).map((r) => ({
    id: r.encounter.id, boss: r.encounter.name, best: round(r.rankPercent), median: round(r.medianPercent), kills: r.totalKills || 0, spec: r.spec || "",
  }));
}
const round = (v) => (v == null ? null : Math.round(Number(v) * 10) / 10);

/** zoneRankings HC + M for a batch of candidates (5 per query ≈ 50 points) → [{ cand, hc, my, hidden }] */
async function parses(cands) {
  const out = [];
  for (let i = 0; i < cands.length; i += 5) {
    const chunk = cands.slice(i, i + 5);
    const q = "{ characterData { " + chunk.map((c, k) => `c${k}: character(name: ${JSON.stringify(c.name)}, serverSlug: "${OPT.serverSlug}", serverRegion: "${OPT.region}") { id name hidden server { slug } hc: zoneRankings(zoneID: ${OPT.zone}, difficulty: ${DIFF.hc}) my: zoneRankings(zoneID: ${OPT.zone}, difficulty: ${DIFF.my}) }`).join(" ") + " } }";
    let d;
    try { d = await gql(q); } catch (e) { log(`  WARN parses ${chunk.map((c) => c.name).join(", ")}: ${e.message}`); continue; }
    chunk.forEach((c, k) => {
      const ch = d.characterData[`c${k}`];
      if (!ch) return;
      out.push({ cand: c, realm: (ch.server && ch.server.slug) || OPT.serverSlug, hidden: !!ch.hidden, hc: ch.hc || null, my: ch.my || null });
    });
  }
  return out;
}

// -------------------------------------------------------------------------------------------------- raider.io ----
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
async function main() {
  const startedAt = new Date().toISOString();
  log(`scout run ${runId} – min avg ${OPT.minAvg}, max rank ${OPT.maxRank}, server ${OPT.serverSlug} (${OPT.region}), zone ${OPT.zone}${OPT.dryRun ? ", DRY RUN" : ""}`);
  await wclAuth();
  const us = await ourRank();
  const encs = await encounters();
  log(`our guild ${us.name}: server rank ${us.serverRank}, world rank ${us.worldRank}; zone ${encs.zoneName}: ${encs.list.length} encounters`);
  await post("/api/scout/run", { runId, phase: "start", startedAt, ourRank: us.serverRank, ourGuild: us.name, minAvg: OPT.minAvg, maxRank: OPT.maxRank, reason: OPT.reason, zone: encs.zoneName });

  log("harvesting candidates from the server parse rankings …");
  const cand = await harvest(encs.list);
  const guildIds = [...new Set([...cand.values()].map((c) => c.guildId))];
  log(`${cand.size} candidates in ${guildIds.length} guilds (${points.spent.toFixed(0)} pts)`);
  const ranks = await guildRanks(guildIds);
  const only = OPT.guilds ? new Set(OPT.guilds.split(",").map((s) => nkey(s)).filter(Boolean)) : null;
  const keep = Object.values(ranks).filter((g) => only ? only.has(nkey(g.name))
    : g.id !== OPT.ourGuild && g.serverRank != null && (us.serverRank == null || g.serverRank > us.serverRank) && g.serverRank <= OPT.maxRank)
    .sort((a, b) => (a.serverRank || 999) - (b.serverRank || 999) || a.name.localeCompare(b.name));
  keep.forEach((g) => { g.candidates = [...cand.values()].filter((c) => c.guildId === g.id).length; g.players = 0; });
  log(`guilds to scout (${keep.length}): ` + keep.map((g) => `#${g.serverRank} ${g.name} (${g.candidates})`).join(", "));
  await post("/api/scout/guilds", { runId, guilds: keep });

  const all = [];
  let done = 0;
  for (const g of keep) {
    const gc = [...cand.values()].filter((c) => c.guildId === g.id);
    log(`\n#${g.serverRank} ${g.name}: ${gc.length} candidates`);
    const rows = await parses(gc);
    const found = [];
    for (const r of rows) {
      if (r.hidden) continue;
      const hcBest = r.hc && r.hc.bestPerformanceAverage, myBest = r.my && r.my.bestPerformanceAverage;
      if (!((hcBest != null && hcBest >= OPT.minAvg) || (myBest != null && myBest >= OPT.minAvg))) continue;
      const hcB = perBoss(r.hc), myB = perBoss(r.my);
      const specCount = {};
      [...hcB, ...myB].forEach((b) => { if (b.spec) specCount[b.spec] = (specCount[b.spec] || 0) + b.kills + 1; });
      Object.entries(r.cand.specs).forEach(([s, n]) => { specCount[s] = (specCount[s] || 0) + n; });
      const spec = Object.entries(specCount).sort((a, b) => b[1] - a[1]).map((x) => x[0])[0] || "";
      const cls = CLASS_LABEL[r.cand.class] || r.cand.class;
      const p = {
        key: nkey(r.cand.name) + "-" + r.realm, name: r.cand.name, realm: r.realm, class: cls, spec, role: role(spec, r.cand.class),
        guildId: g.id, guildName: g.name, ilvl: null,
        hcBest: round(hcBest), hcMedian: round(r.hc && r.hc.medianPerformanceAverage), hcKills: hcB.reduce((s, b) => s + b.kills, 0),
        myBest: round(myBest), myMedian: round(r.my && r.my.medianPerformanceAverage), myKills: myB.reduce((s, b) => s + b.kills, 0),
        wclUrl: `https://www.warcraftlogs.com/character/${OPT.region}/${r.realm}/${encodeURIComponent(r.cand.name)}`,
        rioUrl: `https://raider.io/characters/${OPT.region}/${r.realm}/${encodeURIComponent(r.cand.name)}`,
        bio: "", battletag: "", discord: "", socials: {}, recruitment: [], data: { hc: hcB, my: myB },
      };
      if (OPT.rio) {
        try {
          const rio = await rioProfile(r.cand.name, r.realm);
          if (rio) {
            p.ilvl = rio.ilvl; p.bio = rio.bio; p.battletag = rio.battletag; p.discord = rio.discord; p.socials = rio.socials; p.recruitment = rio.recruitment;
            p.data.thumb = rio.thumb; p.data.rioGuild = rio.guild; if (!p.spec && rio.spec) p.spec = rio.spec;
          } else p.data.rio = "not found";
        } catch (e) { p.data.rio = "error: " + String(e.message).slice(0, 100); }
        await sleep(150);
      }
      found.push(p);
    }
    g.players = found.length;
    all.push(...found);
    done++;
    log(`  → ${found.length} players with ${OPT.minAvg}+: ` + found.map((p) => `${p.name} (${p.spec} ${p.hcBest ?? "-"}/${p.myBest ?? "-"}${p.battletag || p.discord ? " ✉" : ""})`).join(", "));
    if (found.length) await post("/api/scout/players", { runId, players: found });
    await post("/api/scout/guilds", { runId, guilds: [g] });
    await post("/api/scout/run", { runId, phase: "progress", done, of: keep.length, players: all.length, candidates: cand.size, points: Math.round(points.spent) });
  }

  log(`\ndone: ${all.length} players from ${keep.length} guilds, ${Math.round(points.spent)} WCL points this hour`);
  if (OPT.dryRun) {
    const dir = OPT.out || path.join(HERE, "out");
    mkdirSync(dir, { recursive: true });
    const f = path.join(dir, "scout.json");
    writeFileSync(f, JSON.stringify({ runId, startedAt, ourRank: us, guilds: keep, players: all }, null, 1));
    log("dry run – written to " + f);
    return;
  }
  await post("/api/scout/run", { runId, phase: "finish", done, of: keep.length, players: all.length, candidates: cand.size, guilds: keep.length, points: Math.round(points.spent), prune: true, log: LOG.slice(-80).join("\n") });
}

main().catch(async (e) => {
  console.error("FAILED:", e && e.stack || e);
  try { await post("/api/scout/run", { runId, phase: "error", error: String(e && e.message || e).slice(0, 300), log: LOG.slice(-40).join("\n") }); } catch (e2) { /* ignore */ }
  process.exit(1);
});
