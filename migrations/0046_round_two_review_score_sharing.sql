CREATE TABLE round_two_review_score_shares (
  submission_id TEXT PRIMARY KEY REFERENCES round_two_review_submissions(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  judge_identity_id TEXT NOT NULL REFERENCES console_identities(id),
  shared_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX round_two_review_score_shares_team
ON round_two_review_score_shares(team_id,revoked_at,updated_at DESC);
