// Boss lineups (Boss sestavy) – table lineups (0005): one row per boss with the raid date and 20 player slots.
//   GET /api/lineups        { bosses: [{ no, name, planView, guideUrl, date, slots: [20 names], updatedAt }], size }
//   PUT /api/lineups        (admin) { bosses: [{ no, date, slots, planView? }] } – bosses not sent are left as they are
//   GET /api/lineups.csv    the old sheet layout (Boss / Odkazy / Datum / Hráčů / blank / 1..20) read by
//                           tools/raidplan/raidplan.py --boss and tools/attendance/attendance.py
// Absence colouring for the page comes from /api/absence; nothing else depends on the sheet tab any more.

import { json, nowIso, csvLine, CORS } from "./lib.js";

export const LINEUP_SIZE = 20;
export const GUIDE_URL = "https://eternal-shadows.vitek-poor.workers.dev/raid";
export const BOSSES = [
  ["01", "Nek'zali", "https://raidplan.io/plan/egs7gyaq69pg7xhs", "boss-1"],
  ["02", "Sentinels", "https://raidplan.io/plan/xtxvjvkrhxhh2bfs", "boss-2"],
  ["03", "Vashnik", "https://raidplan.io/plan/q8pqzrw3vf5p3q6c", "boss-3"],
  ["04", "Explorers", "https://raidplan.io/plan/w22burzhsdzwbhf4", "boss-4"],
  ["05", "Sszorak", "https://raidplan.io/plan/uaqafdx6g3bp6g79", "boss-5"],
  ["06", "Twin Fangs", "https://raidplan.io/plan/u7tdr98jetxpk3sd", "boss-6"],
  ["07", "Coiled Altar", "https://raidplan.io/plan/v2p7xuwgtbauzh3k", "boss-7"],
  ["08", "Ula'tek", "https://raidplan.io/plan/v3u4qp9jugsdyzys", "boss-8"],
  ["09", "Nymrissa", "https://raidplan.io/plan/g4skqtr53vrsx467", "boss-9"],
];
const CZ_DAYS = ["ne", "po", "út", "st", "čt", "pá", "so"];

export async function loadLineups(env) {
  const rows = (await env.DB.prepare("SELECT * FROM lineups").all()).results;
  const byNo = new Map(rows.map((r) => [r.boss_no, r]));
  return BOSSES.map(([no, name, plan, anchor]) => {
    const r = byNo.get(no) || {};
    let slots = [];
    try { slots = JSON.parse(r.slots || "[]"); } catch (e) { slots = []; }
    slots = slots.slice(0, LINEUP_SIZE).map((s) => String(s || ""));
    while (slots.length < LINEUP_SIZE) slots.push("");
    return { no, name, planView: r.plan_view || plan, guideUrl: `${GUIDE_URL}#${anchor}`, date: r.date || "", slots, updatedAt: r.updated_at || null };
  });
}

export async function getLineups(env) {
  const bosses = await loadLineups(env);
  let updated = null;
  bosses.forEach((b) => { if (b.updatedAt && (!updated || b.updatedAt > updated)) updated = b.updatedAt; });
  return json({ ok: true, size: LINEUP_SIZE, updated, bosses }, 200, { "cache-control": "public, max-age=0, s-maxage=30" });
}

export async function putLineups(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: "body must be JSON" }, 400); }
  const list = Array.isArray(body.bosses) ? body.bosses : [];
  const known = new Map(BOSSES.map((b) => [b[0], b]));
  const stmts = [], now = nowIso();
  for (const b of list) {
    const no = String(b.no || "").padStart(2, "0");
    if (!known.has(no)) return json({ ok: false, error: `unknown boss ${b.no}` }, 400);
    const date = String(b.date || "").trim();
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ ok: false, error: `${no}: date must be yyyy-mm-dd` }, 400);
    const slots = (Array.isArray(b.slots) ? b.slots : []).slice(0, LINEUP_SIZE).map((s) => String(s || "").trim());
    while (slots.length < LINEUP_SIZE) slots.push("");
    const plan = b.planView != null ? String(b.planView).trim() : known.get(no)[2];
    stmts.push(env.DB.prepare(
      `INSERT INTO lineups (boss_no, boss, plan_view, date, slots, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(boss_no) DO UPDATE SET boss = excluded.boss, plan_view = excluded.plan_view, date = excluded.date, slots = excluded.slots, updated_at = excluded.updated_at`
    ).bind(no, known.get(no)[1], plan, date, JSON.stringify(slots), now));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, bosses: stmts.length });
}

function czDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00Z");
  const [y, m, dd] = iso.split("-").map(Number);
  return `${CZ_DAYS[d.getUTCDay()]} ${dd}.${m}.${y}`;
}

export async function getLineupsCsv(env) {
  const bosses = await loadLineups(env);
  const lines = [
    csvLine(["Boss", ...bosses.map((b) => `${b.no} ${b.name}`)]),
    csvLine(["Odkazy", ...bosses.map((b) => `Plán ${b.planView}  Taktika ${b.guideUrl}`)]),
    csvLine(["Datum", ...bosses.map((b) => czDate(b.date))]),
    csvLine(["Hráčů", ...bosses.map((b) => `${b.slots.filter(Boolean).length} / ${LINEUP_SIZE}`)]),
    csvLine(["", ...bosses.map(() => "")]),
  ];
  for (let i = 0; i < LINEUP_SIZE; i++) lines.push(csvLine([String(i + 1), ...bosses.map((b) => b.slots[i] || "")]));
  return new Response(lines.join("\r\n") + "\r\n", { headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store", ...CORS } });
}
