-- Attendance (ES Attendance addon records) and per-boss lineups – replace the "Docházka" and "Boss sestavy" sheet tabs.

CREATE TABLE IF NOT EXISTS attendance_days (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT NOT NULL UNIQUE,
  time        TEXT NOT NULL DEFAULT '',
  unknown     TEXT NOT NULL DEFAULT '[]',
  source      TEXT NOT NULL DEFAULT 'addon',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS attendance (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  day_id      INTEGER NOT NULL REFERENCES attendance_days(id) ON DELETE CASCADE,
  player      TEXT NOT NULL,
  player_key  TEXT NOT NULL,
  present     INTEGER NOT NULL DEFAULT 0,
  character   TEXT NOT NULL DEFAULT '',
  UNIQUE (day_id, player_key)
);

CREATE TABLE IF NOT EXISTS lineups (
  boss_no     TEXT PRIMARY KEY,
  boss        TEXT NOT NULL DEFAULT '',
  plan_view   TEXT NOT NULL DEFAULT '',
  date        TEXT NOT NULL DEFAULT '',
  slots       TEXT NOT NULL DEFAULT '[]',
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
