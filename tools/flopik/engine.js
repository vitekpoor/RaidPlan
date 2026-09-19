// Flopik engine – evaluates one Warcraft Logs fight (events from the v2 API) into the per-pull "fails" breakdown.
// Pure JavaScript without Apps Script / browser APIs, so the same code runs in class_loot_dropdowns.gs (pasted between
// the FLOPIK ENGINE markers by build_gs.py) and in a browser test harness. Keep it ES5-compatible (Apps Script V8 is
// fine with more, but the harness is plain <script>).
//
// Input shapes (WCL GraphQL): fight {id, encounterID, name, difficulty, kill, startTime, endTime} (ms relative to the
// report start), events [{timestamp, type, sourceID, targetID, abilityGameID, stack, ...}] filtered with
// flopikFilterFor(boss), actors [{id, name, type, subType}] from report.masterData.
// Output: the same object tools/flopik/flopik.py produces (date/start are filled by the caller from startMs).

var FLOPIK_DIFFICULTY = { 1: "LFR", 3: "Normal", 4: "Heroic", 5: "Mythic" };

/** Which bosses are tracked and which fails are counted – mirror of tools/flopik/bosses.py. */
function flopikMetric_(kind, key, label, ids, opts) {
  var m = { kind: kind, k: key, l: label, ids: ids.map(String), avoid: true, window: 1.5, castIds: [] };
  Object.keys(opts || {}).forEach(function (o) { m[o] = opts[o]; });
  m.castIds = (m.castIds || []).map(String);
  return m;
}
function flopikHits_(key, label, ids, opts) { return flopikMetric_("hits", key, label, ids, opts); }
function flopikDebuff_(key, label, ids, opts) { return flopikMetric_("debuff", key, label, ids, opts); }
function flopikCasts_(key, label, ids, opts) { return flopikMetric_("casts", key, label, ids, opts); }

var FLOPIK_BOSSES = {
  3470: { key: "nekzali", name: "Nek'zali the Soulcoiler", metrics: [] },
  3445: { key: "sentinels", name: "Entombed Sentinels", metrics: [] },
  3455: { key: "vashnik", name: "Vashnik the Malignant", metrics: [] },
  3497: { key: "explorers", name: "The Lost Explorers", metrics: [] },
  3420: { key: "sszorak", name: "Sszorak", metrics: [
    flopikHits_("tempest", "Tempest", [1287083], { castIds: [1287072], window: 3.0, hot: [1, 2], hotAll: [2, 4],
      note: "zásah Tempestem (1287083) – každý cast se počítá jednou (unique hit count), ne ticky" })
  ] },
  3421: { key: "twinfangs", name: "The Twin Fangs", cutoff: 2, analyze: "twinfangs", metrics: [] },
  3429: { key: "coiledaltar", name: "The Coiled Altar", metrics: [] },
  3492: { key: "ulatek", name: "Ula'tek", metrics: [] },
  3379: { key: "nymrissa", name: "Nymrissa Wavecaller", metrics: [] }
};

var FLOPIK_DEATH_COL = { k: "deaths", l: "Smrti", cls: "deaths", hot: [1, 2], hotAll: [3, 5], agg: "sum" };

/** Boss definition for an encounter ID (unknown bosses get deaths only). */
function flopikBossFor(encounterID, name) {
  return FLOPIK_BOSSES[encounterID] || { key: "enc" + encounterID, name: name || ("Encounter " + encounterID), metrics: [] };
}

/** WCL events filterExpression: only what the boss's metrics need + player deaths. */
function flopikFilterFor(boss) {
  var ids = [];
  (boss.metrics || []).forEach(function (m) { ids = ids.concat(m.ids, m.castIds || []); });
  if (boss.analyze === "twinfangs") ids = ids.concat(FLOPIK_TF.ids);
  var parts = ["(type = 'death' and target.type = 'player')"];
  if (ids.length) parts.push("ability.id in (" + ids.join(",") + ")");
  return parts.join(" or ");
}

function flopikClusters_(times, windowSec) {
  var n = 0, last = null;
  times.slice().sort(function (a, b) { return a - b; }).forEach(function (t) {
    if (last === null || (t - last) > windowSec * 1000) n++;
    last = t;
  });
  return n;
}
function flopikNear_(list, t, windowSec) {
  for (var i = 0; i < list.length; i++) if (Math.abs(t - list[i]) <= windowSec * 1000) return true;
  return false;
}
function flopikMmss_(sec) { sec = Math.round(sec); var m = Math.floor(sec / 60), s = sec % 60; return m + ":" + (s < 10 ? "0" : "") + s; }

/**
 * Main entry. fight/events/actors as described above. Returns the pull result object; the caller adds
 * date/start (from result.startMs) and report/fight identifiers.
 */
function flopikAnalyze(fight, events, actors, reportStartMs) {
  var boss = flopikBossFor(fight.encounterID, fight.name);
  var actorById = {};
  (actors || []).forEach(function (a) { actorById[a.id] = a; });
  var players = {};   // id -> name
  events.forEach(function (e) {
    [e.sourceID, e.targetID].forEach(function (id) {
      var a = actorById[id];
      if (a && a.type === "Player") players[id] = a.name;
    });
  });
  var st = fight.startTime, dur = (fight.endTime - fight.startTime) / 1000;
  var deaths = [];   // [{t, id, n}]
  events.forEach(function (e) {
    if (e.type === "death" && players[e.targetID]) deaths.push({ t: e.timestamp, id: e.targetID, n: players[e.targetID] });
  });
  deaths.sort(function (a, b) { return a.t - b.t; });
  var cutoffN = boss.cutoff || 0;
  var cutT = (cutoffN && deaths.length >= cutoffN) ? deaths[cutoffN - 1].t : fight.endTime;
  var cutoff = (cutoffN && deaths.length >= cutoffN) ? Math.round((cutT - st) / 1000) : null;
  var evc = events.filter(function (e) { return e.timestamp <= cutT; });

  var res = {
    startMs: reportStartMs + fight.startTime, dur: Math.round(dur), boss: boss.name, bossKey: boss.key, bossId: fight.encounterID,
    difficulty: FLOPIK_DIFFICULTY[fight.difficulty] || String(fight.difficulty || ""), kill: !!fight.kill, deaths: deaths.length, cutoff: cutoff,
    deathList: deaths.map(function (d) { return { n: d.n, t: Math.round((d.t - st) / 1000) }; }),
    cols: [], legend: [], description: "", stats: [], summary: { cutoffN: cutoffN }, players: []
  };
  var rows = {};   // name -> row
  Object.keys(players).forEach(function (id) { rows[players[id]] = { name: players[id], died: false }; });

  if (boss.analyze === "twinfangs") {
    var out = flopikTwinFangs_(evc, events, players, actorById, deaths, st, cutoffN, cutoff);
    ["cols", "legend", "description", "stats"].forEach(function (k) { res[k] = out[k]; });
    Object.keys(out.summary).forEach(function (k) { res.summary[k] = out.summary[k]; });
    out.players.forEach(function (r) { rows[r.name] = r; });
  } else {
    (boss.metrics || []).forEach(function (m) {
      var per = {}, casts = 0;
      evc.forEach(function (e) {
        var ab = String(e.abilityGameID);
        if (e.type === "cast" && m.castIds.indexOf(ab) >= 0) casts++;
        if (m.ids.indexOf(ab) < 0) return;
        var hitTypes = m.kind === "hits" ? ["damage", "applydebuff"] : m.kind === "debuff" ? ["applydebuff", "applydebuffstack"] : ["cast"];
        if (hitTypes.indexOf(e.type) < 0 || e.tick) return;   // periodic ticks are not new hits
        var who = m.kind === "casts" ? e.sourceID : e.targetID;
        if (!players[who]) return;
        (per[who] = per[who] || []).push(e.timestamp);
      });
      var total = 0;
      Object.keys(players).forEach(function (id) {
        var ts = per[id] || [];
        var v = m.kind === "hits" ? flopikClusters_(ts, m.window) : ts.length;
        rows[players[id]][m.k] = v; total += v;
      });
      var col = { k: m.k, l: m.l, agg: "sum" };
      if (m.avoid) col.avoid = 1;
      if (m.hot) col.hot = m.hot;
      if (m.hotAll) col.hotAll = m.hotAll;
      res.cols.push(col);
      if (m.note) res.legend.push("<b>" + m.l + "</b> – " + m.note + ".");
      var stat = { l: m.l, v: total, cls: total ? "bad" : "", agg: "sum" };
      if (m.castIds.length) { res.summary[m.k + "Casts"] = casts; stat.s = total + " zásahů z " + casts + " castů"; }
      res.stats.push(stat);
    });
  }
  // deaths for every boss (whole pull) + died marker (up to the cutoff)
  Object.keys(rows).forEach(function (n) { rows[n].deaths = 0; });
  deaths.forEach(function (d) {
    var row = rows[d.n] || (rows[d.n] = { name: d.n, died: false, deaths: 0 });
    row.deaths++;
    if (cutoff === null || d.t <= cutT) row.died = true;
  });
  var list = Object.keys(rows).map(function (n) { return rows[n]; });
  if (boss.analyze === "twinfangs") list.sort(function (a, b) { return (b.orbs || 0) - (a.orbs || 0) || (a.diff || 0) - (b.diff || 0) || a.name.localeCompare(b.name); });
  else list.sort(function (a, b) { return b.deaths - a.deaths || a.name.localeCompare(b.name); });
  res.players = list;
  if (!res.cols.some(function (c) { return c.k === "deaths"; })) res.cols.push(FLOPIK_DEATH_COL);
  var first = deaths[0];
  res.stats.unshift({ l: "Smrti", v: deaths.length, cls: deaths.length ? "bad" : "", agg: "sum",
    s: first ? "první " + first.n + " v " + flopikMmss_((first.t - st) / 1000) : "nikdo neumřel" });
  return res;
}

// ---------------------------------------------------------------- The Twin Fangs ----
// Caustic Globule soaks vs. Eternal Venom stacks per player – rules verified on the 2026-09-17 log:
//   orb soak      = cast 1289201 (Caustic Globule) on a player -> at the same moment cast 1290336 (Eternal Venom) by Vexhul
//   add spawn     = Rouse the Brood (1308482, Ithraz) or Venomous Emergence (1308122, Vexhul – same moment as the stack) damages
//                   the whole raid -> 1 stack each; falls off by itself after ~25 s
//   orb explosion = Caustic Globule 1290338 damage (AOE) -> 1 stack to the whole raid
//   add frontal   = Eternal Venom cast whose source is "Spawn of Vexhul" (right after its Corrosive Spit 1291478 cast success).
//                   The marker debuff 1293979 applied at cast start names the targeted player. Split into: 1st cast on its
//                   target (expected, 1 per add), anyone else in the cone (avoidable) and a 2nd+ cast of the same add (the add
//                   should have died before it – verified 2026-09-17: 5 s cast, ~7 s between casts, target hit in 237/245 casts)
//   waves         = Stir the Depths (applydebuff 1292807, or a miss/immune – Divine Shield still gets the stack) at the same moment.
//                   A Vexhul stack with no marker at all is a wave too (checked on video 2026-09-17: the wave hit was simply not
//                   logged) – counted as "stir", the number is kept in summary.unmarked for debugging.
//   markers are taken from the whole pull, the stacks only up to the cutoff (Rouse damage can be logged 0.3 s after the stack)
//   Vile Flood    = intermission laser of Vexhul: debuff/damage 1294605 on the player at the same moment (cast itself is 1294293)
//   dropped       = removedebuffstack / removedebuff (not on the player's death)
//   net stacks    = gained − dropped = stacks at the cutoff (2nd player death); ideally == orbs
var FLOPIK_TF = {
  ids: [1289201, 1290336, 1308482, 1308122, 1290338, 1292807, 1294605, 1291478, 1293979],
  ORB: "1289201", VENOM: "1290336", ROUSE: "1308482", EMERGE: "1308122", EXPL: "1290338", STIR: "1292807", FLOOD: "1294605", SPIT: "1291478", MARK: "1293979",
  SRC: ["orb", "wave", "explosion", "spawn", "spawnSide", "spawn2", "stir", "flood"],
  cols: [
    { k: "orbs", l: "Orby", cls: "orb", agg: "sum" },
    { k: "net", l: "Stacky", cls: "total", agg: "sum" },
    { k: "diff", l: "Rozdíl", cls: "diff", signed: 1, hot: [2, 4], hotAll: [12, 18], agg: "sum" },
    { k: "total", l: "Získané", grp: 1, agg: "sum" },
    { k: "removed", l: "Odpadlé", neg: 1, agg: "sum" },
    { k: "orb", l: "Orb", grp: 1, agg: "sum" },
    { k: "wave", l: "Spawn addek", agg: "sum" },
    { k: "explosion", l: "Výbuch", agg: "sum" },
    { k: "spawn", l: "Addka cíl", agg: "sum" },
    { k: "spawnSide", l: "Addka v cestě", avoid: 1, hot: [1, 2], hotAll: [3, 6], agg: "sum" },
    { k: "spawn2", l: "Addka 2. cast", avoid: 1, hot: [1, 2], hotAll: [2, 4], agg: "sum" },
    { k: "stir", l: "Vlny", avoid: 1, hot: [2, 3], hotAll: [6, 10], agg: "sum" },
    { k: "flood", l: "Vile Flood", avoid: 1, hot: [2, 3], hotAll: [6, 10], agg: "sum" },
    { k: "max", l: "Max", grp: 1, cls: "max", high: 8, agg: "max" }
  ],
  legend: [
    "<b>Orby</b> = soaknuté Caustic Globule. <b>Stacky</b> = čisté stacky Eternal Venom při cutoffu (získané − odpadlé). " +
    "<b>Rozdíl</b> = Stacky − Orby: <b>0 je ideál</b>, plus jsou stacky navíc (frontal addky, vlny, nebo stack ze spawnu addek, " +
    "který ještě nestihl odpadnout). <b>Získané</b> = všechny stacky, které hráč dostal, <b>Odpadlé</b> = stacky, které mu spadly " +
    "(smrt se nepočítá), dále rozpad získaných podle zdroje. <b>Max</b> = nejvyšší dosažený počet stacků v pullu.",
    "<b>Orb</b> – soak orbu (žádoucí, 1 stack za orb). <b>Spawn addek</b> – Rouse the Brood od Ithraze, 1 stack každému živému hráči " +
    "zhruba každou minutu; nelze se vyhnout, stack sám odpadne po ~25 s. <b>Výbuch</b> – nesoaknutý orb explodoval, 1 stack celému raidu.",
    "<b>Addka cíl</b> – první frontal (Corrosive Spit) addky Spawn of Vexhul na hráče, kterého si addka vybrala (čekaný, 1 na addku). " +
    "<b>Addka v cestě</b> – frontal trefil i někoho jiného, kdo stál v kuželu. <b>Addka 2. cast</b> – addka se dožila dalšího frontalu a trefila " +
    "svůj cíl (měla umřít dřív). <b>Vlny</b> – zásah vlnou (Stir the Depths; počítá se i zásah pod imunitou nebo bez zalogovaného debuffu). " +
    "<b>Vile Flood</b> – zásah laserem Vexhul v intermission. Zbytečné stacky = v cestě + 2. cast + vlny + Vile Flood. Každý pull je uříznutý v okamžiku druhé smrti hráče (†)."
  ],
  description: "Každý soaknutý <b>Caustic Globule</b> dá hráči 1 stack Eternal Venom. Stacky navíc přidává spawn addek (<b>Rouse the Brood</b>), " +
    "výbuch nesoaknutého orbu, frontal addky (<b>Spawn of Vexhul</b>), vlny (<b>Stir the Depths</b>) a laser v intermission (<b>Vile Flood</b>). " +
    "V ideálním případě má hráč přesně tolik stacků, kolik soaknul orbů."
};

function flopikTwinFangs_(evc, events, players, actorById, deaths, st, cutoffN, cutoff) {
  var T = FLOPIK_TF;
  var deathT = {};
  deaths.forEach(function (d) { (deathT[d.id] = deathT[d.id] || []).push(d.t); });
  var orbT = {}, rouseT = {}, explT = {}, stirT = {}, floodT = {}, spitT = {}, markT = {}, rouseAll = [];
  function addKey(e) { return e.sourceID + "/" + (e.sourceInstance || 0); }
  function isSpawn(e) { return !!actorById[e.sourceID] && actorById[e.sourceID].name === "Spawn of Vexhul"; }
  function push(map, id, t) { (map[id] = map[id] || []).push(t); }
  events.forEach(function (e) {   // markers from the whole pull
    var ab = String(e.abilityGameID);
    if (e.type === "cast" && ab === T.ORB) push(orbT, e.targetID, e.timestamp);
    if ((e.type === "damage" || e.type === "absorbed") && (ab === T.ROUSE || ab === T.EMERGE)) { push(rouseT, e.targetID, e.timestamp); rouseAll.push(e.timestamp); }
    if (e.type === "damage" && ab === T.EXPL) push(explT, e.targetID, e.timestamp);
    if ((e.type === "applydebuff" || e.type === "damage" || e.type === "absorbed") && ab === T.STIR) push(stirT, e.targetID, e.timestamp);
    if ((e.type === "damage" || e.type === "applydebuff" || e.type === "absorbed") && ab === T.FLOOD) push(floodT, e.targetID, e.timestamp);
    if (e.type === "cast" && ab === T.SPIT && isSpawn(e)) push(spitT, addKey(e), e.timestamp);
    if (e.type === "applydebuff" && ab === T.MARK && isSpawn(e)) push(markT, addKey(e), { t: e.timestamp, id: e.targetID });
  });
  // Which frontal of this add is it and who was the marked target? -> "spawn" (1st cast, target) / "spawnSide" / "spawn2"
  function spawnKind(e) {
    var k = addKey(e), n = 0, tgt = null, i;
    for (i = 0; i < (spitT[k] || []).length; i++) if (spitT[k][i] <= e.timestamp + 100) n++;
    for (i = 0; i < (markT[k] || []).length; i++) if (markT[k][i].t <= e.timestamp + 100) tgt = markT[k][i].id;
    if (tgt !== null && tgt !== e.targetID) return "spawnSide";
    return n >= 2 ? "spawn2" : "spawn";
  }
  var orbs = {}, stacks = {}, maxst = {}, removed = {}, gainedA = {}, gained = {}, unmarked = 0;
  function inc(map, id, by) { map[id] = (map[id] || 0) + (by === undefined ? 1 : by); }
  evc.forEach(function (e) {
    var ab = String(e.abilityGameID), g = e.targetID;
    if (e.type === "cast" && ab === T.ORB) inc(orbs, g);
    if (e.type === "cast" && ab === T.VENOM) {
      var src = isSpawn(e) ? spawnKind(e)
        : flopikNear_(orbT[g] || [], e.timestamp, 0.15) ? "orb"
        : flopikNear_(stirT[g] || [], e.timestamp, 0.15) ? "stir"
        : flopikNear_(rouseT[g] || [], e.timestamp, 0.6) ? "wave"
        : flopikNear_(explT[g] || [], e.timestamp, 0.6) ? "explosion"
        : flopikNear_(floodT[g] || [], e.timestamp, 0.6) ? "flood"
        : flopikNear_(rouseAll, e.timestamp, 0.6) ? "wave"   // add spawn is raid-wide; the player's own hit may be missing (died that instant)
        : "stir";
      if (src === "stir" && !flopikNear_(stirT[g] || [], e.timestamp, 0.15)) unmarked++;
      gained[g] = gained[g] || {};
      inc(gained[g], src);
    }
    if (ab === T.VENOM && (e.type === "applydebuff" || e.type === "applydebuffstack" || e.type === "removedebuffstack" || e.type === "removedebuff")) {
      if (e.type === "removedebuff" && flopikNear_(deathT[g] || [], e.timestamp, 1.5)) return;   // dropped on death – keep the stacks the player died with
      var n = e.type === "applydebuff" ? 1 : e.type === "removedebuff" ? 0 : Number(e.stack) || 0;
      var cur = stacks[g] || 0;
      if (n < cur) inc(removed, g, cur - n); else inc(gainedA, g, n - cur);
      stacks[g] = n; maxst[g] = Math.max(maxst[g] || 0, n);
    }
  });
  var explSecs = {};
  Object.keys(explT).forEach(function (id) { explT[id].forEach(function (t) { explSecs[Math.round((t - st) / 1000)] = 1; }); });
  var explN = 0, last = null;
  Object.keys(explSecs).map(Number).sort(function (a, b) { return a - b; }).forEach(function (x) { if (last === null || x - last > 1) explN++; last = x; });
  var waves = 0;
  Object.keys(gained).forEach(function (id) { waves = Math.max(waves, gained[id].wave || 0); });
  var cutIds = {};
  deaths.forEach(function (d) { if (cutoff === null || Math.round((d.t - st) / 1000) <= cutoff) cutIds[d.id] = 1; });
  var rows = [];
  Object.keys(players).forEach(function (id) {
    var c = gained[id] || {}, net = stacks[id] || 0, o = orbs[id] || 0;
    var r = { name: players[id], orbs: o, net: net, diff: net - o, total: gainedA[id] || 0, removed: removed[id] || 0, max: maxst[id] || 0, died: !!cutIds[id] };
    T.SRC.forEach(function (k) { r[k] = c[k] || 0; });
    rows.push(r);
  });
  var n = rows.length || 1, totalOrbs = 0, net = 0, diff = 0, avoid = 0;
  rows.forEach(function (r) { totalOrbs += r.orbs; net += r.net; diff += r.diff; avoid += r.spawnSide + r.spawn2 + r.stir + r.flood; });
  var cutNames = deaths.slice(0, cutoffN).map(function (d) { return d.n; });
  var addsN = 0, adds2 = 0;
  Object.keys(spitT).forEach(function (k) { addsN++; if (spitT[k].length >= 2) adds2++; });
  var stats = [
    { l: "Cutoff", v: cutoff !== null ? flopikMmss_(cutoff) : "—", cls: cutoff !== null ? "bad" : "",
      s: cutoff !== null ? cutoffN + ". smrt: " + cutNames.join(", ") : "nedosažen (" + deaths.length + " úmrtí)" },
    { l: "Soaknuté orby", v: totalOrbs, cls: "accent", s: (totalOrbs / n).toFixed(1) + " na hráče", agg: "sum" },
    { l: "Stacky (čisté)", v: net, cls: "venom", s: (diff >= 0 ? "+" : "") + diff + " oproti orbům", agg: "sum" },
    { l: "Zbytečné stacky", v: avoid, cls: avoid ? "bad" : "", s: "addka v cestě + 2. cast + vlny + Vile Flood", agg: "sum" },
    { l: "Addky s 2. frontalem", v: adds2, cls: adds2 ? "bad" : "", s: "z " + addsN + " addek, které dokončily frontal", agg: "sum" },
    { l: "Spawny addek", v: waves, cls: "", s: (waves * 20) + " stacků raidu, odpadají po ~25 s", agg: "sum" },
    { l: "Výbuchy orbů", v: explN, cls: explN ? "bad" : "", s: explN ? (explN * 20) + " stacků celému raidu" : "žádný nesoaknutý orb", agg: "sum" }
  ];
  return { cols: T.cols, legend: T.legend, description: T.description, stats: stats,
    summary: { orbs: totalOrbs, expl: explN, waves: waves, unmarked: unmarked, cutoffN: cutoffN, cutoffDeaths: cutNames }, players: rows };
}
