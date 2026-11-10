ALTER TABLE console_identities ADD COLUMN team_member_id TEXT REFERENCES team_members(id);
CREATE TABLE team_invitation_codes (
  team_id TEXT PRIMARY KEY REFERENCES teams(id),
  code_hash TEXT NOT NULL CHECK(length(code_hash)=64),
  nonce TEXT NOT NULL CHECK(length(nonce)=32),
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE team_invitations (
  idempotency_key TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  recipient TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('PENDING','SENDING','SENT','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX team_invitations_pending ON team_invitations(status,updated_at);
CREATE TABLE participant_verification_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE team_invitation_uses (
  team_id TEXT NOT NULL REFERENCES teams(id),
  email TEXT NOT NULL,
  identity_id TEXT NOT NULL REFERENCES console_identities(id),
  used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(team_id,email)
);
