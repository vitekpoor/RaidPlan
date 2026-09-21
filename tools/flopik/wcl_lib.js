// Warcraft Logs v2 client + the table/breakdown helpers shared by the Worker (worker/flopik.js: report list,
// same-time reference windows) and the GitHub Actions runner (tools/flopik/wcl_refresh.mjs: pulls, damage
// breakdown, reference logs, parses). Plain ESM, only `fetch` – no Node or Worker specific APIs.
// Ported from the Apps Script FLOPIK sections (class_loot_dropdowns.gs), same shapes.

export const WCL_API = "https://www.warcraftlogs.com/api/v2/client";
export const WCL_TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
export const GUILD = { id: 91339, name: "Eternal Shadows", server: "burning-blade", region: "EU" };
export const HEALER_SPECS = { "Paladin-Holy": 1, "Priest-Holy": 1, "Priest-Discipline": 1, "Druid-Restoration": 1, "Shaman-Restoration": 1, "Monk-Mistweaver": 1, "Evoker-Preservation": 1 };
export const DIFF_ID = { LFR: 1, Normal: 3, Heroic: 4, Mythic: 5 };
export const DIFFICULTY = { 1: "LFR", 3: "Normal", 4: "Heroic", 5: "Mythic" };

export function reportCode(s) {
  s = String(s || "").trim();
  const m = s.match(/reports\/([A-Za-z0-9]{12,20})/);
  if (m) return m[1];
  return /^[A-Za-z0-9]{12,20}$/.test(s) ? s : "";
}

/**
 * GraphQL client with client-credentials token. store = { get(): {access_token, exp} | null, set(tok) } – optional
 * persistence (Worker: meta table; runner: memory). Returns async gql(query, variables) → data.
 */
export function makeWcl(clientId, clientSecret, store) {
  if (!clientId || !clientSecret) throw new Error("Warcraft Logs API klient není nastavený (WCL_CLIENT_ID / WCL_CLIENT_SECRET)");
  let cached = null;
  async function token(force) {
    if (!force) {
      const t = cached || (store && (await store.get()));
      if (t && t.access_token && t.exp > Date.now() + 60000) { cached = t; return t.access_token; }
    }
    const r = await fetch(WCL_TOKEN_URL, {
      method: "POST",
      headers: { authorization: "Basic " + btoa(clientId + ":" + clientSecret), "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!r.ok) throw new Error(`WCL token: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    const tok = await r.json();
    cached = { access_token: tok.access_token, exp: Date.now() + (Number(tok.expires_in) || 3600) * 1000 };
    if (store) await store.set(cached);
    return cached.access_token;
  }
  return async function gql(query, variables) {
    let tk = await token(false);
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await fetch(WCL_API, {
        method: "POST", headers: { authorization: "Bearer " + tk, "content-type": "application/json" },
        body: JSON.stringify({ query, variables: variables || {} }),
      });
      if (r.status === 401 && attempt === 0) { tk = await token(true); continue; }
      if (!r.ok) throw new Error(`WCL API: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
      const body = await r.json();
      if (body.errors && body.errors.length) throw new Error("WCL API: " + body.errors.map((e) => e.message).join("; "));
      return body.data;
    }
  };
}

/** Guild reports [{ code, title, start, end, zone }] (newest first, up to 40). */
export async function guildReports(gql, guildId = GUILD.id) {
  const d = await gql("query($id:Int!){ reportData { reports(guildID:$id, limit:40) { data { code title startTime endTime zone { name } } } } }", { id: guildId });
  return (d.reportData.reports.data || []).map((r) => ({ code: r.code, title: r.title, start: r.startTime, end: r.endTime, zone: r.zone ? r.zone.name : "" }));
}

/** Report header: title, startTime, guild, fights (encounters only), actors. */
export async function reportInfo(gql, code) {
  const d = await gql("query($c:String!){ reportData { report(code:$c) { title startTime guild { id } " +
    "fights(killType: Encounters) { id encounterID name difficulty kill startTime endTime } masterData { actors { id name type subType } } } } }", { c: code });
  return d.reportData.report;
}

/** All events of a fight matching the filter (pages of 10 000). */
export async function fightEvents(gql, code, fightId, filter) {
  let events = [], start = null;
  for (let page = 0; page < 30; page++) {
    const d = await gql("query($c:String!,$f:[Int]!,$s:Float,$flt:String){ reportData { report(code:$c) { events(fightIDs:$f, startTime:$s, filterExpression:$flt, limit:10000) { data nextPageTimestamp } } } }",
      { c: code, f: [fightId], s: start, flt: filter });
    const e = d.reportData.report.events;
    events = events.concat(e.data || []);
    if (!e.nextPageTimestamp) break;
    start = e.nextPageTimestamp;
  }
  return events;
}

/** Rankings of a kill by player name: healers by HPS, others by DPS. {} when WCL has none yet. */
export async function rankings(gql, code, fightId) {
  const out = {};
  async function load(metric) {
    const d = await gql("query($c:String!,$f:[Int]!,$m:ReportRankingMetricType){ reportData { report(code:$c) { rankings(fightIDs:$f, playerMetric:$m) } } }", { c: code, f: [fightId], m: metric });
    const rk = d.reportData.report.rankings;
    return ((rk && rk.data) || [])[0] || null;
  }
  const dps = await load("dps");
  if (!dps) return out;
  const hps = ((dps.roles || {}).healers || {}).characters && dps.roles.healers.characters.length ? await load("hps") : null;
  function take(f, role, metric) {
    ((((f || {}).roles || {})[role] || {}).characters || []).forEach((ch) => {
      out[ch.name] = { pct: Number(ch.rankPercent) || 0, bracket: Number(ch.bracketPercent) || 0, rank: ch.rank, n: ch.totalParses, metric, amount: Math.round(ch.amount || 0), spec: ch["class"] + "-" + ch.spec };
    });
  }
  take(dps, "tanks", "dps"); take(dps, "dps", "dps"); take(hps, "healers", "hps");
  return out;
}

/** DamageDone + Casts (+ Healing) tables of a fight, optionally cut at endMs (ms relative to the report). */
export async function tables(gql, code, fightId, withHeal, endMs) {
  const q = "query($c:String!,$f:[Int]!,$e:Float){ reportData { report(code:$c) { dmg: table(dataType: DamageDone, fightIDs:$f, endTime:$e) casts: table(dataType: Casts, fightIDs:$f, endTime:$e)" +
    (withHeal ? " heal: table(dataType: Healing, fightIDs:$f, endTime:$e)" : "") + " } } }";
  const rep = (await gql(q, { c: code, f: [fightId], e: endMs == null ? null : endMs })).reportData.report;
  const byName = (t) => { const m = {}; ((t && t.data && t.data.entries) || []).forEach((e) => { m[e.name] = e; }); return m; };
  return { dur: (rep.dmg && rep.dmg.data && rep.dmg.data.totalTime) || 0, dmg: byName(rep.dmg), casts: byName(rep.casts), heal: withHeal ? byName(rep.heal) : {} };
}

/** Complete ability / cast lists per actor id (batches of 10). healerIds = { id: 1 } → Healing instead of DamageDone. */
export async function perSource(gql, code, fightId, ids, healerIds, endMs) {
  const out = {};
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10), parts = [];
    chunk.forEach((id) => {
      parts.push(`d${id}: table(dataType: ${healerIds[id] ? "Healing" : "DamageDone"}, fightIDs:$f, sourceID:${id}, endTime:$e)`);
      parts.push(`c${id}: table(dataType: Casts, fightIDs:$f, sourceID:${id}, endTime:$e)`);
    });
    const rep = (await gql(`query($c:String!,$f:[Int]!,$e:Float){ reportData { report(code:$c) { ${parts.join(" ")} } } }`,
      { c: code, f: [fightId], e: endMs == null ? null : endMs })).reportData.report;
    chunk.forEach((id) => {
      const entries = (t) => (t && t.data && t.data.entries) || [];
      out[id] = { abil: entries(rep["d" + id]), casts: entries(rep["c" + id]) };
    });
  }
  return out;
}

/** Compact breakdown of one player: { spec, total, active, dur, abil:[[guid,name,total]], tgt:[[name,total]], casts:[[guid,name,n]], castN }. */
export function breakdown(main, castsE, durMs, ps) {
  const top = (list, n, f) => (list || []).slice().sort((a, b) => b.total - a.total).slice(0, n).map(f);
  const out = { spec: (main && main.icon) || (castsE && castsE.icon) || "", dur: Math.round(durMs || 0), total: 0, active: 0, abil: [], tgt: [], casts: [], castN: 0 };
  if (main) {
    out.total = Math.round(main.total || 0); out.active = Math.round(main.activeTime || 0);
    out.tgt = top(main.targets, 10, (t) => [t.name, Math.round(t.total)]);
  }
  const abilSrc = ps && ps.abil && ps.abil.length ? ps.abil : (main && main.abilities) || [];
  out.abil = top(abilSrc, 1000, (a) => [a.guid, a.name, Math.round(a.total)]);
  if (ps && ps.casts && ps.casts.length) {
    out.casts = top(ps.casts, 1000, (a) => [a.guid, a.name, Math.round(a.total)]);
    out.castN = ps.casts.reduce((n, a) => n + Math.round(a.total || 0), 0);
  } else if (castsE) {
    out.castN = Math.round(castsE.total || 0);
    out.casts = top(castsE.abilities, 1000, (a) => [a.guid, a.name, Math.round(a.total)]);
  }
  return out;
}

export function refKey(encId, difficulty, spec) { return encId + "|" + difficulty + "|" + spec; }

/** Strongest player of a spec in a table pool (name mismatch fallback). */
function bestOfSpec(pool, spec) {
  let best = null;
  Object.keys(pool).forEach((n) => { if (pool[n].icon === spec && (!best || pool[n].total > best.total)) best = pool[n]; });
  return best;
}

/**
 * Rank 1 log of a spec on a boss + difficulty → ref row { key, bossId, difficulty, spec, metric, player, server, guild,
 * report, fight, dur, amount, data } (data = breakdown, or { error }).
 */
export async function referenceLog(gql, encId, difficulty, spec) {
  const key = refKey(encId, difficulty, spec);
  const [cls, specName = ""] = spec.split("-");
  const healer = !!HEALER_SPECS[spec], metric = healer ? "hps" : "dps";
  const base = { key, bossId: encId, difficulty, spec, metric, player: "", server: "", guild: "", report: "", fight: null, dur: null, amount: null };
  try {
    const d = await gql("query($e:Int!,$cls:String!,$spec:String!,$dif:Int!,$m:CharacterRankingMetricType!){ worldData { encounter(id:$e) { characterRankings(className:$cls, specName:$spec, difficulty:$dif, metric:$m, page:1) } } }",
      { e: encId, cls, spec: specName, dif: DIFF_ID[difficulty] || 5, m: metric });
    const cr = d.worldData.encounter && d.worldData.encounter.characterRankings;
    const r = cr && cr.rankings && cr.rankings[0];
    if (!r) throw new Error(`žádný ranking pro ${spec} na bossovi ${encId} (${difficulty})`);
    const t = await tables(gql, r.report.code, r.report.fightID, healer);
    let main = (healer ? t.heal : t.dmg)[r.name] || null, castsE = t.casts[r.name] || null;
    if (!main) { main = bestOfSpec(healer ? t.heal : t.dmg, spec); castsE = main ? t.casts[main.name] || null : null; }
    let psRef = {};
    if (main) { const hid = {}; if (healer) hid[main.id] = 1; psRef = await perSource(gql, r.report.code, r.report.fightID, [main.id], hid, null); }
    const bd = breakdown(main, castsE, t.dur || r.duration, main ? psRef[main.id] : null);
    bd.metric = metric; bd.rank = 1;
    return { ...base, player: r.name, server: r.server ? r.server.name + "-" + r.server.region : "", guild: r.guild ? r.guild.name : "",
             report: r.report.code, fight: r.report.fightID, dur: Math.round((r.duration || 0) / 1000), amount: Math.round(r.amount || 0), data: bd };
  } catch (err) {
    return { ...base, data: { error: String((err && err.message) || err) } };
  }
}

/** Reference player's breakdown cut at endSec of his kill → { ok, key, end, whole, data? }. ref = row from flopik_refs. */
export async function referenceWindow(gql, ref, endSec) {
  endSec = Math.max(1, Math.round(Number(endSec) || 0));
  if (!ref || !ref.report) throw new Error(`referenční log pro ${ref && ref.key} není uložený`);
  const healer = ref.metric === "hps";
  const fd = await gql("query($c:String!,$f:[Int]!){ reportData { report(code:$c) { fights(fightIDs:$f) { startTime endTime } } } }", { c: ref.report, f: [Number(ref.fight)] });
  const f = fd.reportData.report.fights[0];
  if (!f) throw new Error(`fight ${ref.fight} v reportu ${ref.report} nenalezen`);
  if (endSec * 1000 >= f.endTime - f.startTime - 1000) return { ok: true, key: ref.key, end: endSec, whole: true };
  const endMs = f.startTime + endSec * 1000;
  const t = await tables(gql, ref.report, Number(ref.fight), healer, endMs);
  const pool = healer ? t.heal : t.dmg;
  let main = pool[ref.player] || null, castsE = t.casts[ref.player] || null;
  if (!main) { main = bestOfSpec(pool, ref.spec); castsE = main ? t.casts[main.name] || null : null; }
  let ps = {};
  if (main) { const hid = {}; if (healer) hid[main.id] = 1; ps = await perSource(gql, ref.report, Number(ref.fight), [main.id], hid, endMs); }
  const bd = breakdown(main, castsE, endSec * 1000, main ? ps[main.id] : null);
  bd.metric = ref.metric; bd.cut = "window";
  return { ok: true, key: ref.key, end: endSec, whole: false, data: bd };
}

const DMG_MAX_WINDOWS = 6;   // at most this many separate "until first death" windows per pull

/**
 * Attach `dmg` breakdowns to res.players (window = until the player's first death, at most the death cutoff) and
 * return the set of specs seen: { "Class-Spec": encounterID } so the caller can ensure reference logs.
 */
export async function attachDamage(gql, code, fight, res) {
  const st = fight.startTime, fightEnd = fight.endTime;
  const winEnd = res.cutoff == null ? fightEnd : Math.min(fightEnd, st + res.cutoff * 1000);
  const firstDeath = {};
  (res.deathList || []).forEach((d) => { if (firstDeath[d.n] == null || d.t < firstDeath[d.n]) firstDeath[d.n] = d.t; });
  const endOf = {}, extra = {};
  (res.players || []).forEach((p) => {
    let e = winEnd; const fd = firstDeath[p.name];
    if (fd != null && st + fd * 1000 < e) { e = st + fd * 1000; extra[e] = 1; }
    endOf[p.name] = e;
  });
  const extraEnds = Object.keys(extra).map(Number).sort((a, b) => a - b).slice(0, DMG_MAX_WINDOWS);
  const specs = {};
  const main = await tables(gql, code, fight.id, true, winEnd === fightEnd ? null : winEnd);
  const byEnd = {};
  for (const e of extraEnds) byEnd[e] = await tables(gql, code, fight.id, true, e);
  const groups = {};
  (res.players || []).forEach((p) => {
    const e = endOf[p.name], t = byEnd[e] || main;
    const row = t.dmg[p.name] || t.heal[p.name] || t.casts[p.name];
    if (!row) return;
    const g = groups[e] || (groups[e] = { ids: [], healers: {} });
    g.ids.push(row.id);
    if (HEALER_SPECS[row.icon]) g.healers[row.id] = 1;
  });
  const psByEnd = {};
  for (const e of Object.keys(groups)) {
    psByEnd[e] = await perSource(gql, code, fight.id, groups[e].ids, groups[e].healers, byEnd[e] ? Number(e) : (winEnd === fightEnd ? null : winEnd));
  }
  (res.players || []).forEach((p) => {
    const e = endOf[p.name], t = byEnd[e] || main;
    const row = t.dmg[p.name] || t.heal[p.name] || null, castsE = t.casts[p.name] || null;
    const spec = (row && row.icon) || (castsE && castsE.icon) || "";
    const healer = !!HEALER_SPECS[spec];
    const mainRow = healer ? (t.heal[p.name] || row) : row;
    const ps = mainRow ? (psByEnd[e] || {})[mainRow.id] : null;
    const bd = breakdown(mainRow, castsE, e - st, ps);
    bd.metric = healer ? "hps" : "dps";
    if (e !== winEnd) bd.cut = "death"; else if (winEnd !== fightEnd) bd.cut = "cutoff";
    p.dmg = bd;
    if (spec) specs[spec] = fight.encounterID;
  });
  return specs;
}
