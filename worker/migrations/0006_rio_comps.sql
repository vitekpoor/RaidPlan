-- Meta sestavy: first-kill rosters of the top guilds per boss, scraped from raider.io by tools/raidplan/rio_comps.mjs
-- (GitHub Actions comps.yml). One row per raid + boss + difficulty; data = JSON { region, requested, kills: [...] }.

CREATE TABLE IF NOT EXISTS rio_comps (
  raid        TEXT NOT NULL,
  boss_slug   TEXT NOT NULL,
  difficulty  TEXT NOT NULL DEFAULT 'mythic',
  boss_name   TEXT NOT NULL DEFAULT '',
  ordinal     INTEGER NOT NULL DEFAULT 0,
  region      TEXT NOT NULL DEFAULT 'world',
  kills       INTEGER NOT NULL DEFAULT 0,
  rosters     INTEGER NOT NULL DEFAULT 0,
  fetched_at  TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (raid, boss_slug, difficulty)
);
