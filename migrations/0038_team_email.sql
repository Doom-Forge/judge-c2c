ALTER TABLE hackathons ADD COLUMN team_email_enabled INTEGER NOT NULL DEFAULT 0
CHECK(team_email_enabled IN (0,1));
CREATE TABLE team_email_deliveries (
  idempotency_key TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  recipient TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('SENDING','SENT','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX team_email_deliveries_created ON team_email_deliveries(created_at);
