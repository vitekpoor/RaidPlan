// RaidPlan.io sync of the boss lineups – runs tools/raidplan/raidplan.py --boss in GitHub Actions (raidplan.yml).
//
//   POST /api/lineups/sync         (admin) { bosses: "all" | ["02","05"], changes: "Akka-Meslock, Miky=Hase", dryRun, reason }
//                                  → workflow_dispatch; deduped while a run is in progress (2 min without a result)
//   POST /api/lineups/sync-result  (auth, from the runner) { ok, exitCode, log, bosses, changes, dryRun, startedAt, finishedAt, runUrl }
//   GET  /api/lineups/sync-status  { dispatch: { at, bosses, changes, dryRun } | null, result: {…} | null, running }
// State lives in the `meta` table (keys raidplan_sync_dispatch / raidplan_sync_result).

import { json, nowIso } from "./lib.js";
import { BOSSES } from "./lineups.js";

const WORKFLOW = "raidplan.yml";
const GITHUB_REPO_DEFAULT = "vitekpoor/RaidPlan";
const DEDUPE_MS = 2 * 60000;
const RUNNING_MS = 15 * 60000;
const MAX_LOG = 60000;

async function metaGet(env, key) {
  const r = await env.DB.prepare("SELECT value FROM meta WHERE key = ?1").bind(key).first();
  if (!r) return null;
  try { return JSON.parse(r.value); } catch (e) { return null; }
}
async function metaSet(env, key, value) {
  const now = nowIso();
  await env.DB.prepare("INSERT INTO meta (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3").bind(key, JSON.stringify(value), now).run();
}

/** "Akka-Meslock, Miky=Hase" → cleaned string (letters incl. diacritics, digits, swap/rename separators). */
function cleanChanges(s) {
  return String(s || "").replace(/[\r\n;]+/g, ",").replace(/[^\p{L}\p{N} \-=~+:<>,'"()\[\]x]/gu, "").replace(/\s*,\s*/g, ", ").replace(/^,\s*|,\s*$/g, "").trim().slice(0, 500);
}

export async function syncStatus(env) {
  const dispatch = await metaGet(env, "raidplan_sync_dispatch");
  const result = await metaGet(env, "raidplan_sync_result");
  const running = !!dispatch && Date.now() - Date.parse(dispatch.at) < RUNNING_MS && (!result || !result.finishedAt || result.finishedAt < dispatch.at);
  return json({ ok: true, dispatch, result, running });
}

export async function sync(request, env) {
  let body = {};
  try { body = await request.json(); } catch (e) { /* empty */ }
  if (!env.GITHUB_TOKEN) return json({ ok: false, error: "runner není napojený (Worker secret GITHUB_TOKEN)" }, 503);
  const known = new Set(BOSSES.map((b) => b[0]));
  let bosses = body.bosses;
  if (!bosses || bosses === "all") bosses = ["all"];
  if (!Array.isArray(bosses)) bosses = String(bosses).split(/[\s,;]+/).filter(Boolean);
  bosses = bosses.map((b) => (String(b).toLowerCase() === "all" ? "all" : String(b).padStart(2, "0")));
  if (!bosses.length) return json({ ok: false, error: "vyber aspoň jednoho bosse" }, 400);
  for (const b of bosses) if (b !== "all" && !known.has(b)) return json({ ok: false, error: `neznámý boss ${b}` }, 400);
  if (bosses.includes("all")) bosses = ["all"];
  const changes = cleanChanges(body.changes);
  const dryRun = !!body.dryRun;

  const dispatch = await metaGet(env, "raidplan_sync_dispatch");
  const result = await metaGet(env, "raidplan_sync_result");
  if (dispatch && Date.now() - Date.parse(dispatch.at) < DEDUPE_MS && (!result || !result.finishedAt || result.finishedAt < dispatch.at)) {
    return json({ ok: true, dispatched: false, dispatch, message: "synchronizace už běží – počkej na výsledek" });
  }
  const repo = env.GITHUB_REPO || GITHUB_REPO_DEFAULT;
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json", "user-agent": "eternal-shadows-worker" },
    body: JSON.stringify({ ref: "main", inputs: { bosses: bosses.join(" "), changes, dry_run: dryRun ? "true" : "false", reason: String(body.reason || "lineups page").slice(0, 80) } }),
  });
  if (r.status !== 204) return json({ ok: false, error: `GitHub API HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` }, 502);
  const rec = { at: nowIso(), bosses, changes, dryRun };
  await metaSet(env, "raidplan_sync_dispatch", rec);
  return json({ ok: true, dispatched: true, dispatch: rec, message: dryRun ? "náhled spuštěn v GitHub Actions – výsledek za ~1 minutu" : "synchronizace spuštěna v GitHub Actions – výsledek za ~1 minutu" });
}

export async function syncResult(request, env) {
  let b;
  try { b = await request.json(); } catch (e) { return json({ ok: false, error: "invalid JSON" }, 400); }
  const rec = {
    ok: !!b.ok, exitCode: Number(b.exitCode) || 0,
    log: String(b.log || "").slice(0, MAX_LOG),
    bosses: Array.isArray(b.bosses) ? b.bosses.map(String).slice(0, 20) : [],
    changes: Array.isArray(b.changes) ? b.changes.map(String).slice(0, 50) : [],
    dryRun: !!b.dryRun, reason: String(b.reason || "").slice(0, 80),
    startedAt: b.startedAt || null, finishedAt: b.finishedAt || nowIso(), runUrl: String(b.runUrl || "").slice(0, 300),
  };
  await metaSet(env, "raidplan_sync_result", rec);
  return json({ ok: true });
}
