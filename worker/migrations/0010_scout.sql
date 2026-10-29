-- Nábor (scouting): players of the guilds ranked below us on the server whose Warcraft Logs parse average is 95+
-- (tools/recruit/wcl_scout.mjs in GitHub Actions scout.yml) + their raider.io contact info. Admin-only page web/scout.html.
-- Rows carry the run_id of the scrape that wrote them; a finished run prunes rows of older runs.

CREATE TABLE IF NOT EXISTS scout_guilds (
  id          INTEGER PRIMARY KEY,            -- Warcraft Logs guild id
  name        TEXT NOT NULL,
  faction     TEXT NOT NULL DEFAULT '',
  server_rank INTEGER,                        -- progress rank on the server (WCL zoneRanking)
  world_rank  INTEGER,
  candidates  INTEGER NOT NULL DEFAULT 0,     -- characters of the guild that appeared in the server parse rankings
  players     INTEGER NOT NULL DEFAULT 0,     -- of those, 95+ (stored in scout_players)
  run_id      TEXT NOT NULL DEFAULT '',
  fetched_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scout_players (
  key         TEXT PRIMARY KEY,               -- lower(name)-realm
  name        TEXT NOT NULL,
  realm       TEXT NOT NULL DEFAULT '',
  class       TEXT NOT NULL DEFAULT '',
  spec        TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT '',       -- tank | healer | dps
  guild_id    INTEGER,
  guild_name  TEXT NOT NULL DEFAULT '',
  ilvl        REAL,
  hc_best     REAL,                           -- heroic: best / median performance average (WCL zoneRankings)
  hc_median   REAL,
  hc_kills    INTEGER NOT NULL DEFAULT 0,
  my_best     REAL,                           -- mythic
  my_median   REAL,
  my_kills    INTEGER NOT NULL DEFAULT 0,
  wcl_url     TEXT NOT NULL DEFAULT '',
  rio_url     TEXT NOT NULL DEFAULT '',
  bio         TEXT NOT NULL DEFAULT '',       -- raider.io "About"
  battletag   TEXT NOT NULL DEFAULT '',
  discord     TEXT NOT NULL DEFAULT '',
  socials     TEXT NOT NULL DEFAULT '{}',     -- JSON { twitch, twitter, youtube, wowhead }
  recruitment TEXT NOT NULL DEFAULT '[]',     -- JSON raider.io recruitmentProfiles (looking-for-guild)
  data        TEXT NOT NULL DEFAULT '{}',     -- JSON { hc: [{ id, boss, best, median, kills, spec }], my: [...], thumb }
  run_id      TEXT NOT NULL DEFAULT '',
  fetched_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scout_players_guild ON scout_players (guild_id);
