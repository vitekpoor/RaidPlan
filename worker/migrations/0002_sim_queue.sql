-- Sim queue + extras (Great Vault, crests, Discord rooms) - replaces the "Sim fronta", "Vault",
-- "Cresty" and "Discord" sheet tabs. Applied by POST /api/admin/migrate (worker/index.js).

CREATE TABLE IF NOT EXISTS sim_queue (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  character      TEXT NOT NULL,
  character_key  TEXT NOT NULL,
  spec           TEXT NOT NULL,
  spec_key       TEXT NOT NULL,
  class          TEXT NOT NULL DEFAULT '',
  player         TEXT NOT NULL DEFAULT '',
  role           TEXT NOT NULL DEFAULT '',
  server         TEXT NOT NULL DEFAULT '',
  region         TEXT NOT NULL DEFAULT '',
  simc           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'error', 'dropped')),
  note           TEXT NOT NULL DEFAULT '',
  report_raid    TEXT NOT NULL DEFAULT '',
  report_mplus   TEXT NOT NULL DEFAULT '',
  report_topgear TEXT NOT NULL DEFAULT '',
  report_raidhc  TEXT NOT NULL DEFAULT '',
  has_vault      INTEGER NOT NULL DEFAULT 0,
  wowaudit_id    INTEGER
);

CREATE INDEX IF NOT EXISTS sim_queue_status ON sim_queue (status);
CREATE INDEX IF NOT EXISTS sim_queue_char ON sim_queue (character_key, spec_key);

CREATE TABLE IF NOT EXISTS vault_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  character      TEXT NOT NULL,
  character_key  TEXT NOT NULL,
  time           TEXT NOT NULL,
  item_id        INTEGER NOT NULL,
  item           TEXT NOT NULL DEFAULT '',
  slot           TEXT NOT NULL DEFAULT '',
  ilvl           INTEGER,
  bonus_id       TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS vault_items_char ON vault_items (character_key);

CREATE TABLE IF NOT EXISTS crests (
  character_key  TEXT PRIMARY KEY,
  character      TEXT NOT NULL,
  time           TEXT NOT NULL,
  adventurer     INTEGER NOT NULL DEFAULT 0,
  veteran        INTEGER NOT NULL DEFAULT 0,
  champion       INTEGER NOT NULL DEFAULT 0,
  hero           INTEGER NOT NULL DEFAULT 0,
  myth           INTEGER NOT NULL DEFAULT 0,
  server         TEXT NOT NULL DEFAULT '',
  region         TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS discord_rooms (
  player_key     TEXT PRIMARY KEY,
  player         TEXT NOT NULL,
  channel_url    TEXT NOT NULL DEFAULT '',
  channel_id     TEXT NOT NULL DEFAULT '',
  webhook_url    TEXT NOT NULL DEFAULT '',
  user_id        TEXT NOT NULL DEFAULT '',
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS meta (
  key            TEXT PRIMARY KEY,
  value          TEXT NOT NULL DEFAULT '',
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
