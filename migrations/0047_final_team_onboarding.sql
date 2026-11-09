ALTER TABLE teams ADD COLUMN track_finalized INTEGER NOT NULL DEFAULT 0 CHECK(track_finalized IN(0,1));
ALTER TABLE console_identities ADD COLUMN github_verified_at TEXT;
CREATE TRIGGER team_track_finalized_insert
BEFORE INSERT ON team_repositories
WHEN EXISTS(SELECT 1 FROM teams WHERE id=NEW.team_id AND track_finalized=1)
BEGIN
  SELECT RAISE(ABORT,'TEAM_TRACK_FINALIZED');
END;
CREATE TRIGGER team_track_finalized_update
BEFORE UPDATE ON team_repositories
WHEN EXISTS(SELECT 1 FROM teams WHERE id=OLD.team_id AND track_finalized=1)
BEGIN
  SELECT RAISE(ABORT,'TEAM_TRACK_FINALIZED');
END;
CREATE TRIGGER team_track_finalized_delete
BEFORE DELETE ON team_repositories
WHEN EXISTS(SELECT 1 FROM teams WHERE id=OLD.team_id AND track_finalized=1)
BEGIN
  SELECT RAISE(ABORT,'TEAM_TRACK_FINALIZED');
END;
