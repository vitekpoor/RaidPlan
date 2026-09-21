// Eternal Shadows Worker: static site (repo root, see .assetsignore) + JSON API backed by D1.
// Static assets are served first; anything that is not a file lands here.
//
//   GET    /api/health                       { ok, db, tables }
//   POST   /api/admin/migrate                (auth) create/upgrade tables from worker/migrations/*.sql
//   GET    /api/sims/results[?character=X]   all sim results (edge-cached 60 s) – read by loot.html
//   POST   /api/sims/results                 (auth) store report(s): latest sim per character+spec+origin wins
//   DELETE /api/sims/results?character=X[&spec=Y][&origin=Z]   (auth)
//
// auth = header "Authorization: Bearer <API_TOKEN>" (Worker secret API_TOKEN; the same value is the
// GitHub Actions secret ES_API_TOKEN / sim_runner.config.json "api_token"). Writers: tools/roster/sim_results.py.

import migration0001 from "./migrations/0001_sim_results.sql";

const MIGRATIONS = [["0001_sim_results", migration0001]];
const ORIGINS = ["raid", "mplus", "topgear", "raidhc"];
const RESULTS_CACHE_SECONDS = 60;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
    try {
      return await route(request, env, ctx, url);
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 500);
    }
  },
};

async function route(request, env, ctx, url) {
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;

  if (path === "/api/health" && method === "GET") {
    let db = false, tables = [], error;
    try {
      const rs = await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all();
      db = true;
      tables = rs.results.map((r) => r.name);
    } catch (e) {
      error = String((e && e.message) || e);
    }
    return json({ ok: db, db, tables, error });
  }

  if (path === "/api/admin/migrate" && method === "POST") {
    const denied = requireAuth(request, env);
    if (denied) return denied;
    const applied = [];
    for (const [name, sql] of MIGRATIONS) {
      const stmts = splitSql(sql);
      await env.DB.batch(stmts.map((s) => env.DB.prepare(s)));
      applied.push({ name, statements: stmts.length });
    }
    return json({ ok: true, applied });
  }

  if (path === "/api/sims/results") {
    if (method === "GET") return getResults(request, env, ctx, url);
    if (method === "POST") {
      const denied = requireAuth(request, env);
      if (denied) return denied;
      return postResults(request, env, ctx, url);
    }
    if (method === "DELETE") {
      const denied = requireAuth(request, env);
      if (denied) return denied;
      return deleteResults(env, ctx, url);
    }
  }

  return json({ ok: false, error: "not found" }, 404);
}

// ------------------------------------------------------------------ sims ----

const RESULTS_SQL = `
  SELECT p.character, p.spec, p.origin, p.source, p.report_url AS report, p.char_ilvl AS charIlvl,
         p.simmed_at AS time, p.stored_at AS stored,
         r.boss_id AS bossId, r.boss, r.item_id AS itemId, r.item, r.slot, r.ilvl,
         r.base, r.value, r.diff, r.pct, r.catalyst_id AS catalystId, r.catalyst_from AS catalystFrom, r.worn
  FROM sim_results r JOIN sim_reports p ON p.id = r.report_id`;

async function getResults(request, env, ctx, url) {
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

async function postResults(request, env, ctx, url) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "body must be JSON" }, 400);
  }
  const reports = Array.isArray(body) ? body : Array.isArray(body.reports) ? body.reports : [body];
  if (!reports.length) return json({ ok: false, error: "no reports" }, 400);
  const stored = [];
  for (const rep of reports) {
    const err = validateReport(rep);
    if (err) return json({ ok: false, error: err }, 400);
  }
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

async function deleteResults(env, ctx, url) {
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
    if (r.itemId == null || r.itemId === "") return "row.itemId is required";
  }
  return null;
}

function resultsCacheKey(url) {
  return new Request(new URL("/api/sims/results", url.origin).toString(), { method: "GET" });
}

// --------------------------------------------------------------- helpers ----

/** Same as Apps Script simNameKey_: lower case, no diacritics, trimmed. */
function nameKey(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Same as Apps Script simSpecKey_: lower-case letters only ("Beast Mastery" → "beastmastery"). */
function specKey(s) {
  return String(s || "").toLowerCase().replace(/[^a-z]/g, "");
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Split a migration file into statements: drop "--" comment lines, split on ";". */
function splitSql(sql) {
  return sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n")
    .split(";").map((s) => s.trim()).filter(Boolean);
}

function requireAuth(request, env) {
  if (!env.API_TOKEN) return json({ ok: false, error: "API_TOKEN secret is not configured on the Worker" }, 503);
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") || "");
  if (!m || !timingSafeEqual(m[1].trim(), env.API_TOKEN)) return json({ ok: false, error: "unauthorized" }, 401);
  return null;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS, ...extra },
  });
}
