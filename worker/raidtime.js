// Raid time – the weekly raid schedule, what is planned and who is missing (attendance.html "Raid time" tab),
// plus the Discord messages built from it: one whenever an absence is reported / removed (worker/absence.js)
// and the daily 18:00 report (Cron Trigger, replaces .github/workflows/weekly.yml whose GitHub cron fired hours late).
//
//   GET  /api/raidtime?offset=0          (public) the raid week (Wed→Tue, WoW reset) of the next raid day on/after today,
//                                        shifted by `offset` weeks: { ok, today, week: { from, to, label, current }, days: [{ date,
//                                        wd, day, start, end, plan, off, custom, missing: [{ player, type, time }] }], template, overrides }
//   PUT  /api/raidtime                   (admin) { template?: [{ wd 0-6, start, end, plan }], days?: [{ date, start, end, plan, off }],
//                                        remove?: [dates] } – template = meta key "raidtime", days = table raid_days (0008)
//   POST /api/raidtime/report[?dry=1]    (admin) post the report now (dry = only return the text)
//   GET  /api/raidtime/status            { lastReport, lastNotify, configured } (meta raidtime_report / raidtime_notify)
//
// Discord target: var DISCORD_ABSENCE_CHANNEL (channel id) + secret DISCORD_ABSENCE_WEBHOOK (webhook of that channel) or
// secret DISCORD_BOT_TOKEN – see worker/discord.js. Cron: wrangler.jsonc fires 16:00 and 17:00 UTC; the firing where it is
// 18:xx in Europe/Prague posts (meta raidtime_report.day keeps the other one from posting twice).

import { json, nameKey, nowIso, todayPrague, addDays, normTime } from "./lib.js";
import { loadRoster } from "./roster.js";
import { loadLineups } from "./lineups.js";
import { postDiscord } from "./discord.js";

const WEEK_START = 3;                                   // Wednesday (JS getDay: 0 = Sunday)
const DEFAULT_TEMPLATE = [{ wd: 3, start: "19:00", end: "23:00", plan: "" }, { wd: 4, start: "19:00", end: "23:00", plan: "" }, { wd: 0, start: "19:00", end: "23:00", plan: "" }];
const CZ_SHORT = ["ne", "po", "út", "st", "čt", "pá", "so"];
const CZ_LONG = ["neděle", "pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota"];
const LOOKAHEAD = 70;                                   // days searched for the next raid day
const MAX_PLAN = 200;

async function metaGet(env, key) {
  const r = await env.DB.prepare("SELECT value FROM meta WHERE key = ?1").bind(key).first();
  if (!r) return null;
  try { return JSON.parse(r.value); } catch (e) { return null; }
}
async function metaSet(env, key, value) {
  await env.DB.prepare("INSERT INTO meta (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3").bind(key, JSON.stringify(value), nowIso()).run();
}

export function wdOf(iso) { return new Date(iso + "T00:00:00Z").getUTCDay(); }
export function czDay(iso) { const [, m, d] = iso.split("-").map(Number); return `${CZ_SHORT[wdOf(iso)]} ${d}.${m}.`; }
export function czDayLong(iso) { const [, m, d] = iso.split("-").map(Number); return `${CZ_LONG[wdOf(iso)]} ${d}.${m}.`; }
export function czRange(from, to) {
  const [, fm, fd] = from.split("-").map(Number), [, tm, td] = to.split("-").map(Number);
  return fm === tm ? `${fd}.–${td}. ${fm}.` : `${fd}. ${fm}. – ${td}. ${tm}.`;
}
/** Raid week (Wed→Tue) containing `iso`. */
export function weekOf(iso) { const from = addDays(iso, -((wdOf(iso) - WEEK_START + 7) % 7)); return { from, to: addDays(from, 6) }; }

function cleanTemplate(list) {
  const out = [], seen = new Set();
  for (const t of Array.isArray(list) ? list : []) {
    const wd = Number(t && t.wd);
    if (!Number.isInteger(wd) || wd < 0 || wd > 6 || seen.has(wd)) continue;
    seen.add(wd);
    out.push({ wd, start: normTime(t.start) || "", end: normTime(t.end) || "", plan: String(t.plan || "").trim().slice(0, MAX_PLAN) });
  }
  return out.sort((a, b) => ((a.wd - WEEK_START + 7) % 7) - ((b.wd - WEEK_START + 7) % 7));
}

async function loadTemplate(env) {
  const m = await metaGet(env, "raidtime");
  return m && Array.isArray(m.template) ? cleanTemplate(m.template) : DEFAULT_TEMPLATE.slice();
}

async function loadOverrides(env, from, to) {
  const rows = (await env.DB.prepare("SELECT date, start, end, plan, off FROM raid_days WHERE date >= ?1 AND date <= ?2 ORDER BY date").bind(from, to).all()).results;
  return new Map(rows.map((r) => [r.date, { date: r.date, start: r.start || "", end: r.end || "", plan: r.plan || "", off: !!r.off }]));
}

/** Is `iso` a raid day (template weekday not cancelled, or an extra day)? */
function isRaidDay(iso, template, overrides) {
  const ov = overrides.get(iso);
  if (ov) return !ov.off;
  return template.some((t) => t.wd === wdOf(iso));
}

/** First raid day on/after `iso` (within LOOKAHEAD days), else `iso`. */
function nextRaidDay(iso, template, overrides) {
  for (let i = 0; i < LOOKAHEAD; i++) { const d = addDays(iso, i); if (isRaidDay(d, template, overrides)) return d; }
  return iso;
}

/**
 * The raid week around `anchor` (default today) shifted by `offset` weeks, with the days, their plan and who is missing.
 * The week is the one holding the next raid day on/after the anchor, so Tuesday already shows the reset week starting tomorrow.
 */
export async function raidWeek(env, { anchor, offset = 0 } = {}) {
  const today = todayPrague();
  anchor = anchor && anchor > today ? anchor : today;
  const template = await loadTemplate(env);
  const scan = await loadOverrides(env, addDays(anchor, -7), addDays(anchor, LOOKAHEAD + 7 * Math.abs(offset)));
  const base = weekOf(nextRaidDay(anchor, template, scan));
  const from = addDays(base.from, 7 * offset), to = addDays(from, 6);
  const [roster, abs] = await Promise.all([
    loadRoster(env),
    env.DB.prepare("SELECT player, player_key, date, type, time FROM absences WHERE date >= ?1 AND date <= ?2").bind(from, to).all().then((r) => r.results),
  ]);
  const overrides = await loadOverrides(env, from, to);
  const order = new Map(roster.map((p, i) => [nameKey(p.name), i]));
  const byDate = new Map();
  for (const a of abs) { if (!byDate.has(a.date)) byDate.set(a.date, []); byDate.get(a.date).push({ player: a.player, key: a.player_key, type: a.type, time: a.type === "late" ? a.time || null : null }); }
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const wd = wdOf(d), t = template.find((x) => x.wd === wd), ov = overrides.get(d);
    if (!t && !ov) continue;
    const missing = (byDate.get(d) || []).sort((a, b) => (order.has(a.key) ? order.get(a.key) : 999) - (order.has(b.key) ? order.get(b.key) : 999) || a.player.localeCompare(b.player, "cs"))
      .map((m) => ({ player: m.player, type: m.type, time: m.time }));
    days.push({ date: d, wd, day: czDayLong(d), start: (ov && ov.start) || (t && t.start) || "", end: (ov && ov.end) || (t && t.end) || "",
                plan: (ov && ov.plan) || (t && t.plan) || "", off: !!(ov && ov.off), custom: !t, missing });
  }
  return { today, week: { from, to, label: czRange(from, to), current: today >= from && today <= to }, days, template, overrides: [...overrides.values()] };
}

export async function getRaidtime(env, url) {
  const offset = Math.max(-52, Math.min(52, Number(url.searchParams.get("offset")) || 0));
  const w = await raidWeek(env, { offset });
  return json({ ok: true, ...w });
}

export async function putRaidtime(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: "body must be JSON" }, 400); }
  const stmts = [], now = nowIso();
  let template = null;
  if (Array.isArray(body.template)) {
    template = cleanTemplate(body.template);
    if (!template.length) return json({ ok: false, error: "aspoň jeden raidový den" }, 400);
    await metaSet(env, "raidtime", { template });
  }
  for (const d of Array.isArray(body.days) ? body.days : []) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String((d && d.date) || "")) ? d.date : null;
    if (!date) return json({ ok: false, error: `date must be yyyy-mm-dd (${d && d.date})` }, 400);
    stmts.push(env.DB.prepare(
      `INSERT INTO raid_days (date, start, end, plan, off, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(date) DO UPDATE SET start = excluded.start, end = excluded.end, plan = excluded.plan, off = excluded.off, updated_at = excluded.updated_at`
    ).bind(date, normTime(d.start) || "", normTime(d.end) || "", String(d.plan || "").trim().slice(0, MAX_PLAN), d.off ? 1 : 0, now));
  }
  for (const date of Array.isArray(body.remove) ? body.remove : []) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(date))) stmts.push(env.DB.prepare("DELETE FROM raid_days WHERE date = ?1").bind(date));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, template, days: stmts.length });
}

// ------------------------------------------------------------------ Discord text ----

const TYPE_TEXT = { absent: "nepřijde", late: "přijde dýl" };

/** The week overview (days, plan, who is missing, lineup hits of the missing players). Returns { text, mentionKeys, week }. */
export async function overviewText(env, { anchor, offset = 0 } = {}) {
  const w = await raidWeek(env, { anchor, offset });
  const lines = [`📅 **${w.week.current ? "TENTO TÝDEN" : "PŘÍŠTÍ TÝDEN"} · ${w.week.label.toUpperCase()}**`, ""];
  const missingKeys = new Set();
  if (!w.days.length) lines.push("• žádný raidový den");
  for (const d of w.days) {
    const when = d.start || d.end ? ` ${d.start}–${d.end}` : "";
    if (d.off) { lines.push(`• **${czDay(d.date)}** — ❌ zrušeno`); continue; }
    lines.push(`• **${czDay(d.date)}**${when}${d.plan ? ` — ${d.plan}` : ""}`);
    const absent = d.missing.filter((m) => m.type === "absent"), late = d.missing.filter((m) => m.type === "late");
    const parts = [];
    if (absent.length) parts.push("❌ " + absent.map((m) => m.player).join(", "));
    if (late.length) parts.push("⏰ " + late.map((m) => m.player + (m.time ? ` (${m.time})` : "")).join(", "));
    lines.push("  " + (parts.length ? parts.join(" · ") : "✅ nikdo nechybí"));
    d.missing.forEach((m) => missingKeys.add(nameKey(m.player)));
  }
  if (missingKeys.size) {
    try {
      const bosses = await loadLineups(env);
      const names = new Map();
      w.days.forEach((d) => d.missing.forEach((m) => names.set(nameKey(m.player), m.player)));
      const hits = [];
      for (const [key, name] of names) {
        const inB = bosses.filter((b) => b.slots.some((s) => nameKey(s.replace(/\s*\([^)]*\)\s*$/, "")) === key)).map((b) => b.name);
        hits.push(`• ${name} — ${inB.length === 0 ? "žádný boss" : inB.length >= bosses.length ? "všichni bossové" : inB.join(", ")}`);
      }
      if (hits.length) lines.push("", "🧩 **V SESTAVĚ**", ...hits);
    } catch (e) { lines.push("", `(sestavy nezkontrolovány: ${String((e && e.message) || e).slice(0, 80)})`); }
  }
  return { text: lines.join("\n"), mentionKeys: [...missingKeys], week: w.week };
}

async function mentionIds(env, keys) {
  if (!keys.length) return [];
  const rows = (await env.DB.prepare("SELECT player_key, user_id FROM discord_rooms WHERE user_id <> ''").all()).results;
  const want = new Set(keys);
  return rows.filter((r) => want.has(r.player_key)).map((r) => String(r.user_id).replace(/\D/g, "")).filter(Boolean);
}

async function send(env, text, mentions) {
  return postDiscord(env, { webhook: env.DISCORD_ABSENCE_WEBHOOK, channelId: env.DISCORD_ABSENCE_CHANNEL, text, mentions });
}

/** Daily report text (the old attendance.py message, now built here). */
export async function reportText(env) {
  const o = await overviewText(env, {});
  return { text: ["📋 **DOCHÁZKA NA RAID**", "━━━━━━━━━━━━━━━━━━━━", "", o.text].join("\n"), mentionKeys: o.mentionKeys };
}

/** POST /api/raidtime/report[?dry=1] (admin). */
export async function postReport(env, url) {
  const dry = url.searchParams.get("dry") === "1";
  const { text, mentionKeys } = await reportText(env);
  if (dry) return json({ ok: true, dry: true, text });
  try {
    const via = await send(env, text, await mentionIds(env, mentionKeys));
    const rec = { day: todayPrague(), at: nowIso(), via, manual: true };
    await metaSet(env, "raidtime_report", rec);
    return json({ ok: true, ...rec, text });
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e), text }, 502);
  }
}

export async function status(env) {
  const [lastReport, lastNotify] = await Promise.all([metaGet(env, "raidtime_report"), metaGet(env, "raidtime_notify")]);
  return json({ ok: true, lastReport, lastNotify, channel: String(env.DISCORD_ABSENCE_CHANNEL || ""), configured: !!(env.DISCORD_ABSENCE_WEBHOOK || env.DISCORD_BOT_TOKEN) });
}

/**
 * Discord message after an absence changed – called from worker/absence.js via ctx.waitUntil.
 * change = { action: "new" | "removed", player, from, to, type, time, days }.
 */
export async function notifyAbsenceChange(env, change) {
  const rec = { at: nowIso(), action: change.action, player: change.player, from: change.from, to: change.to || change.from };
  try {
    let head;
    const range = change.to && change.to !== change.from ? `${czDay(change.from)} – ${czDay(change.to)} (${change.days} ${change.days >= 5 ? "dní" : "dny"})` : czDay(change.from);
    if (change.action === "removed") head = `🗑️ **Omluvenka zrušena** · ${change.player} — ${range}`;
    else head = `🆕 **Nová omluvenka** · ${change.player} — ${TYPE_TEXT[change.type] || change.type}${change.time ? ` (od ${change.time})` : ""} — ${range}`;
    const o = await overviewText(env, { anchor: change.from });
    rec.via = await send(env, head + "\n\n" + o.text, []);
    rec.ok = true;
  } catch (e) {
    rec.ok = false; rec.error = String((e && e.message) || e).slice(0, 200);
    console.log("raidtime notify failed: " + rec.error);
  }
  try { await metaSet(env, "raidtime_notify", rec); } catch (e) { /* ignore */ }
  return rec;
}

function pragueHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Prague", hour: "2-digit", hour12: false }).format(d).replace(/\D/g, "")) % 24;
}

/** Cron handler: the firing that lands in 18:xx Europe/Prague posts the daily report once per day. */
export async function scheduled(event, env, ctx) {
  const when = new Date(event.scheduledTime || Date.now());
  const hour = pragueHour(when);
  if (hour !== 18) { console.log(`raidtime cron: ${hour}:xx in Prague, not 18 – skip`); return; }
  const day = todayPrague(when);
  const last = await metaGet(env, "raidtime_report");
  if (last && last.day === day && !last.manual) { console.log("raidtime cron: already posted today"); return; }   // a manual "post now" does not replace the 18:00 one
  await metaSet(env, "raidtime_report", { day, at: nowIso(), via: "pending" });   // claim first → the other firing skips
  try {
    const { text, mentionKeys } = await reportText(env);
    const via = await send(env, text, await mentionIds(env, mentionKeys));
    await metaSet(env, "raidtime_report", { day, at: nowIso(), via });
  } catch (e) {
    await metaSet(env, "raidtime_report", { day, at: nowIso(), via: "failed", error: String((e && e.message) || e).slice(0, 200) });
    console.log("raidtime cron failed: " + String((e && e.message) || e));
  }
}
