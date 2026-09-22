// Attendance (Docházka) from the ES Attendance addon – tables attendance_days + attendance (0005).
//   POST /api/attendance             { record: "ESA1;2026-09-16;20:05;Hráč=1:Postava;Hráč=0;…;?=Neznámý", pw? }
//                                    auth = Bearer API_TOKEN or the admin login token (paste form on attendance.html).
//                                    A second record for the same day overwrites the first.
//   GET  /api/attendance?from&to     { days: [{ date, time, unknown }], players: [...], marks: { date: { player: { state, char } } } }
//                                    state = ano | ne | omluvenka (absent + absence X that day) | pozdě (absent + "přijdu pozdě")
//   GET  /api/attendance.csv         the old sheet layout ("Hráč", "16.9.2026 (19:13)", … / ano, ne, omluvenka, pozdě)
//   DELETE /api/attendance?date=     (admin)
//   PATCH  /api/attendance           (admin) { changes: [{ date, player, state: ano | ne | omluvenka | pozdě | "" }] } – cell edits from
//                                    attendance.html: upserts the attendance row ("" deletes it); omluvenka / pozdě also upsert the
//                                    player's absence for that day (source admin), ne deletes it, ano leaves absences alone.
//   GET  /api/es?p=esroster[&raw=1]  roster text for the addon's /esa import (ESROSTER;version + Hráč;char;class;role;alt;class;role);
//        /api/es?p=attendance        → the attendance page (the addon prints both URLs; set /esa url https://…/api/es in game)

import { json, nameKey, nowIso, csvLine, CORS, todayPrague, addDays, requireAdmin, whenText } from "./lib.js";
import { loadRoster, flatRoster } from "./roster.js";

const HEADER = "ESA1";
const STATE_LABEL = { absent: "omluvenka", late: "pozdě" };

/** Port of parseAttendanceRecord_ – "ESA1;date;time;Name=1:Char;Name=0;…;?=Unknown" (";" or "|" separated). */
export function parseRecord(text) {
  const parts = String(text || "").trim().split(/[;|]/);
  if (parts.length < 4 || parts[0].trim() !== HEADER) throw new Error(`Neplatný řetězec – čekám „${HEADER};datum;čas;Hráč=1;…“ z addonu (/esa → Zapsat docházku).`);
  const date = parts[1].trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date + "T00:00:00Z"))) throw new Error(`Neplatné datum „${parts[1]}“.`);
  const time = String(parts[2] || "").trim();
  if (!/^\d{1,2}:\d{2}$/.test(time)) throw new Error(`Neplatný čas „${time}“.`);
  const players = [], unknown = [];
  for (let i = 3; i < parts.length; i++) {
    const seg = parts[i].trim();
    if (!seg) continue;
    if (seg.indexOf("?=") === 0) { unknown.push(seg.slice(2)); continue; }
    const m = /^(.*?)=([01])(?::(.*))?$/.exec(seg);
    if (!m) throw new Error(`Nerozumím části „${seg}“.`);
    players.push({ name: m[1].trim(), present: m[2] === "1", char: (m[3] || "").trim() });
  }
  if (!players.length) throw new Error("Řetězec neobsahuje žádného hráče.");
  return { date, time, players, unknown };
}

async function allowed(request, env) {
  return !(await requireAdmin(request, env));
}

export async function postAttendance(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, message: "⚠ Tělo požadavku musí být JSON." }, 400); }
  if (!(await allowed(request, env))) return json({ ok: false, message: "⚠ Zápis docházky vyžaduje přihlášení raid leadera (vpravo nahoře)." }, 401);
  let rec;
  try { rec = parseRecord(body.record); } catch (e) { return json({ ok: false, message: "⚠ " + e.message }); }
  const roster = await loadRoster(env);
  const byKey = new Map(roster.map((p) => [nameKey(p.name), p.name]));
  const now = nowIso();
  const stmts = [
    env.DB.prepare("DELETE FROM attendance_days WHERE date = ?1").bind(rec.date),
    env.DB.prepare("INSERT INTO attendance_days (date, time, unknown, source, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(rec.date, rec.time, JSON.stringify(rec.unknown), body.source || "addon", now),
  ];
  let present = 0, absent = 0, notInRoster = [];
  const seen = new Set();
  for (const p of rec.players) {
    const key = nameKey(p.name);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = byKey.get(key) || p.name;
    if (!byKey.has(key)) notInRoster.push(p.name);
    if (p.present) present++; else absent++;
    stmts.push(env.DB.prepare("INSERT INTO attendance (day_id, player, player_key, present, character) VALUES ((SELECT id FROM attendance_days WHERE date = ?1), ?2, ?3, ?4, ?5)")
      .bind(rec.date, name, key, p.present ? 1 : 0, p.char));
  }
  await env.DB.batch(stmts);
  const [y, m, d] = rec.date.split("-").map(Number);
  let message = `✔ Docházka ${d}.${m}.${y} (${rec.time}) zapsána: ${present} přítomných, ${absent} chybí`;
  if (rec.unknown.length) message += `, mimo roster v raidu: ${rec.unknown.join(", ")}`;
  if (notInRoster.length) message += `; hráči mimo roster v záznamu: ${notInRoster.join(", ")}`;
  return json({ ok: true, message, date: rec.date, time: rec.time, present, absent, unknown: rec.unknown });
}

async function matrix(env, url) {
  const today = todayPrague();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("from") || "") ? url.searchParams.get("from") : addDays(today, -120);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("to") || "") ? url.searchParams.get("to") : today;
  const [roster, days, rows, abs] = await Promise.all([
    loadRoster(env),
    env.DB.prepare("SELECT * FROM attendance_days WHERE date >= ?1 AND date <= ?2 ORDER BY date").bind(from, to).all().then((r) => r.results),
    env.DB.prepare("SELECT a.*, d.date FROM attendance a JOIN attendance_days d ON d.id = a.day_id WHERE d.date >= ?1 AND d.date <= ?2").bind(from, to).all().then((r) => r.results),
    env.DB.prepare("SELECT player_key, date, type FROM absences WHERE date >= ?1 AND date <= ?2").bind(from, to).all().then((r) => r.results),
  ]);
  const absMap = new Map(abs.map((a) => [`${a.player_key}|${a.date}`, a.type]));
  const marks = {};
  for (const r of rows) {
    let state = r.present ? "ano" : "ne";
    if (!r.present) { const t = absMap.get(`${r.player_key}|${r.date}`); if (t) state = STATE_LABEL[t] || state; }
    (marks[r.date] = marks[r.date] || {})[r.player] = { state, char: r.character };
  }
  const known = new Set(roster.map((p) => nameKey(p.name)));
  const extra = [];
  rows.forEach((r) => { if (!known.has(r.player_key) && !extra.includes(r.player)) extra.push(r.player); });
  return { from, to, roster, days: days.map((d) => ({ date: d.date, time: d.time, unknown: JSON.parse(d.unknown || "[]"), createdAt: d.created_at })), marks, extra };
}

export async function getAttendance(env, url) {
  const m = await matrix(env, url);
  return json({ ok: true, from: m.from, to: m.to, players: m.roster.map((p) => ({ name: p.name, bench: p.bench })), extra: m.extra, days: m.days, marks: m.marks });
}

export async function getAttendanceCsv(env, url) {
  const m = await matrix(env, url);
  const head = ["Hráč", ...m.days.map((d) => { const [y, mo, dd] = d.date.split("-").map(Number); return `${dd}.${mo}.${y} (${d.time})`; })];
  const names = m.roster.map((p) => p.name).concat(m.extra);
  const lines = [csvLine(head)];
  for (const n of names) lines.push(csvLine([n, ...m.days.map((d) => ((m.marks[d.date] || {})[n] || {}).state || "")]));
  return new Response(lines.join("\r\n") + "\r\n", { headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store", ...CORS } });
}

const PATCH_STATES = { ano: [1, null], ne: [0, "delete"], omluvenka: [0, "absent"], "pozdě": [0, "late"] };

export async function patchAttendance(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: "JSON body required" }, 400); }
  const changes = Array.isArray(body.changes) ? body.changes : [];
  if (!changes.length) return json({ ok: false, error: "changes[] required" }, 400);
  const roster = await loadRoster(env);
  const byKey = new Map(roster.map((p) => [nameKey(p.name), p.name]));
  const days = new Map((await env.DB.prepare("SELECT id, date FROM attendance_days").all()).results.map((d) => [d.date, d.id]));
  const now = nowIso();
  const stmts = [];
  for (const c of changes) {
    const date = String(c.date || ""), player = String(c.player || "").trim(), st = String(c.state || "");
    if (!days.has(date)) return json({ ok: false, error: `Den ${date} v docházce není.` }, 400);
    if (!player) return json({ ok: false, error: "player required" }, 400);
    if (st && !PATCH_STATES[st]) return json({ ok: false, error: `Neznámý stav „${st}“.` }, 400);
    const key = nameKey(player), name = byKey.get(key) || player, dayId = days.get(date);
    if (!st) { stmts.push(env.DB.prepare("DELETE FROM attendance WHERE day_id = ?1 AND player_key = ?2").bind(dayId, key)); continue; }
    const [present, abs] = PATCH_STATES[st];
    stmts.push(env.DB.prepare(`INSERT INTO attendance (day_id, player, player_key, present, character) VALUES (?1, ?2, ?3, ?4, '')
      ON CONFLICT(day_id, player_key) DO UPDATE SET present = excluded.present, player = excluded.player`).bind(dayId, name, key, present));
    if (abs === "delete") stmts.push(env.DB.prepare("DELETE FROM absences WHERE player_key = ?1 AND date = ?2").bind(key, date));
    else if (abs) stmts.push(env.DB.prepare(`INSERT INTO absences (player, player_key, date, type, source, created_at) VALUES (?1, ?2, ?3, ?4, 'admin', ?5)
      ON CONFLICT(player_key, date) DO UPDATE SET type = excluded.type, source = excluded.source`).bind(name, key, date, abs, now));
  }
  await env.DB.batch(stmts);
  return json({ ok: true, changed: changes.length });
}

export async function deleteAttendance(env, url) {
  const date = url.searchParams.get("date") || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ ok: false, error: "date required" }, 400);
  const res = await env.DB.prepare("DELETE FROM attendance_days WHERE date = ?1").bind(date).run();
  return json({ ok: true, deleted: (res.meta && res.meta.changes) || 0 });
}

// ------------------------------------------------------------------ addon ----

export async function esRosterText(env) {
  const flat = flatRoster(await loadRoster(env));
  const lines = ["ESROSTER;" + whenText().replace(/^(\d+)\.(\d+)\. /, (m, d, mo) => `${new Date().getUTCFullYear()}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")} `)];
  for (const p of flat) {
    const parts = [p.player, p.main, p.mainClass, p.mainRole];
    if (p.alt) parts.push(p.alt, p.altClass, p.altRole);
    lines.push(parts.join(";"));
  }
  return lines.join("\n");
}

/** /api/es?p=esroster|attendance – the two URLs the addon derives from its base URL. */
export async function esEndpoint(env, url) {
  const p = url.searchParams.get("p") || "";
  if (p === "attendance") return Response.redirect(new URL("/attendance", url.origin).toString(), 302);
  if (p !== "esroster") return json({ ok: false, error: "use ?p=esroster or ?p=attendance" }, 400);
  const text = await esRosterText(env);
  if (url.searchParams.get("raw")) return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...CORS } });
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const html = `<!DOCTYPE html><html lang="cs"><head><meta charset="utf-8"><title>Roster pro ES Attendance</title>
<style>body{background:#0a0c0b;color:#e4eae6;font-family:Inter,Segoe UI,sans-serif;padding:1.25rem;max-width:44rem;margin:auto}
h1{color:#3fd68a;font-size:1.2rem}textarea{width:100%;height:16rem;background:#111413;color:#e4eae6;border:1px solid #242a27;border-radius:6px;padding:.5rem;font:12px Consolas,monospace}
button{background:#3fd68a;color:#07110c;border:0;border-radius:999px;padding:.6rem 1.2rem;font-weight:700;cursor:pointer}#s{color:#8b968f;margin-left:.6rem}</style></head><body>
<h1>Roster pro addon ES Attendance</h1><p>Text se zkopíroval do schránky – ve hře <code>/esa import</code> a Ctrl+V. Když ne, klikni na Kopírovat.</p>
<textarea id="t" readonly>${esc(text)}</textarea><p><button id="c">Kopírovat</button><span id="s"></span></p>
<script>var t=document.getElementById("t"),s=document.getElementById("s");function cp(){t.select();var ok=false;try{ok=document.execCommand("copy")}catch(e){}
if(navigator.clipboard)navigator.clipboard.writeText(t.value).then(function(){s.textContent="zkopírováno"});else s.textContent=ok?"zkopírováno":"označ text a Ctrl+C"}
document.getElementById("c").onclick=cp;cp();</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
