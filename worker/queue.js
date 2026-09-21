// Sim queue (SimC string form → Raidbots runner) + extras (Great Vault, crests, Discord rooms).
// Replaces the Apps Script "SIM FRONTA" section: tables sim_queue, vault_items, crests, discord_rooms, meta (0002).
//
//   POST /api/sims/submit            { simc }  (public, players) → parse, roster check, queue row, vault + crests,
//                                     GitHub Actions workflow_dispatch (secret GITHUB_TOKEN; without it the hourly cron picks it up)
//   GET  /api/sims/status            (public) recent queue rows without the SimC string – shown on sim.html
//   GET  /api/sims/extras            (public, edge-cached 60 s) { vault, crests, discord } – read by loot.html
//   POST /api/sims/extras            (auth) one-time import of the Vault / Cresty / Discord sheet tabs
//   POST /api/sims/run               { pw } (secret RUN_PASSWORD) or auth → dispatch the runner now
//   GET  /api/sims/queue             (auth) rows for sim_runner.py: pending + running + errors written by the runner
//   POST /api/sims/queue/status      (auth) { row, character, action: running|done|error|note|notified, kind, url, note, result }
//   GET  /api/sims/notify-test?character=  (auth) Discord message payload for the runner's discord-test task
//   POST /api/discord/rooms          (auth) { guild, me, channels } from the runner's discord-rooms task → discord_rooms
//
// Optional Worker vars/secrets: GITHUB_TOKEN (PAT with actions:write), GITHUB_REPO (default vitekpoor/RaidPlan),
// RUN_PASSWORD (hub "Spustit simy" form), DISCORD_SIM_CHANNEL (shared channel id for players without a room),
// DISCORD_PLAYERS_CATEGORY ("TVOJE ROMKA, Players"), SIM_PAGE_URL (link in Discord messages), SHEET_ID.

import { json, nameKey, specKey, numOrNull, nowIso, whenText, requireAuth, fetchRoster, playerOf } from "./lib.js";
import { simSummary } from "./results.js";

const SIM_MAX_SIMC = 200000;
const KIND_LABEL = { raid: "raid", mplus: "M+", qe: "raid+M+", topgear: "Top Gear", raidhc: "HC raid" };
const TOPGEAR_SKIP = "– (nic není upgrade)";
const TOPGEAR_QE = "– (QE Live)";
const GITHUB_REPO_DEFAULT = "vitekpoor/RaidPlan";
const GITHUB_WORKFLOW = "sims.yml";
const GITHUB_BRANCH = "main";
const EXTRAS_CACHE_SECONDS = 60;
const DISCORD_PENDING_NOTE = "Discord ⏳ bot přes runner";
const DISCORD_CREATE_ROOM_CHANNEL = "1544826757956247764";   // channel with the "Create Room" button
const DISCORD_NO_ROOM_HINT = "ℹ️ Nemáš vlastní místnost – vytvoř si ji tlačítkem v <#" + DISCORD_CREATE_ROOM_CHANNEL + ">, příště ti přijde zpráva přímo tam.";
const DISCORD_CATEGORY_DEFAULT = "TVOJE ROMKA, Players";
const DISCORD_VIEW_CHANNEL = 1024;
const SIM_PAGE_URL_DEFAULT = "https://eternal-shadows.vitek-poor.workers.dev/loot";

// ------------------------------------------------------------ SimC parsing ----

const CLASS_RE = /^(deathknight|demonhunter|druid|evoker|hunter|mage|monk|paladin|priest|rogue|shaman|warlock|warrior)="([^"\n]+)"\s*$/mi;

/** Port of parseSimc_ / parseVault_ / parseCrests_ (Apps Script). */
export function parseSimc(text) {
  const s = String(text || "").replace(/\r/g, "").trim();
  const out = { ok: false, error: "", name: "", cls: "", spec: "", server: "", region: "", vault: null, crests: null, simc: s };
  if (!s) { out.error = "SimC string je prázdný."; return out; }
  if (s.length > SIM_MAX_SIMC) { out.error = "SimC string je podezřele dlouhý."; return out; }
  const m = CLASS_RE.exec(s);
  if (!m) { out.error = "Nenašel jsem řádek classa=\"Jméno\" – vlož celý export z addonu SimulationCraft (/simc)."; return out; }
  out.cls = m[1].toLowerCase();
  out.name = m[2].trim();
  const sp = /^spec=([a-z_]+)\s*$/mi.exec(s);
  out.spec = sp ? sp[1].toLowerCase() : "";
  const sv = /^server=([^\s]+)\s*$/mi.exec(s);
  out.server = sv ? sv[1].toLowerCase() : "";
  const rg = /^region=([a-z]+)\s*$/mi.exec(s);
  out.region = rg ? rg[1].toLowerCase() : "";
  if (!/^[a-z_0-9]+=,id=\d+/mi.test(s)) { out.error = "Export neobsahuje žádný vybavený item (řádky head=,id=…)."; return out; }
  out.vault = parseVault(s);     // null = block missing (vault not opened), [] = opened but empty
  out.crests = parseCrests(s);   // null = no upgrade_currencies line (old addon)
  out.ok = true;
  return out;
}

export function parseVault(s) {
  const m = /###\s*Weekly Reward Choices([\s\S]*?)(?:###\s*End of Weekly Reward Choices|$)/i.exec(s);
  if (!m) return null;
  const items = [];
  let name = "", ilvl = "";
  for (const line of m[1].split("\n")) {
    const l = line.replace(/^\s*#\s?/, "").trim();
    if (!l) continue;
    const it = /^([a-z_0-9]+)=,?id=(\d+)(.*)$/i.exec(l);
    if (it) {
      const b = /bonus_id=([\d/]+)/.exec(it[3]);
      items.push({ slot: it[1].toLowerCase().replace(/[12]$/, ""), id: Number(it[2]), name, ilvl: ilvl ? Number(ilvl) : null, bonus: b ? b[1] : "" });
      name = ""; ilvl = "";
      continue;
    }
    const nm = /^(.*?)\s*(?:\((\d{3})\))?\s*$/.exec(l);
    if (nm && nm[1] && !/^#/.test(nm[1])) { name = nm[1]; ilvl = nm[2] || ""; }
  }
  return items;
}

export function parseCrests(s) {
  const m = /^#\s*upgrade_currencies=(\S+)/m.exec(String(s || ""));
  if (!m) return null;
  const out = {};
  let any = false;
  for (const part of m[1].split("/")) {
    const p = part.split(":");   // c:<currency id>:<count>
    if (p[0] === "c" && p.length >= 3 && /^\d+$/.test(p[2])) { out[p[1]] = +p[2]; any = true; }
  }
  return any ? out : null;
}

/** → { id, kind: "raidbots" | "qe", url } or null (same shapes as parseReportLink_ in Apps Script). */
export function parseReportLink(s) {
  s = String(s || "").trim();
  let m = /raidbots\.com\/(?:simbot\/report|reports)\/([A-Za-z0-9]{10,40})/.exec(s);
  if (m) return { id: m[1], kind: "raidbots", url: `https://www.raidbots.com/simbot/report/${m[1]}` };
  m = /questionablyepic\.com\/(?:live\/upgradereport|live\/report|api\/upgrades)\/([A-Za-z0-9_-]{6,80})/.exec(s);
  if (m) return { id: m[1], kind: "qe", url: `https://questionablyepic.com/live/upgradereport/${m[1]}` };
  if (/^[A-Za-z0-9]{10,40}$/.test(s)) return { id: s, kind: "raidbots", url: `https://www.raidbots.com/simbot/report/${s}` };
  return null;
}

function findRosterCharacter(roster, name, cls) {
  const key = nameKey(name), ck = specKey(cls);
  const hits = [];
  for (const r of roster) {
    if (r.main && nameKey(r.main) === key) hits.push({ name: r.main, cls: r.mainClass, role: r.mainRole, player: r.player });
    if (r.alt && nameKey(r.alt) === key) hits.push({ name: r.alt, cls: r.altClass, role: r.altRole, player: r.player });
  }
  if (!hits.length) {
    return { error: `Postava „${name}“ není v rosteru (list Roster). Pošli string z postavy, se kterou raiduješ, nebo napiš raid leaderovi, ať ji do rosteru doplní.` };
  }
  const byClass = hits.filter((h) => !ck || !h.cls || specKey(h.cls) === ck);
  if (!byClass.length) {
    return { error: `Postava „${name}“ je v rosteru jako ${hits.map((h) => h.cls).join(" / ")}, ale string je z classy ${cls}. Pošli string ze správné postavy, nebo ať raid leader opraví roster.` };
  }
  return { character: byClass[0] };
}

// ------------------------------------------------------------------ submit ----

export async function submit(request, env, ctx, url) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, message: "⚠ Tělo požadavku musí být JSON { simc }." }, 400); }
  const p = parseSimc(body && body.simc);
  if (!p.ok) return json({ ok: false, message: "⚠ " + p.error });
  let roster;
  try { roster = await fetchRoster(env, ctx, url.origin); } catch (e) { return json({ ok: false, message: "⚠ Roster se nepodařilo načíst (" + e.message + ") – zkus to za chvíli." }, 502); }
  const found = findRosterCharacter(roster, p.name, p.cls);
  if (found.error) return json({ ok: false, message: "⚠ " + found.error });
  const ch = found.character;
  const ck = nameKey(ch.name), sk = specKey(p.spec), now = nowIso();
  const stmts = [
    // older pending rows of the same character AND spec are dropped – the latest sim wins; other specs stay
    env.DB.prepare("UPDATE sim_queue SET status = 'dropped', note = 'nahrazeno novějším odesláním', updated_at = ?3 WHERE character_key = ?1 AND spec_key = ?2 AND status = 'pending'").bind(ck, sk, now),
    env.DB.prepare(
      `INSERT INTO sim_queue (character, character_key, spec, spec_key, class, player, role, server, region, simc, has_vault)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
    ).bind(ch.name, ck, p.spec, sk, p.cls, ch.player || "", ch.role || "", p.server, p.region, p.simc, p.vault && p.vault.length ? 1 : 0),
    // Great Vault: the latest export wins; an export WITHOUT the block deletes the character's vault
    env.DB.prepare("DELETE FROM vault_items WHERE character_key = ?1").bind(ck),
  ];
  for (const v of p.vault || []) {
    stmts.push(env.DB.prepare(
      "INSERT INTO vault_items (character, character_key, time, item_id, item, slot, ilvl, bonus_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
    ).bind(ch.name, ck, now, v.id, v.name || "", v.slot || "", v.ilvl, v.bonus || ""));
  }
  if (p.crests) {
    const c = (id) => Number(p.crests[id] || 0);
    stmts.push(env.DB.prepare(
      `INSERT INTO crests (character_key, character, time, adventurer, veteran, champion, hero, myth, server, region)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(character_key) DO UPDATE SET character = excluded.character, time = excluded.time, adventurer = excluded.adventurer,
         veteran = excluded.veteran, champion = excluded.champion, hero = excluded.hero, myth = excluded.myth,
         server = CASE WHEN excluded.server <> '' THEN excluded.server ELSE crests.server END,
         region = CASE WHEN excluded.region <> '' THEN excluded.region ELSE crests.region END`
    ).bind(ck, ch.name, now, c("3442"), c("3443"), c("3444"), c("3445"), c("3446"), p.server, p.region));
  }
  await env.DB.batch(stmts);
  ctx.waitUntil(caches.default.delete(extrasCacheKey(url)));
  const pending = await countPending(env);
  const run = await dispatchRunner(env, "form:" + ch.name);
  let vaultMsg = "";
  if (p.vault === null) vaultMsg = " Vault v exportu nebyl (starý vault postavy je smazaný) – když před /simc otevřeš Great Vault, uvidíš na stránce Simy i porovnání vaultu s bonus rollem.";
  else if (p.vault.length) vaultMsg = ` Vault: ${p.vault.length}${p.vault.length === 1 ? " item." : p.vault.length < 5 ? " itemy." : " itemů."}`;
  const started = run.ok ? " Sim se právě spouští – za pár minut uvidíš upgrady na stránce Simy." : " Sim proběhne automaticky nejpozději do hodiny.";
  const message = `✅ Uloženo: ${ch.name} (${p.spec}).${vaultMsg} Ve frontě čeká ${pending}${pending === 1 ? " sim." : pending < 5 ? " simy." : " simů."}${started}`;
  return json({ ok: true, message, character: ch.name, spec: p.spec, player: ch.player || "", vault: p.vault === null ? null : p.vault.length,
                crests: !!p.crests, pending, started: run.ok, run: run.message });
}

async function countPending(env) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM sim_queue WHERE status = 'pending'").first();
  return Number((r && r.n) || 0);
}

/** GitHub Actions workflow_dispatch (sims.yml). Concurrency group "sim-queue" on GitHub's side queues one pending run,
 *  so dispatching on every submit is safe: a run always follows the latest submission. */
async function dispatchRunner(env, reason, inputs = {}) {
  if (!env.GITHUB_TOKEN) return { ok: false, message: "bez GitHub tokenu (Worker secret GITHUB_TOKEN) – čeká se na hodinový cron" };
  const repo = env.GITHUB_REPO || GITHUB_REPO_DEFAULT;
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28",
                 "content-type": "application/json", "user-agent": "eternal-shadows-worker" },
      body: JSON.stringify({ ref: GITHUB_BRANCH, inputs: { reason: String(reason || "worker").slice(0, 80), ...inputs } }),
    });
    if (r.status === 204) {
      await env.DB.prepare("INSERT INTO meta (key, value, updated_at) VALUES ('simrun_last', ?1, ?1) ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = ?1").bind(nowIso()).run();
      return { ok: true, message: "GitHub Actions spuštěn" };
    }
    return { ok: false, message: `GitHub API HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` };
  } catch (e) {
    return { ok: false, message: "GitHub API: " + e.message };
  }
}

/** POST /api/sims/run { pw } (hub form) or Bearer token. */
export async function run(request, env, ctx, url) {
  let body = {};
  try { body = await request.json(); } catch (e) { /* no body */ }
  const authed = env.API_TOKEN && !requireAuth(request, env);
  if (!authed) {
    if (!env.RUN_PASSWORD) return json({ ok: false, message: "Ruční spuštění není nastavené (Worker secret RUN_PASSWORD)." }, 503);
    if (String(body.pw || "") !== env.RUN_PASSWORD) return json({ ok: false, message: "Špatné heslo." }, 401);
  }
  const pending = await countPending(env);
  if (!pending) return json({ ok: true, message: "Fronta je prázdná – není co simovat." });
  const r = await dispatchRunner(env, body.reason || "hub");
  return json({ ok: r.ok, message: r.ok ? `${pending} ve frontě. GitHub Actions spuštěn – simy doběhnou za pár minut, výsledky se objeví na stránce Simy.` : r.message });
}

/** GET /api/sims/status – public overview without SimC strings. */
export async function publicStatus(env) {
  const rows = (await env.DB.prepare(
    `SELECT id, created_at, updated_at, character, spec, status, note, report_raid, report_mplus, report_topgear, report_raidhc, has_vault
     FROM sim_queue WHERE status <> 'dropped' ORDER BY id DESC LIMIT 60`
  ).all()).results;
  const last = await env.DB.prepare("SELECT value FROM meta WHERE key = 'simrun_last'").first();
  return json({ ok: true, pending: rows.filter((r) => r.status === "pending").length, running: rows.filter((r) => r.status === "running").length,
                lastDispatch: (last && last.value) || null, rows });
}

// ------------------------------------------------------------- runner API ----

const QUEUE_SQL = `SELECT id, character, spec, simc, wowaudit_id, status, note, report_raid, report_mplus, report_topgear, report_raidhc, has_vault
                   FROM sim_queue WHERE status IN ('pending', 'running') OR (status = 'error' AND note LIKE 'sim_runner:%') ORDER BY id`;

/** GET /api/sims/queue – same row shape the runner used with the Apps Script simapi. */
export async function queueRows(env) {
  const rows = (await env.DB.prepare(QUEUE_SQL).all()).results.map((r) => ({
    row: r.id, character: r.character, spec: r.spec, simc: r.simc, id: Number(r.wowaudit_id) || 0, status: r.status, note: r.note || "",
    report_raid: parseReportLink(r.report_raid) ? r.report_raid : "",
    report_mplus: parseReportLink(r.report_mplus) ? r.report_mplus : "",
    report_topgear: String(r.report_topgear || "").trim(),
    report_raidhc: parseReportLink(r.report_raidhc) ? r.report_raidhc : "",
    vault: r.has_vault ? "1" : "",
  }));
  return json({ ok: true, rows });
}

/** Which sims a row still lacks ("M+", "M+ a Top Gear", …); "" = complete. QE Live covers everything. */
function missingOf(r) {
  const raidLink = parseReportLink(r.report_raid);
  const isQe = !!(raidLink && raidLink.kind === "qe");
  const miss = [];
  if (!raidLink) miss.push("raid");
  if (!parseReportLink(r.report_mplus)) miss.push("M+");
  if (!String(r.report_topgear || "").trim() && !isQe) miss.push("Top Gear");
  if (!parseReportLink(r.report_raidhc) && !isQe) miss.push("HC raid");
  return miss.length > 1 ? miss.slice(0, -1).join(", ") + " a " + miss[miss.length - 1] : miss.join("");
}

/** Note = segments separated by " | ", each starting with the kind label; a new segment replaces the old one of its kind. */
function mergeNote(oldNote, kind, seg) {
  const labels = kind === "qe" ? ["raid", "M+", "Top Gear"] : [KIND_LABEL[kind] || kind];
  const keep = String(oldNote || "").split(" | ").filter((n) => {
    n = n.trim();
    if (!n || /^čeká na /.test(n) || /^sim_runner:/.test(n) || /^⚠/.test(n)) return false;
    return !labels.some((l) => n.indexOf(l + " ") === 0);
  });
  keep.push(seg);
  return keep.join(" | ");
}

/** POST /api/sims/queue/status */
export async function queueStatus(request, env, ctx, url) {
  let q;
  try { q = await request.json(); } catch (e) { return json({ ok: false, error: "body must be JSON" }, 400); }
  const id = Number(q.row);
  if (!(id >= 1)) return json({ ok: false, error: "chybí row" }, 400);
  const row = await env.DB.prepare("SELECT * FROM sim_queue WHERE id = ?1").bind(id).first();
  if (!row) return json({ ok: false, error: `řádek ${id} neexistuje` }, 404);
  if (q.character !== undefined && nameKey(q.character) !== row.character_key) {
    return json({ ok: false, error: `řádek ${id} je „${row.character}“, ne „${q.character}“` }, 409);
  }
  const action = String(q.action || ""), kind = String(q.kind || "raid"), now = nowIso();
  const upd = async (fields) => {
    const keys = Object.keys(fields);
    const sql = `UPDATE sim_queue SET ${keys.map((k, i) => `${k} = ?${i + 2}`).join(", ")}, updated_at = ?${keys.length + 2} WHERE id = ?1`;
    await env.DB.prepare(sql).bind(id, ...keys.map((k) => fields[k]), now).run();
  };

  if (action === "running") {
    const seg = `${KIND_LABEL[kind] || kind} 🔄 ${String(q.url || "")} (${whenText()})`;
    await upd({ status: "running", note: mergeNote(row.note, kind, seg) });
    return json({ ok: true });
  }
  if (action === "error") {
    await upd({ status: "error", note: String(q.note || "sim_runner: chyba").slice(0, 1000) });
    return json({ ok: true });
  }
  if (action === "note") {
    await upd({ note: String(q.note || "").slice(0, 1000) });
    return json({ ok: true });
  }
  if (action === "notified") {
    const cur = String(row.note || ""), resTxt = String(q.result || "Discord ✔ (bot)").slice(0, 160);
    await upd({ note: cur.indexOf(DISCORD_PENDING_NOTE) >= 0 ? cur.replace(DISCORD_PENDING_NOTE, resTxt) : (cur ? cur + " | " : "") + resTxt });
    return json({ ok: true });
  }
  if (action === "done") {
    const wasComplete = row.status === "done";
    const fields = {};
    let seg, label;
    if (kind === "topgear-skip") {
      fields.report_topgear = TOPGEAR_SKIP;
      label = "Top Gear";
      seg = "Top Gear přeskočen: nic není upgrade";
    } else {
      const link = parseReportLink(q.url);
      if (!link) {
        await upd({ status: "error", note: "Neplatný odkaz na report (Raidbots / QE Live): " + String(q.url || "") });
        return json({ ok: false, error: "neplatný odkaz na report", message: "⚠ Neplatný odkaz – Raidbots Droptimizer nebo QE Live report." });
      }
      const k = link.kind === "qe" ? "qe" : (["mplus", "topgear", "raidhc"].includes(kind) ? kind : "raid");
      const kinds = k === "qe" ? ["raid", "mplus"] : [k];
      if (kinds.includes("raid")) fields.report_raid = link.url;
      if (kinds.includes("mplus")) fields.report_mplus = link.url;
      if (kinds.includes("topgear")) fields.report_topgear = link.url;
      if (kinds.includes("raidhc")) fields.report_raidhc = link.url;
      if (k === "qe") fields.report_topgear = TOPGEAR_QE;
      label = KIND_LABEL[k];
      seg = `${label} ${whenText()} ${link.kind === "qe" ? "QE Live" : "Raidbots"}: ${String(q.note || "report uložen").slice(0, 300)}`;
    }
    const after = { ...row, ...fields };
    const missing = missingOf(after);
    const complete = missing === "";
    let note = mergeNote(row.note, kind === "topgear-skip" ? "topgear" : (label === "raid+M+" ? "qe" : kind), seg);
    if (!complete) note += " | čeká na " + missing + " sim";
    let pendingNotify = null;
    if (complete && !wasComplete && q.notify !== false) {
      const dn = await notifySimDone(env, ctx, url, row.character, row.spec, {});
      if (dn.note) note += " | " + dn.note;
      pendingNotify = dn.pending;
    }
    fields.status = complete ? "done" : "running";
    fields.note = note;
    await upd(fields);
    const message = `✅ ${row.character} [${label}]: ${kind === "topgear-skip" ? "Top Gear přeskočen" : (q.note || "report uložen")}` + (complete ? "" : ` – čeká se ještě na ${missing} sim`);
    return json({ ok: true, message, complete, missing, notify: pendingNotify });
  }
  return json({ ok: false, error: "neznámá action " + action }, 400);
}

// ------------------------------------------------------------------ Discord ----

function pctText(p) { return (p > 0 ? "+" : "") + (Math.round(p * 100) / 100).toFixed(2) + " %"; }

async function discordTargetFor(env, ctx, url, character) {
  let player = "";
  try { player = playerOf(await fetchRoster(env, ctx, url.origin), character); } catch (e) { /* roster is best effort here */ }
  const keys = [player ? nameKey(player) : "", nameKey(character)].filter(Boolean);
  for (const k of keys) {
    const room = await env.DB.prepare("SELECT * FROM discord_rooms WHERE player_key = ?1").bind(k).first();
    if (room) return { player: room.player, channelUrl: room.channel_url, channelId: room.channel_id || channelIdOf(room.channel_url), webhook: room.webhook_url, userId: room.user_id };
  }
  return player ? { player, channelUrl: "", channelId: "", webhook: "", userId: "" } : null;
}

function channelIdOf(channelUrl) {
  const m = /discord(?:app)?\.com\/channels\/\d+\/(\d+)/.exec(String(channelUrl || ""));
  return m ? m[1] : "";
}

async function simDoneMessage(env, character, spec, room, opts) {
  const s = await simSummary(env, character);
  const lines = [];
  lines.push((room && room.userId ? `<@${room.userId}> ` : "") + `🧪 **${character}**` + (spec ? ` (${spec})` : "") + (opts.test ? " – TEST notifikace" : " – simy jsou hotové!"));
  const itemText = (it) => it.item + (it.catalystFrom ? ` (katalyzátor z ${it.catalystFrom})` : "") + (it.boss ? ` – ${it.boss}` : "") + " " + pctText(it.pct);
  if (s.raid) lines.push(`• Raid: ${s.nRaid} upgradů, nejlepší ${itemText(s.raid)}`);
  if (s.mplus) lines.push(`• M+: ${s.nMplus} upgradů, nejlepší ${itemText(s.mplus)}`);
  if (s.topgear) lines.push(`• Top Gear (best overall): ${pctText(s.topgear.pct)}`);
  if (s.hc) lines.push("• Great Vault: verdikt vault vs. bonus roll je na webu");
  lines.push(`→ ${env.SIM_PAGE_URL || SIM_PAGE_URL_DEFAULT}#${encodeURIComponent(character)}`);
  return lines.join("\n");
}

async function discordPostWebhook(webhook, text, userId) {
  const r = await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: text, allowed_mentions: { users: userId ? [userId] : [] } }) });
  if (!r.ok) throw new Error(`webhook HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
}

/**
 * Message about a character's finished sims. Returns { note, pending }: a room webhook is posted directly from here,
 * otherwise pending = { channelId, userId, text, player } for the runner's bot (DISCORD_BOT_TOKEN lives in GitHub secrets).
 * Never throws.
 */
export async function notifySimDone(env, ctx, url, character, spec, opts) {
  try {
    const room = await discordTargetFor(env, ctx, url, character);
    let text = await simDoneMessage(env, character, spec, room, opts || {});
    if (room && room.webhook) { await discordPostWebhook(room.webhook, text, room.userId); return { note: "Discord ✔ " + room.player, pending: null }; }
    if (room && room.channelId) return { note: DISCORD_PENDING_NOTE, pending: { channelId: room.channelId, userId: room.userId || "", text, player: room.player } };
    const fallback = String(env.DISCORD_SIM_CHANNEL || "").replace(/\D/g, "");
    if (fallback) {
      text += "\n" + DISCORD_NO_ROOM_HINT;
      return { note: DISCORD_PENDING_NOTE + " (společný kanál)", pending: { channelId: fallback, userId: (room && room.userId) || "", text, player: ((room && room.player) || character) + " → společný kanál" } };
    }
    return { note: "", pending: null };
  } catch (e) {
    return { note: "Discord ✖ " + String((e && e.message) || e).slice(0, 160), pending: null };
  }
}

/** GET /api/sims/notify-test?character= */
export async function notifyTest(env, ctx, url) {
  const ch = (url.searchParams.get("character") || "").trim();
  if (!ch) return json({ ok: false, error: "chybí character" }, 400);
  const t = await notifySimDone(env, ctx, url, ch, "", { test: true });
  const target = await discordTargetFor(env, ctx, url, ch);
  return json({ ok: true, note: t.note, notify: t.pending, target: target ? { player: target.player, channelUrl: target.channelUrl } : null });
}

/** POST /api/discord/rooms { guild, me, channels } – port of applyDiscordRooms_. */
export async function discordRooms(request, env, ctx, url) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: "body must be JSON" }, 400); }
  const guild = String(body.guild || "").replace(/\D/g, ""), meId = String(body.me || ""), channels = Array.isArray(body.channels) ? body.channels : [];
  const catKey = (n) => nameKey(n).replace(/[^a-z0-9]+/g, "");
  const wanted = String(env.DISCORD_PLAYERS_CATEGORY || DISCORD_CATEGORY_DEFAULT).split(",").map(catKey).filter(Boolean);
  const cats = channels.filter((c) => c && c.type === 4 && wanted.some((w) => { const k = catKey(c.name); return k === w || (w.length >= 4 && k.indexOf(w) >= 0); }));
  if (!cats.length) {
    return json({ ok: false, error: `Kategorie „${wanted.join(", ")}“ na serveru není. Kategorie: ` + channels.filter((c) => c && c.type === 4).map((c) => c.name).join(", ") });
  }
  const catIds = new Set(cats.map((c) => c.id));
  const rooms = channels.filter((c) => c && (c.type === 0 || c.type === 5) && catIds.has(c.parent_id));
  let roster = [];
  try { roster = await fetchRoster(env, ctx, url.origin); } catch (e) { return json({ ok: false, error: "Roster: " + e.message }, 502); }
  const matched = [], unmatched = [], matchedPlayers = new Set(), stmts = [];
  for (const ch of rooms) {
    const tokens = String(ch.name || "").toLowerCase().split(/[^a-z0-9á-žÁ-Ž]+/).filter(Boolean).map(nameKey);
    const chKey = nameKey(ch.name);
    let player = null;
    for (const r of roster) { const pk = nameKey(r.player); if (pk && (chKey === pk || tokens.includes(pk))) { player = r.player; break; } }
    if (!player) { unmatched.push("#" + ch.name); continue; }
    const members = (ch.permission_overwrites || []).filter((o) => Number(o.type) === 1 && (!meId || String(o.id) !== meId) && (Number(o.allow) & DISCORD_VIEW_CHANNEL) !== 0);
    const userId = members.length === 1 ? String(members[0].id) : "";
    const chUrl = `https://discord.com/channels/${guild}/${ch.id}`;
    stmts.push(env.DB.prepare(
      `INSERT INTO discord_rooms (player_key, player, channel_url, channel_id, user_id, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(player_key) DO UPDATE SET player = excluded.player, channel_url = excluded.channel_url, channel_id = excluded.channel_id,
         user_id = CASE WHEN excluded.user_id <> '' THEN excluded.user_id ELSE discord_rooms.user_id END, updated_at = excluded.updated_at`
    ).bind(nameKey(player), player, chUrl, String(ch.id), userId, nowIso()));
    matchedPlayers.add(nameKey(player));
    matched.push(`${player} ← #${ch.name}` + (userId ? "" : " (user ID nenalezeno)"));
  }
  if (stmts.length) await env.DB.batch(stmts);
  ctx.waitUntil(caches.default.delete(extrasCacheKey(url)));
  const noRoom = roster.filter((r) => !matchedPlayers.has(nameKey(r.player))).map((r) => r.player);
  const message = `Načteno ${matched.length} místností z kategorie „${cats.map((c) => c.name).join(", ")}“.\n\n${matched.join("\n")}` +
    (unmatched.length ? "\n\nNespárované místnosti (jméno neodpovídá hráči v Rosteru): " + unmatched.join(", ") : "") +
    (noRoom.length ? "\n\nHráči bez místnosti: " + noRoom.join(", ") : "");
  return json({ ok: true, message, matched, unmatched, noRoom });
}

// ------------------------------------------------------------------- extras ----

export function extrasCacheKey(url) {
  return new Request(new URL("/api/sims/extras", url.origin).toString(), { method: "GET" });
}

/** GET /api/sims/extras – vault, crests and Discord rooms (public fields only) for loot.html. */
export async function getExtras(env, ctx, url) {
  const cache = caches.default, key = extrasCacheKey(url);
  const hit = await cache.match(key);
  if (hit) return hit;
  const vault = (await env.DB.prepare("SELECT character, time, item_id AS itemId, item, slot, ilvl, bonus_id AS bonusId FROM vault_items ORDER BY character_key, id").all()).results;
  const crests = (await env.DB.prepare("SELECT character, time, adventurer, veteran, champion, hero, myth, server, region FROM crests ORDER BY character_key").all()).results;
  const discord = (await env.DB.prepare("SELECT player, channel_url AS channelUrl FROM discord_rooms WHERE channel_url <> '' ORDER BY player_key").all()).results;
  const res = json({ ok: true, generated: nowIso(), vault, crests, discord }, 200, { "cache-control": `public, max-age=0, s-maxage=${EXTRAS_CACHE_SECONDS}` });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

/** POST /api/sims/extras (auth) – one-time import from the sheet tabs; each provided list replaces its table. */
export async function importExtras(request, env, ctx, url) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: "body must be JSON" }, 400); }
  const out = {};
  if (Array.isArray(body.vault)) {
    const stmts = [env.DB.prepare("DELETE FROM vault_items")];
    for (const v of body.vault) {
      if (!v || !v.character || !numOrNull(v.itemId)) continue;
      stmts.push(env.DB.prepare("INSERT INTO vault_items (character, character_key, time, item_id, item, slot, ilvl, bonus_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
        .bind(String(v.character), nameKey(v.character), v.time || nowIso(), numOrNull(v.itemId), String(v.item || ""), String(v.slot || ""), numOrNull(v.ilvl), String(v.bonusId || "")));
    }
    await env.DB.batch(stmts);
    out.vault = stmts.length - 1;
  }
  if (Array.isArray(body.crests)) {
    const stmts = [env.DB.prepare("DELETE FROM crests")];
    for (const c of body.crests) {
      if (!c || !c.character) continue;
      stmts.push(env.DB.prepare("INSERT OR REPLACE INTO crests (character_key, character, time, adventurer, veteran, champion, hero, myth, server, region) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)")
        .bind(nameKey(c.character), String(c.character), c.time || nowIso(), numOrNull(c.adventurer) || 0, numOrNull(c.veteran) || 0, numOrNull(c.champion) || 0,
              numOrNull(c.hero) || 0, numOrNull(c.myth) || 0, String(c.server || "").toLowerCase(), String(c.region || "").toLowerCase()));
    }
    await env.DB.batch(stmts);
    out.crests = stmts.length - 1;
  }
  if (Array.isArray(body.discord)) {
    const stmts = [env.DB.prepare("DELETE FROM discord_rooms")];
    for (const d of body.discord) {
      if (!d || !d.player) continue;
      stmts.push(env.DB.prepare("INSERT OR REPLACE INTO discord_rooms (player_key, player, channel_url, channel_id, webhook_url, user_id, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
        .bind(nameKey(d.player), String(d.player), String(d.channelUrl || ""), channelIdOf(d.channelUrl), String(d.webhookUrl || ""), String(d.userId || "").replace(/\D/g, ""), nowIso()));
    }
    await env.DB.batch(stmts);
    out.discord = stmts.length - 1;
  }
  ctx.waitUntil(caches.default.delete(extrasCacheKey(url)));
  return json({ ok: true, imported: out });
}
