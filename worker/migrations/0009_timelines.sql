-- Boss timelines (timeline.html): one JSON document per boss – cooldown casts per spec imported from lorrgs.io
-- (top mythic parse) and edited by the admin (moved / added / removed casts, custom abilities).
-- Applied by POST /api/admin/migrate.
CREATE TABLE IF NOT EXISTS timelines (
  boss_slug   TEXT PRIMARY KEY,
  data        TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
