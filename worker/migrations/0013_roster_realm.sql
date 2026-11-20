-- Roster characters get an optional realm: two characters may share a name when they live on different realms
-- (name + realm is the identity). Everything keyed by the character name (sims, vault, crests) then uses the
-- label "Name-Realm" for those characters only – see labelCharacters in worker/roster.js.

ALTER TABLE roster_characters ADD COLUMN realm TEXT NOT NULL DEFAULT '';
