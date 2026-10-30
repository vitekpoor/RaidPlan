-- Nábor: faction of the scouted player (alliance | horde, raider.io), heroic realm rank + progress of the guild (the guilds
-- now come from the heroic realm ranking too, which lists guilds without mythic kills – server_rank stays the mythic rank).
-- Applied by POST /api/admin/migrate; ALTER TABLE ... ADD COLUMN is not idempotent, the migrate loop skips "duplicate column name".
ALTER TABLE scout_players ADD COLUMN faction TEXT NOT NULL DEFAULT '';
ALTER TABLE scout_guilds ADD COLUMN hc_rank INTEGER;
ALTER TABLE scout_guilds ADD COLUMN progress TEXT NOT NULL DEFAULT '';
