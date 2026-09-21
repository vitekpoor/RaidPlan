-- Sim results (Raidbots Droptimizer / Top Gear, QE Live) - replaces the "Sim výsledky" sheet tab.
-- One report per character + spec + origin (latest sim wins), one row per item.
-- Applied by POST /api/admin/migrate (worker/index.js) or `wrangler d1 migrations apply eternal-shadows --remote`.

CREATE TABLE IF NOT EXISTS sim_reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  character     TEXT NOT NULL,
  character_key TEXT NOT NULL,
  spec          TEXT NOT NULL,
  spec_key      TEXT NOT NULL,
  origin        TEXT NOT NULL CHECK (origin IN ('raid', 'mplus', 'topgear', 'raidhc')),
  source        TEXT NOT NULL,
  report_url    TEXT NOT NULL,
  char_ilvl     REAL,
  simmed_at     TEXT NOT NULL,
  stored_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (character_key, spec_key, origin)
);

CREATE TABLE IF NOT EXISTS sim_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id     INTEGER NOT NULL REFERENCES sim_reports(id) ON DELETE CASCADE,
  boss_id       INTEGER,
  boss          TEXT NOT NULL DEFAULT '',
  item_id       TEXT NOT NULL,
  item          TEXT NOT NULL DEFAULT '',
  slot          TEXT NOT NULL DEFAULT '',
  ilvl          INTEGER,
  base          REAL,
  value         REAL,
  diff          REAL,
  pct           REAL,
  catalyst_id   INTEGER,
  catalyst_from TEXT NOT NULL DEFAULT '',
  worn          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS sim_results_report ON sim_results (report_id);
CREATE INDEX IF NOT EXISTS sim_reports_stored ON sim_reports (stored_at);
