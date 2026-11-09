CREATE TABLE round_two_review_drafts (
  team_id TEXT NOT NULL REFERENCES teams(id),
  judge_identity_id TEXT NOT NULL REFERENCES console_identities(id),
  stage TEXT NOT NULL CHECK(stage IN('ANALYSIS','ENGINEERING')),
  score REAL CHECK(score IS NULL OR score BETWEEN 0 AND 100),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  document_id TEXT REFERENCES team_documents(id),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(team_id,judge_identity_id,stage)
);
CREATE INDEX round_two_review_drafts_judge
ON round_two_review_drafts(judge_identity_id,stage,updated_at DESC);
CREATE TABLE round_two_review_submissions (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  judge_identity_id TEXT NOT NULL REFERENCES console_identities(id),
  stage TEXT NOT NULL CHECK(stage IN('ANALYSIS','ENGINEERING')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  score REAL NOT NULL CHECK(score BETWEEN 0 AND 100),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  document_id TEXT REFERENCES team_documents(id),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(team_id,judge_identity_id,stage,revision)
);
CREATE INDEX round_two_review_submissions_team
ON round_two_review_submissions(team_id,stage,submitted_at DESC);
CREATE INDEX round_two_review_submissions_judge
ON round_two_review_submissions(judge_identity_id,stage,submitted_at DESC);
CREATE TRIGGER immutable_round_two_review_submission
BEFORE UPDATE ON round_two_review_submissions BEGIN
  SELECT RAISE(ABORT,'Submitted review history is immutable');
END;
CREATE TRIGGER immutable_round_two_review_submission_history
BEFORE DELETE ON round_two_review_submissions BEGIN
  SELECT RAISE(ABORT,'Submitted review history is immutable');
END;
