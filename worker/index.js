// Eternal Shadows Worker: static site (repo root, see .assetsignore) + JSON API backed by D1.
// Static assets are served first; anything that is not a file lands here.
//
//   GET    /api/health                  { ok, db, tables }
//   POST   /api/admin/migrate           (auth) create/upgrade tables from worker/migrations/*.sql
//   sim results  → worker/results.js    /api/sims/results
//   sim queue    → worker/queue.js      /api/sims/submit, /status, /queue, /queue/status, /run, /extras, /notify-test, /api/discord/rooms
//
// auth = header "Authorization: Bearer <API_TOKEN>" (Worker secret API_TOKEN; the same value is the GitHub Actions
// secret ES_API_TOKEN / sim_runner.config.json "api_token"). Writers: tools/roster/sim_results.py, sim_runner.py.

import migration0001 from "./migrations/0001_sim_results.sql";
import migration0002 from "./migrations/0002_sim_queue.sql";
import { json, CORS, requireAuth, splitSql } from "./lib.js";
import { getResults, postResults, deleteResults } from "./results.js";
import { submit, publicStatus, run, queueRows, queueStatus, notifyTest, discordRooms, getExtras, importExtras } from "./queue.js";

const MIGRATIONS = [["0001_sim_results", migration0001], ["0002_sim_queue", migration0002]];

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
  const auth = () => requireAuth(request, env);

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
    const denied = auth();
    if (denied) return denied;
    const applied = [];
    for (const [name, sql] of MIGRATIONS) {
      const stmts = splitSql(sql);
      await env.DB.batch(stmts.map((s) => env.DB.prepare(s)));
      applied.push({ name, statements: stmts.length });
    }
    return json({ ok: true, applied });
  }

  // ---- sim results (worker/results.js)
  if (path === "/api/sims/results") {
    if (method === "GET") return getResults(request, env, ctx, url);
    if (method === "POST") return auth() || postResults(request, env, ctx, url);
    if (method === "DELETE") return auth() || deleteResults(env, ctx, url);
  }

  // ---- sim queue + extras (worker/queue.js)
  if (path === "/api/sims/submit" && method === "POST") return submit(request, env, ctx, url);
  if (path === "/api/sims/status" && method === "GET") return publicStatus(env);
  if (path === "/api/sims/run" && method === "POST") return run(request, env, ctx, url);
  if (path === "/api/sims/extras") {
    if (method === "GET") return getExtras(env, ctx, url);
    if (method === "POST") return auth() || importExtras(request, env, ctx, url);
  }
  if (path === "/api/sims/queue" && method === "GET") return auth() || queueRows(env);
  if (path === "/api/sims/queue/status" && method === "POST") return auth() || queueStatus(request, env, ctx, url);
  if (path === "/api/sims/notify-test" && method === "GET") return auth() || notifyTest(env, ctx, url);
  if (path === "/api/discord/rooms" && method === "POST") return auth() || discordRooms(request, env, ctx, url);

  return json({ ok: false, error: "not found" }, 404);
}
