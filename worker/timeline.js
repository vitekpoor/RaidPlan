// Boss timelines (timeline.html) – table timelines (0009): one JSON document per boss (lorrgs.io slug).
// The document is built in the browser: for every class spec the casts of the top mythic parse from
// lorrgs.io (api2.lorrgs.io/api/spec_ranking/<spec>/<boss>) plus the boss casts / phases of a reference kill,
// then edited by the admin (casts moved in time, added, removed, custom abilities, hidden lanes).
//   GET /api/timeline                 { ok, bosses: [{ boss, rows, updatedAt }] }   what is stored
//   GET /api/timeline?boss=<slug>     { ok, boss, data | null, updatedAt | null }
//   PUT /api/timeline  (admin)        { boss, data } – replaces the whole document (≤ 1.5 MB)
//   DELETE /api/timeline?boss=<slug> (admin)
//   GET /api/timeline/lorrgs?p=<lorrgs api path>   read-only proxy of api2.lorrgs.io (its CORS header is unreliable
//                                     from a browser – CloudFront caches responses with/without it). Only the three
//                                     paths the page needs are allowed; 10 min memo in the isolate + Cloudflare cache.
//   GET /api/timeline/raidplan?boss=<lineup no "08">   the note of the boss's RaidPlan.io plan (plan link from the lineups,
//                                     raidplan.io/api/plan/<code> → doc_url JSON: header_notes_raw / step_notes_raw / footer_notes_raw)
//                                     for the NSRT export (raidplan.io sends no CORS header). 60 s memo + Cloudflare cache.

import { json, nowIso, CORS } from "./lib.js";
import { loadLineups } from "./lineups.js";

const LORRGS = "https://api2.lorrgs.io";
const LORRGS_PATHS = [/^\/api\/spec_ranking\/[a-z0-9-]+\/[a-z0-9-]+$/, /^\/api\/specs\/[a-z0-9-]+\/spells$/, /^\/api\/bosses\/[a-z0-9-]+\/spells$/];
const LORRGS_TTL = 10 * 60 * 1000;
const lorrgsMemo = new Map(); // target url → { at, text }

export async function lorrgsProxy(env, url) {
  const p = url.searchParams.get("p") || "";
  const i = p.indexOf("?");
  const path = i < 0 ? p : p.slice(0, i), qs = new URLSearchParams(i < 0 ? "" : p.slice(i + 1));
  if (!LORRGS_PATHS.some((re) => re.test(path))) return json({ ok: false, error: "path not allowed" }, 400);
  const q = new URLSearchParams();
  for (const k of ["difficulty", "metric"]) { const v = qs.get(k); if (v && /^[a-z]+$/.test(v)) q.set(k, v); }
  const target = LORRGS + path + (q.toString() ? "?" + q.toString() : "");
  const hit = lorrgsMemo.get(target);
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=600", ...CORS };
  if (hit && Date.now() - hit.at < LORRGS_TTL) return new Response(hit.text, { headers: { ...headers, "x-memo": "hit" } });
  const r = await fetch(target, { headers: { "user-agent": "eternal-shadows timeline (+https://eternal-shadows.vitek-poor.workers.dev)", accept: "application/json" }, cf: { cacheTtl: 600, cacheEverything: true } });
  if (!r.ok) return json({ ok: false, error: `lorrgs ${r.status}` }, 502);
  const text = await r.text();
  if (lorrgsMemo.size > 120) lorrgsMemo.delete(lorrgsMemo.keys().next().value);
  lorrgsMemo.set(target, { at: Date.now(), text });
  return new Response(text, { headers });
}

const SLUG = /^[a-z0-9-]{3,60}$/;
const MAX_BYTES = 1.5 * 1024 * 1024;

export async function getTimeline(env, url) {
  const boss = (url.searchParams.get("boss") || "").trim();
  if (!boss) {
    const rows = (await env.DB.prepare("SELECT boss_slug, updated_at, length(data) AS bytes, data FROM timelines ORDER BY boss_slug").all()).results;
    return json({
      ok: true,
      bosses: rows.map((r) => {
        let n = 0;
        try { n = (JSON.parse(r.data).rows || []).length; } catch (e) { /* ignore */ }
        return { boss: r.boss_slug, rows: n, bytes: r.bytes, updatedAt: r.updated_at };
      }),
    });
  }
  if (!SLUG.test(boss)) return json({ ok: false, error: "bad boss slug" }, 400);
  const r = await env.DB.prepare("SELECT data, updated_at FROM timelines WHERE boss_slug = ?1").bind(boss).first();
  if (!r) return json({ ok: true, boss, data: null, updatedAt: null });
  let data = null;
  try { data = JSON.parse(r.data); } catch (e) { data = null; }
  return json({ ok: true, boss, data, updatedAt: r.updated_at });
}

export async function putTimeline(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: "body must be JSON" }, 400); }
  const boss = String(body.boss || "").trim();
  if (!SLUG.test(boss)) return json({ ok: false, error: "bad boss slug" }, 400);
  const data = body.data;
  if (!data || typeof data !== "object" || !Array.isArray(data.rows)) return json({ ok: false, error: "data.rows must be an array" }, 400);
  data.boss = boss;
  const text = JSON.stringify(data);
  if (text.length > MAX_BYTES) return json({ ok: false, error: `document too large (${text.length} B)` }, 413);
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO timelines (boss_slug, data, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(boss_slug) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).bind(boss, text, now).run();
  return json({ ok: true, boss, rows: data.rows.length, bytes: text.length, updatedAt: now });
}

export async function deleteTimeline(env, url) {
  const boss = (url.searchParams.get("boss") || "").trim();
  if (!SLUG.test(boss)) return json({ ok: false, error: "bad boss slug" }, 400);
  const r = await env.DB.prepare("DELETE FROM timelines WHERE boss_slug = ?1").bind(boss).run();
  return json({ ok: true, boss, deleted: r.meta ? r.meta.changes : undefined });
}

const RAIDPLAN_TTL = 60 * 1000;
const raidplanMemo = new Map(); // plan code → { at, body }
const RP_HEADERS = { "user-agent": "eternal-shadows timeline (+https://eternal-shadows.vitek-poor.workers.dev)", accept: "application/json" };

/** Note of the boss's RaidPlan.io plan: { ok, boss, code, name, revision, savedAt, header, steps: [{ step, note }], footer, singleNote, text } */
export async function raidplanNote(env, url) {
  const boss = (url.searchParams.get("boss") || "").trim().padStart(2, "0");
  const lineup = (await loadLineups(env)).find((b) => b.no === boss);
  if (!lineup) return json({ ok: false, error: "unknown boss" }, 400);
  const m = /raidplan\.io\/plan\/([a-z0-9]+)/.exec(lineup.planView || "");
  if (!m) return json({ ok: false, error: "boss has no RaidPlan link" }, 404);
  const code = m[1];
  const hit = raidplanMemo.get(code);
  if (hit && Date.now() - hit.at < RAIDPLAN_TTL) return json(hit.body);
  const mr = await fetch(`https://raidplan.io/api/plan/${code}`, { headers: RP_HEADERS, cf: { cacheTtl: 60 } });
  if (!mr.ok) return json({ ok: false, error: `raidplan.io ${mr.status}` }, 502);
  const plan = ((await mr.json()) || {}).plan || {};
  if (!plan.doc_url) return json({ ok: false, error: "raidplan.io: plan has no doc_url" }, 502);
  const dr = await fetch(plan.doc_url, { headers: RP_HEADERS, cf: { cacheTtl: 60 } });
  if (!dr.ok) return json({ ok: false, error: `raidplan.io doc ${dr.status}` }, 502);
  const doc = (await dr.json()) || {};
  const clean = (t) => String(t || "").replace(/\r/g, "").trim();
  const header = clean(doc.header_notes_raw), footer = clean(doc.footer_notes_raw);
  const steps = (Array.isArray(doc.step_notes_raw) ? doc.step_notes_raw : []).map((n, i) => ({ step: i + 1, note: clean(n) })).filter((x) => x.note);
  const singleNote = !!doc.single_note;
  const parts = [header].concat(singleNote ? [] : steps.map((x) => x.note), [footer]).filter(Boolean);
  const body = { ok: true, boss, code, name: plan.name || "", title: plan.title || "", revision: plan.revision || doc.revision || 0, savedAt: plan.time_saved || null,
    url: `https://raidplan.io/plan/${code}`, header, steps, footer, singleNote, text: parts.join("\n\n") };
  if (raidplanMemo.size > 30) raidplanMemo.delete(raidplanMemo.keys().next().value);
  raidplanMemo.set(code, { at: Date.now(), body });
  return json(body);
}
