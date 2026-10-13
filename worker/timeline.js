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

import { json, nowIso, CORS } from "./lib.js";

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
