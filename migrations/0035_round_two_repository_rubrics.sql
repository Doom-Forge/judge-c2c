CREATE TABLE round_two_repository_rubric_versions (
  id TEXT PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES github_repositories(id),
  version INTEGER NOT NULL CHECK(version > 0),
  criteria TEXT NOT NULL CHECK(json_valid(criteria)),
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(repository_id,version)
);
CREATE TABLE round_two_active_repository_rubrics (
  repository_id INTEGER PRIMARY KEY REFERENCES github_repositories(id),
  rubric_id TEXT NOT NULL REFERENCES round_two_repository_rubric_versions(id),
  actor TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER immutable_round_two_repository_rubric_version
BEFORE UPDATE ON round_two_repository_rubric_versions BEGIN
  SELECT RAISE(ABORT,'Repository rubric versions are immutable');
END;
CREATE TRIGGER immutable_round_two_repository_rubric_history
BEFORE DELETE ON round_two_repository_rubric_versions BEGIN
  SELECT RAISE(ABORT,'Repository rubric history is immutable');
END;
ALTER TABLE round_two_review_drafts
ADD COLUMN rubric_version_id TEXT REFERENCES round_two_repository_rubric_versions(id);
ALTER TABLE round_two_review_submissions
ADD COLUMN rubric_version_id TEXT REFERENCES round_two_repository_rubric_versions(id);
