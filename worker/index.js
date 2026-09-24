// Eternal Shadows Worker: static site (repo root, see .assetsignore) + JSON API backed by D1.
// Static assets are served first; anything that is not a file lands here.
//
//   GET    /api/health                  { ok, db, tables }
//   POST   /api/admin/migrate           (auth) create/upgrade tables from worker/migrations/*.sql
//   sim results  → worker/results.js    /api/sims/results
//   sim queue    → worker/queue.js      /api/sims/submit, /status, /queue, /queue/status, /run, /extras, /notify-test, /api/discord/rooms
//   roster       → worker/roster.js     /api/roster (+ .csv), PUT (admin), /api/admin/login, /api/admin/check
//   absence      → worker/absence.js    /api/absence (+ .csv), DELETE (admin), /api/absence/import (admin)
//   flopik       → worker/flopik.js     /api/flopik/reports, /pulls, /pulls/parse, /refs, /refwin, /refresh, /status
//   attendance   → worker/attendance.js /api/attendance (+ .csv, DELETE + PATCH admin), /api/es?p=esroster|attendance (addon)
//   lineups      → worker/lineups.js    /api/lineups (+ .csv), PUT (admin)
//   raidplan     → worker/raidplan.js   /api/lineups/sync (admin → GitHub Actions raidplan.yml), /sync-result (auth), /sync-status
//   meta comps   → worker/comps.js      /api/comps (GET, POST auth), /api/comps/refresh (admin), /api/comps/status
//
// auth = header "Authorization: Bearer <API_TOKEN>" (Worker secret API_TOKEN; the same value is the GitHub Actions
// secret ES_API_TOKEN / sim_runner.config.json "api_token"). Writers: tools/roster/sim_results.py, sim_runner.py.

import migration0001 from "./migrations/0001_sim_results.sql";
import migration0002 from "./migrations/0002_sim_queue.sql";
import migration0003 from "./migrations/0003_roster_absence.sql";
import migration0004 from "./migrations/0004_flopik.sql";
import migration0005 from "./migrations/0005_attendance_lineups.sql";
import migration0006 from "./migrations/0006_rio_comps.sql";
import migration0007 from "./migrations/0007_absence_time.sql";
import { json, CORS, requireAuth, requireAdmin, adminLogin, splitSql } from "./lib.js";
import { getRoster, getRosterCsv, putRoster } from "./roster.js";
import { postAbsence, getAbsence, getAbsenceCsv, deleteAbsence, importAbsence } from "./absence.js";
import * as flopik from "./flopik.js";
import { postAttendance, getAttendance, getAttendanceCsv, deleteAttendance, patchAttendance, esEndpoint } from "./attendance.js";
import { getLineups, putLineups, getLineupsCsv } from "./lineups.js";
import * as comps from "./comps.js";
import * as raidplan from "./raidplan.js";
import { getResults, postResults, deleteResults } from "./results.js";
import { submit, publicStatus, run, queueRows, queueStatus, notifyTest, discordRooms, getExtras, importExtras } from "./queue.js";

const MIGRATIONS = [["0001_sim_results", migration0001], ["0002_sim_queue", migration0002], ["0003_roster_absence", migration0003], ["0004_flopik", migration0004], ["0005_attendance_lineups", migration0005], ["0006_rio_comps", migration0006], ["0007_absence_time", migration0007]];

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
  const admin = async (handler) => (await requireAdmin(request, env)) || handler();

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
      // one statement at a time: ALTER TABLE … ADD COLUMN cannot be "IF NOT EXISTS", so a re-run reports "duplicate
      // column name" – that one is expected and skipped, anything else still throws
      const stmts = splitSql(sql);
      let skipped = 0;
      for (const s of stmts) {
        try { await env.DB.prepare(s).run(); }
        catch (e) { if (/duplicate column name/i.test(String(e && e.message))) skipped++; else throw e; }
      }
      applied.push({ name, statements: stmts.length, skipped });
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

  // ---- roster (worker/roster.js) + admin login
  if (path === "/api/admin/login" && method === "POST") return adminLogin(request, env);
  if (path === "/api/admin/check" && method === "GET") return admin(() => json({ ok: true }));
  if (path === "/api/roster" && method === "GET") return getRoster(env, ctx, url);
  if (path === "/api/roster.csv" && method === "GET") return getRosterCsv(env);
  if (path === "/api/roster" && method === "PUT") return admin(() => putRoster(request, env, ctx, url));

  // ---- absence (worker/absence.js)
  if (path === "/api/absence" && method === "POST") return postAbsence(request, env);
  if (path === "/api/absence" && method === "GET") return getAbsence(env, url);
  if (path === "/api/absence.csv" && method === "GET") return getAbsenceCsv(env, url);
  if (path === "/api/absence" && method === "DELETE") return admin(() => deleteAbsence(env, url));
  if (path === "/api/absence/import" && method === "POST") return admin(() => importAbsence(request, env));

  // ---- Flopik (worker/flopik.js)
  if (path === "/api/flopik/reports" && method === "GET") return flopik.getReports(env, ctx, url);
  if (path === "/api/flopik/reports" && method === "POST") return auth() || flopik.postReports(request, env, ctx, url);
  if (path === "/api/flopik/pulls" && method === "GET") return flopik.getPulls(env, ctx, url);
  if (path === "/api/flopik/pulls" && method === "POST") return auth() || flopik.postPull(request, env, ctx, url);
  if (path === "/api/flopik/pulls/parse" && method === "POST") return auth() || flopik.patchParse(request, env, ctx, url);
  if (path === "/api/flopik/refs" && method === "GET") return flopik.getRefs(env);
  if (path === "/api/flopik/refs" && method === "POST") return auth() || flopik.postRefs(request, env);
  if (path === "/api/flopik/refwin" && method === "GET") return flopik.getRefWindow(env, url);
  if (path === "/api/flopik/refresh" && method === "POST") return flopik.refresh(request, env);
  if (path === "/api/flopik/status" && method === "GET") return flopik.status(env, url);

  // ---- attendance (worker/attendance.js) + addon endpoints
  if (path === "/api/attendance" && method === "POST") return postAttendance(request, env);
  if (path === "/api/attendance" && method === "GET") return getAttendance(env, url);
  if (path === "/api/attendance.csv" && method === "GET") return getAttendanceCsv(env, url);
  if (path === "/api/attendance" && method === "DELETE") return admin(() => deleteAttendance(env, url));
  if (path === "/api/attendance" && method === "PATCH") return admin(() => patchAttendance(request, env));
  if (path === "/api/es" && method === "GET") return esEndpoint(env, url);

  // ---- boss lineups (worker/lineups.js)
  if (path === "/api/lineups" && method === "GET") return getLineups(env);
  if (path === "/api/lineups.csv" && method === "GET") return getLineupsCsv(env);
  if (path === "/api/lineups" && method === "PUT") return admin(() => putLineups(request, env));
  if (path === "/api/lineups/sync" && method === "POST") return admin(() => raidplan.sync(request, env));
  if (path === "/api/lineups/sync-result" && method === "POST") return auth() || raidplan.syncResult(request, env);
  if (path === "/api/lineups/sync-status" && method === "GET") return raidplan.syncStatus(env);

  // ---- meta sestavy: raider.io first-kill rosters (worker/comps.js)
  if (path === "/api/comps" && method === "GET") return comps.getComps(env, url);
  if (path === "/api/comps" && method === "POST") return auth() || comps.postComps(request, env);
  if (path === "/api/comps/refresh" && method === "POST") return admin(() => comps.refresh(request, env));
  if (path === "/api/comps/status" && method === "GET") return comps.status(env);

  return json({ ok: false, error: "not found" }, 404);
}
