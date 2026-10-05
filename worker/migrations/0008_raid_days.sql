-- Raid time (attendance.html "Raid time" tab): per-date overrides of the weekly raid template (times, plan,
-- cancelled day, extra day). The weekly template itself (weekdays + default times/plan) is meta key "raidtime".
-- Applied by POST /api/admin/migrate.
CREATE TABLE IF NOT EXISTS raid_days (
  date        TEXT PRIMARY KEY,
  start       TEXT NOT NULL DEFAULT '',
  end         TEXT NOT NULL DEFAULT '',
  plan        TEXT NOT NULL DEFAULT '',
  off         INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
