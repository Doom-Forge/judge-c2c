CREATE TABLE round_two_team_final_scores (
  team_id TEXT PRIMARY KEY REFERENCES teams(id),
  judge_identity_id TEXT NOT NULL REFERENCES console_identities(id),
  score REAL NOT NULL CHECK(score BETWEEN 0 AND 100),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 10 AND 1000),
  evidence_summary TEXT NOT NULL CHECK(json_valid(evidence_summary)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX round_two_team_final_scores_judge
ON round_two_team_final_scores(judge_identity_id,created_at DESC);
CREATE TRIGGER immutable_round_two_team_final_score
BEFORE UPDATE ON round_two_team_final_scores BEGIN
  SELECT RAISE(ABORT,'Explicit team final scores are immutable');
END;
CREATE TRIGGER immutable_round_two_team_final_score_history
BEFORE DELETE ON round_two_team_final_scores BEGIN
  SELECT RAISE(ABORT,'Explicit team final score history is immutable');
END;
