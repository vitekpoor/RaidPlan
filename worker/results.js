// Sim results (Raidbots Droptimizer / Top Gear, QE Live) – tables sim_reports + sim_results (0001).
//   GET    /api/sims/results[?character=X]   all rows (edge-cached 60 s) – read by loot.html
//   POST   /api/sims/results                 (auth) store report(s): latest sim per character+spec+origin wins
//   DELETE /api/sims/results?character=X[&spec=Y][&origin=Z]   (auth)
// Writers: tools/roster/sim_results.py (the Raidbots data.json parsing stays in Python – free-plan CPU limit).

import { json, nameKey, specKey, numOrNull } from "./lib.js";

export const ORIGINS = ["raid", "mplus", "topgear", "raidhc"];
const RESULTS_CACHE_SECONDS = 60;

const RESULTS_SQL = `
  SELECT p.character, p.spec, p.origin, p.source, p.report_url AS report, p.char_ilvl AS charIlvl,
         p.simmed_at AS time, p.stored_at AS stored,
         r.boss_id AS bossId, r.boss, r.item_id AS itemId, r.item, r.slot, r.ilvl,
         r.base, r.value, r.diff, r.pct, r.catalyst_id AS catalystId, r.catalyst_from AS catalystFrom, r.worn
  FROM sim_results r JOIN sim_reports p ON p.id = r.report_id`;

export async function getResults(request, env, ctx, url) {
  const character = (url.searchParams.get("character") || "").trim();
  const cache = caches.default;
  const cacheKey = resultsCacheKey(url);
  if (!character) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  let rows, reports;
  if (character) {
    const key = nameKey(character);
    rows = (await env.DB.prepare(RESULTS_SQL + " WHERE p.character_key = ?1 ORDER BY p.spec_key, p.origin, r.pct DESC").bind(key).all()).results;
    reports = (await env.DB.prepare("SELECT * FROM sim_reports WHERE character_key = ?1 ORDER BY spec_key, origin").bind(key).all()).results;
  } else {
    rows = (await env.DB.prepare(RESULTS_SQL + " ORDER BY p.character_key, p.spec_key, p.origin, r.pct DESC").all()).results;
    reports = (await env.DB.prepare("SELECT * FROM sim_reports ORDER BY character_key, spec_key, origin").all()).results;
  }
  rows.forEach((r) => { r.worn = !!r.worn; });
  let stored = null;
  reports.forEach((p) => { if (!stored || p.stored_at > stored) stored = p.stored_at; });
  const body = { ok: true, generated: new Date().toISOString(), stored, count: rows.length, reports, rows };
  const res = json(body, 200, {
    "cache-control": character ? "no-store" : `public, max-age=0, s-maxage=${RESULTS_CACHE_SECONDS}`,
  });
  if (!character) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

export async function postResults(request, env, ctx, url) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "body must be JSON" }, 400);
  }
  const reports = Array.isArray(body) ? body : Array.isArray(body.reports) ? body.reports : [body];
  if (!reports.length) return json({ ok: false, error: "no reports" }, 400);
  for (const rep of reports) {
    const err = validateReport(rep);
    if (err) return json({ ok: false, error: err }, 400);
  }
  const stored = [];
  for (const rep of reports) {
    const ck = nameKey(rep.character), sk = specKey(rep.spec);
    const stmts = [
      env.DB.prepare("DELETE FROM sim_reports WHERE character_key = ?1 AND spec_key = ?2 AND origin = ?3").bind(ck, sk, rep.origin),
      env.DB.prepare(
        `INSERT INTO sim_reports (character, character_key, spec, spec_key, origin, source, report_url, char_ilvl, simmed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      ).bind(String(rep.character).trim(), ck, String(rep.spec).trim(), sk, rep.origin, String(rep.source || "Raidbots"),
             String(rep.reportUrl), numOrNull(rep.charIlvl), rep.simmedAt || new Date().toISOString()),
    ];
    for (const r of rep.rows || []) {
      stmts.push(env.DB.prepare(
        `INSERT INTO sim_results (report_id, boss_id, boss, item_id, item, slot, ilvl, base, value, diff, pct, catalyst_id, catalyst_from, worn)
         VALUES ((SELECT id FROM sim_reports WHERE character_key = ?1 AND spec_key = ?2 AND origin = ?3),
                 ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`
      ).bind(ck, sk, rep.origin,
             numOrNull(r.bossId), String(r.boss || ""), String(r.itemId == null ? "" : r.itemId), String(r.item || ""),
             String(r.slot == null ? "" : r.slot), numOrNull(r.ilvl), numOrNull(r.base), numOrNull(r.value), numOrNull(r.diff),
             numOrNull(r.pct), numOrNull(r.catalystId), String(r.catalystFrom || ""), r.worn ? 1 : 0));
    }
    // one batch = one transaction per report (D1 keeps batches atomic)
    await env.DB.batch(stmts);
    stored.push({ character: rep.character, spec: rep.spec, origin: rep.origin, rows: (rep.rows || []).length });
  }
  ctx.waitUntil(caches.default.delete(resultsCacheKey(url)));
  return json({ ok: true, stored });
}

export async function deleteResults(env, ctx, url) {
  const character = (url.searchParams.get("character") || "").trim();
  if (!character) return json({ ok: false, error: "character is required" }, 400);
  const spec = (url.searchParams.get("spec") || "").trim();
  const origin = (url.searchParams.get("origin") || "").trim();
  if (origin && !ORIGINS.includes(origin)) return json({ ok: false, error: "bad origin" }, 400);
  let sql = "DELETE FROM sim_reports WHERE character_key = ?1";
  const args = [nameKey(character)];
  if (spec) { args.push(specKey(spec)); sql += ` AND spec_key = ?${args.length}`; }
  if (origin) { args.push(origin); sql += ` AND origin = ?${args.length}`; }
  const res = await env.DB.prepare(sql).bind(...args).run();
  ctx.waitUntil(caches.default.delete(resultsCacheKey(url)));
  return json({ ok: true, deleted: (res.meta && res.meta.changes) || 0 });
}

function validateReport(rep) {
  if (!rep || typeof rep !== "object") return "report must be an object";
  if (!String(rep.character || "").trim()) return "character is required";
  if (!String(rep.spec || "").trim()) return "spec is required";
  if (!ORIGINS.includes(rep.origin)) return `origin must be one of ${ORIGINS.join(", ")}`;
  if (!String(rep.reportUrl || "").trim()) return "reportUrl is required";
  if (rep.rows != null && !Array.isArray(rep.rows)) return "rows must be an array";
  if ((rep.rows || []).length > 2000) return "too many rows";
  for (const r of rep.rows || []) {
    if (!r || typeof r !== "object") return "row must be an object";
    // Top Gear summary rows imported from the sheet have no item ids (gviz drops "a|b" strings) – rebuild fills them
    if ((r.itemId == null || r.itemId === "") && rep.origin !== "topgear") return "row.itemId is required";
  }
  return null;
}

export function resultsCacheKey(url) {
  return new Request(new URL("/api/sims/results", url.origin).toString(), { method: "GET" });
}

/**
 * Summary of a character's stored results for the Discord message (like simSummaryFor_ in Apps Script):
 * best raid / M+ item, Top Gear %, whether an HC raid report exists.
 */
export async function simSummary(env, character) {
  const rows = (await env.DB.prepare(
    `SELECT p.origin, r.item, r.boss, r.pct, r.catalyst_from AS catalystFrom, r.worn
     FROM sim_results r JOIN sim_reports p ON p.id = r.report_id WHERE p.character_key = ?1`
  ).bind(nameKey(character)).all()).results;
  const out = { raid: null, mplus: null, topgear: null, nRaid: 0, nMplus: 0, hc: false };
  for (const v of rows) {
    const it = { item: v.item || "", boss: v.boss || "", pct: Number(v.pct) || 0, catalystFrom: v.catalystFrom || "" };
    if (v.origin === "topgear") { out.topgear = it; continue; }
    if (v.origin === "raidhc") { out.hc = true; continue; }
    if (v.origin !== "raid" && v.origin !== "mplus") continue;
    if (it.pct > 0) out[v.origin === "raid" ? "nRaid" : "nMplus"]++;
    if (!out[v.origin] || it.pct > out[v.origin].pct) out[v.origin] = it;
  }
  return out;
}
