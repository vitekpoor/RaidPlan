-- Flopik (per-pull fails from Warcraft Logs) – replaces the "Flopik" and "FlopikRef" sheet tabs.
-- Pulls are computed by tools/flopik/wcl_refresh.mjs (GitHub Actions, engine.js) and posted to the Worker.

CREATE TABLE IF NOT EXISTS flopik_pulls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  report      TEXT NOT NULL DEFAULT '',
  fight       INTEGER,
  date        TEXT NOT NULL,
  pull_no     INTEGER NOT NULL DEFAULT 0,
  boss        TEXT NOT NULL DEFAULT '',
  boss_key    TEXT NOT NULL,
  boss_id     INTEGER,
  difficulty  TEXT NOT NULL DEFAULT '',
  start       TEXT NOT NULL,
  start_ms    INTEGER,
  dur         REAL NOT NULL DEFAULT 0,
  kill        INTEGER NOT NULL DEFAULT 0,
  ver         INTEGER NOT NULL DEFAULT 1,
  meta        TEXT NOT NULL DEFAULT '{}',
  written_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS flopik_pulls_report ON flopik_pulls (report, fight);
CREATE INDEX IF NOT EXISTS flopik_pulls_day ON flopik_pulls (date, boss_key);

CREATE TABLE IF NOT EXISTS flopik_players (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pull_id     INTEGER NOT NULL REFERENCES flopik_pulls(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS flopik_players_pull ON flopik_players (pull_id);

CREATE TABLE IF NOT EXISTS flopik_refs (
  key         TEXT PRIMARY KEY,
  boss_id     INTEGER,
  difficulty  TEXT NOT NULL DEFAULT '',
  spec        TEXT NOT NULL DEFAULT '',
  metric      TEXT NOT NULL DEFAULT 'dps',
  player      TEXT NOT NULL DEFAULT '',
  server      TEXT NOT NULL DEFAULT '',
  guild       TEXT NOT NULL DEFAULT '',
  report      TEXT NOT NULL DEFAULT '',
  fight       INTEGER,
  dur         REAL,
  amount      REAL,
  data        TEXT NOT NULL DEFAULT '{}',
  fetched_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS flopik_reports (
  code        TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  start_ms    INTEGER,
  end_ms      INTEGER,
  zone        TEXT NOT NULL DEFAULT '',
  fetched_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS flopik_refwin (
  key         TEXT PRIMARY KEY,
  data        TEXT NOT NULL DEFAULT '{}',
  fetched_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
