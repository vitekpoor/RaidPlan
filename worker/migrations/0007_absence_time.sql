-- Late arrival time ("Přijdu dýl" + HH:MM) for absences (Omluvenky form). Applied by POST /api/admin/migrate;
-- ALTER TABLE ... ADD COLUMN is not idempotent, the migrate loop skips the "duplicate column name" error on re-runs.
ALTER TABLE absences ADD COLUMN time TEXT;
