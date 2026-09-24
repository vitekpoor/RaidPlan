// Absences (Omluvenky) – table absences (0003). One row per player + day; the latest report of a day wins.
//   POST   /api/absence              { player, from: "yyyy-mm-dd", to?, type: "Nepřijdu" | "Přijdu pozdě" | absent | late }  (public form)
//   GET    /api/absence?from&to      { players: [names in roster order], marks: [{ id, player, date, type, mark }], from, to }
//   GET    /api/absence.csv?from&to  matrix like the old "Absence přehled" tab: "Hráč", one ISO-date column per day in range,
//                                    cells "X" (absent) / "pozdě" (late) – read by tools/attendance/attendance.py and the Apps Script
//   DELETE /api/absence?id=N | ?player&date   (admin) remove a wrong entry
//   POST   /api/absence/import       (admin) { marks: [{ player, date, type }] } – one-time import, replaces everything

import { json, nameKey, nowIso, csvLine, CORS, todayPrague, addDays } from "./lib.js";
import { loadRoster } from "./roster.js";

const MAX_DAYS = 62;
const TYPES = { "nepřijdu": "absent", "přijdu pozdě": "late", absent: "absent", late: "late", x: "absent", "pozdě": "late" };
const MARK = { absent: "X", late: "pozdě" };
const LABEL = { absent: "Nepřijdu", late: "Přijdu dýl" };   // form confirmation text (the type keys / CSV mark "pozdě" stay)

function isoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !isNaN(Date.parse(s + "T00:00:00Z")) ? s : null;
}

export async function postAbsence(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, message: "⚠ Tělo požadavku musí být JSON." }, 400); }
  const player = String(body.player || "").trim();
  const type = TYPES[String(body.type || "").trim().toLowerCase()];
  const from = isoDate(body.from), to = body.to ? isoDate(body.to) : from;
  if (!player) return json({ ok: false, message: "⚠ Vyber hráče." });
  if (!from) return json({ ok: false, message: "⚠ Vyber datum Od." });
  if (body.to && !to) return json({ ok: false, message: "⚠ Datum Do není platné." });
  if (!type) return json({ ok: false, message: "⚠ Vyber typ absence." });
  const roster = await loadRoster(env);
  const hit = roster.find((p) => nameKey(p.name) === nameKey(player));
  if (!hit) return json({ ok: false, message: `⚠ Hráč '${player}' není v Rosteru.` });
  if (to < from) return json({ ok: false, message: "⚠ Datum Do je před datem Od." });
  const today = todayPrague();
  if (from < today) return json({ ok: false, message: `⚠ Datum v minulosti (${czDate(from)}) – hlásit jde jen dnešek a budoucí dny.` });
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  if (days > MAX_DAYS) return json({ ok: false, message: `⚠ Interval má ${days} dní – maximum je ${MAX_DAYS}. Zkontroluj datumy.` });
  const now = nowIso(), stmts = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    stmts.push(env.DB.prepare(
      `INSERT INTO absences (player, player_key, date, type, source, created_at) VALUES (?1, ?2, ?3, ?4, 'web', ?5)
       ON CONFLICT(player_key, date) DO UPDATE SET player = excluded.player, type = excluded.type, source = excluded.source, created_at = excluded.created_at`
    ).bind(hit.name, nameKey(hit.name), d, type, now));
  }
  await env.DB.batch(stmts);
  let range = czDate(from);
  if (days > 1) range += ` – ${czDate(to)} (${days} ${days >= 5 ? "dní" : "dny"})`;
  return json({ ok: true, message: `✔ Uloženo: ${hit.name} – ${range} – ${LABEL[type]}`, player: hit.name, from, to, type, days });
}

function czDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d}.${m}.${y}`;
}

function range(url) {
  const today = todayPrague();
  const from = isoDate(url.searchParams.get("from")) || addDays(today, -7);
  const to = isoDate(url.searchParams.get("to")) || addDays(today, 60);
  return { from, to: to < from ? from : to };
}

async function marksIn(env, from, to) {
  return (await env.DB.prepare("SELECT id, player, player_key, date, type, created_at FROM absences WHERE date >= ?1 AND date <= ?2 ORDER BY date, player_key")
    .bind(from, to).all()).results;
}

export async function getAbsence(env, url) {
  const { from, to } = range(url);
  const [roster, rows] = await Promise.all([loadRoster(env), marksIn(env, from, to)]);
  const marks = rows.map((r) => ({ id: r.id, player: r.player, date: r.date, type: r.type, mark: MARK[r.type], createdAt: r.created_at }));
  return json({ ok: true, from, to, today: todayPrague(), players: roster.map((p) => ({ name: p.name, bench: p.bench })), marks });
}

export async function getAbsenceCsv(env, url) {
  const { from, to } = range(url);
  const [roster, rows] = await Promise.all([loadRoster(env), marksIn(env, from, to)]);
  const dates = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  const byKey = new Map();
  rows.forEach((r) => byKey.set(`${r.player_key}|${r.date}`, MARK[r.type]));
  const names = roster.map((p) => p.name);
  rows.forEach((r) => { if (!names.some((n) => nameKey(n) === r.player_key)) names.push(r.player); });
  const lines = [csvLine(["Hráč", ...dates])];
  for (const n of names) lines.push(csvLine([n, ...dates.map((d) => byKey.get(`${nameKey(n)}|${d}`) || "")]));
  return new Response(lines.join("\r\n") + "\r\n", { headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store", ...CORS } });
}

export async function deleteAbsence(env, url) {
  const id = Number(url.searchParams.get("id"));
  const player = (url.searchParams.get("player") || "").trim(), date = isoDate(url.searchParams.get("date"));
  let res;
  if (id >= 1) res = await env.DB.prepare("DELETE FROM absences WHERE id = ?1").bind(id).run();
  else if (player && date) res = await env.DB.prepare("DELETE FROM absences WHERE player_key = ?1 AND date = ?2").bind(nameKey(player), date).run();
  else return json({ ok: false, error: "id or player+date required" }, 400);
  return json({ ok: true, deleted: (res.meta && res.meta.changes) || 0 });
}

export async function importAbsence(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: "body must be JSON" }, 400); }
  const marks = Array.isArray(body.marks) ? body.marks : [];
  const stmts = [env.DB.prepare("DELETE FROM absences")];
  let n = 0;
  for (const m of marks) {
    const type = TYPES[String((m && m.type) || "").trim().toLowerCase()], date = isoDate(m && m.date), player = String((m && m.player) || "").trim();
    if (!type || !date || !player) continue;
    stmts.push(env.DB.prepare("INSERT OR REPLACE INTO absences (player, player_key, date, type, source, created_at) VALUES (?1, ?2, ?3, ?4, 'sheet', ?5)")
      .bind(player, nameKey(player), date, type, m.createdAt || nowIso()));
    n++;
  }
  await env.DB.batch(stmts);
  return json({ ok: true, imported: n });
}
