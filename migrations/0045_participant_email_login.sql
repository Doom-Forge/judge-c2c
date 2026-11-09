CREATE TABLE participant_email_login_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL CHECK(length(code_hash)=64),
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_nonce TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX participant_email_login_codes_email ON participant_email_login_codes(email,expires_at);
