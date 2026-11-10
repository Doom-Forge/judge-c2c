-- PRs for the four current challenge repositories are retained as source
-- attribution evidence until an approved evaluation profile exists. They do
-- not create matrix_runs and therefore cannot be dispatched to a container.
CREATE TABLE unverified_pr_submissions (
  repository_id INTEGER NOT NULL REFERENCES github_repositories(id),
  pr_number INTEGER NOT NULL,
  action TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  github_updated_at TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN (0,1)),
  delivery_id TEXT NOT NULL UNIQUE REFERENCES matrix_deliveries(id),
  payload_hash TEXT NOT NULL,
  author_id INTEGER NOT NULL,
  author_login TEXT NOT NULL,
  team_id TEXT REFERENCES teams(id),
  mapping_status TEXT NOT NULL CHECK(mapping_status IN ('MAPPED','MEMBER_NOT_REGISTERED','TRACK_NOT_SELECTED','TRACK_CONFLICT','TRACK_MISMATCH')),
  check_run_id INTEGER,
  check_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(check_status IN ('PENDING','PUBLISHING','PUBLISHED','FAILED')),
  check_lease_owner TEXT,
  check_lease_until INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(repository_id,pr_number)
);
CREATE INDEX unverified_pr_team ON unverified_pr_submissions(team_id,github_updated_at DESC);

-- A configured row is not approval. The matrix runner may dispatch only when
-- an exact immutable matrix digest and image digest have been reviewed.
CREATE TABLE matrix_profile_approvals (
  repository_id INTEGER PRIMARY KEY REFERENCES github_repositories(id),
  matrix_digest TEXT NOT NULL CHECK(length(matrix_digest)=64),
  image_uri TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
