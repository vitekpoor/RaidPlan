-- Roster (players + characters, edited on roster.html by an admin) and absences (Omluvenky form).
-- Replaces the "Roster", "Absence" and "Absence přehled" sheet tabs. Applied by POST /api/admin/migrate.

CREATE TABLE IF NOT EXISTS roster_players (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL UNIQUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  bench       INTEGER NOT NULL DEFAULT 0,
  note        TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS roster_characters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id   INTEGER NOT NULL REFERENCES roster_players(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL,
  class       TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT 'dps' CHECK (role IN ('tank', 'heal', 'dps')),
  spec        TEXT NOT NULL DEFAULT '',
  is_main     INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS roster_characters_player ON roster_characters (player_id);
CREATE INDEX IF NOT EXISTS roster_characters_key ON roster_characters (name_key);

CREATE TABLE IF NOT EXISTS absences (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  player      TEXT NOT NULL,
  player_key  TEXT NOT NULL,
  date        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('absent', 'late')),
  source      TEXT NOT NULL DEFAULT 'web',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (player_key, date)
);

CREATE INDEX IF NOT EXISTS absences_date ON absences (date);
