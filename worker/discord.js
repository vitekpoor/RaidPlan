// Discord posting shared by the Worker modules (absence notifications + the daily 18:00 report, worker/raidtime.js).
// Target = a channel id (var DISCORD_ABSENCE_CHANNEL …). Sending order:
//   1. webhook URL for that channel – secret DISCORD_ABSENCE_WEBHOOK (channel → Integrations → Webhooks)
//   2. bot token – secret DISCORD_BOT_TOKEN (POST /channels/<id>/messages; bot needs Send Messages there)
// Long texts are split on line boundaries (Discord limit 2000 chars). Mentions only reach the users listed in
// `mentions` (allowed_mentions), so a name typed in the text never pings anyone by accident.

const LIMIT = 2000;

export function splitMessage(text, limit = LIMIT) {
  const chunks = [];
  let cur = "";
  for (let line of String(text || "").split("\n")) {
    if (line.length > limit) line = line.slice(0, limit - 1) + "…";
    if (cur.length + line.length + 1 > limit) { chunks.push(cur); cur = line; }
    else cur = cur ? cur + "\n" + line : line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Posts `text` to the channel; { webhook, channelId, mentions: [user ids], roles: [role ids] }. Returns "webhook" | "bot". Throws when nothing is configured or Discord refuses. */
export async function postDiscord(env, { webhook, channelId, text, mentions = [], roles = [] }) {
  const users = [...new Set(mentions.filter(Boolean).map(String))].slice(0, 100);
  const roleIds = [...new Set(roles.filter(Boolean).map(String))].slice(0, 100);
  const hook = String(webhook || "").trim(), token = String(env.DISCORD_BOT_TOKEN || "").trim(), ch = String(channelId || "").replace(/\D/g, "");
  if (!/^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\//.test(hook) && !(token && ch)) {
    throw new Error("Discord není nastavený (Worker secret DISCORD_ABSENCE_WEBHOOK nebo DISCORD_BOT_TOKEN + kanál)");
  }
  for (const chunk of splitMessage(text)) {
    const payload = JSON.stringify({ content: chunk, allowed_mentions: { parse: [], users, roles: roleIds } });
    let r;
    if (/^https:\/\//.test(hook)) {
      r = await fetch(hook + (hook.includes("?") ? "&" : "?") + "wait=true", { method: "POST", headers: { "content-type": "application/json" }, body: payload });
    } else {
      r = await fetch(`https://discord.com/api/v10/channels/${ch}/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bot ${token}`, "user-agent": "eternal-shadows-worker (https://eternal-shadows.vitek-poor.workers.dev, 1.0)" }, body: payload });
    }
    if (!r.ok) throw new Error(`Discord HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
  }
  return /^https:\/\//.test(hook) ? "webhook" : "bot";
}
