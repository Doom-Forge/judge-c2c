CREATE TABLE round_two_judge_assignments (
  id TEXT PRIMARY KEY,
  judge_identity_id TEXT NOT NULL REFERENCES console_identities(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  assigned_by TEXT NOT NULL,
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT,
  revoked_by TEXT,
  reason TEXT
);
CREATE UNIQUE INDEX active_round_two_judge_team
ON round_two_judge_assignments(judge_identity_id,team_id)
WHERE revoked_at IS NULL;
CREATE INDEX round_two_judge_assignments_team
ON round_two_judge_assignments(judge_identity_id,revoked_at,team_id);
CREATE TRIGGER immutable_round_two_judge_assignment
BEFORE UPDATE OF id,judge_identity_id,team_id,assigned_by,assigned_at
ON round_two_judge_assignments BEGIN
  SELECT RAISE(ABORT,'Judge assignment identity is immutable');
END;
CREATE TRIGGER immutable_round_two_judge_assignment_history
BEFORE DELETE ON round_two_judge_assignments BEGIN
  SELECT RAISE(ABORT,'Judge assignment history is immutable');
END;
