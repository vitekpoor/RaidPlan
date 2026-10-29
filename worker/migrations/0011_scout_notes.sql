-- Nábor: admin's own notes per scouted player (contacted when, outcome, free text). Keyed like scout_players.key but
-- kept in a separate table so the weekly scrape (upsert + prune of scout_players) never touches them; a player who
-- drops below the threshold and later returns gets the note back. Written by POST /api/scout/note (admin).

CREATE TABLE IF NOT EXISTS scout_notes (
  key          TEXT PRIMARY KEY,              -- scout_players.key (lower(name)-realm)
  name         TEXT NOT NULL DEFAULT '',      -- display name at the time of writing (for a list of notes without a player row)
  status       TEXT NOT NULL DEFAULT '',      -- '' | contacted | replied | talking | declined | joined | skip
  contacted_at TEXT NOT NULL DEFAULT '',      -- YYYY-MM-DD when the admin first wrote to the player
  note         TEXT NOT NULL DEFAULT '',
  updated_at   TEXT NOT NULL
);
