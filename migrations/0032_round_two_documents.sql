CREATE TABLE team_documents (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  version INTEGER NOT NULL CHECK(version > 0),
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL CHECK(length(filename) BETWEEN 1 AND 180),
  content_type TEXT NOT NULL CHECK(content_type IN(
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )),
  bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 2097152),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','STORED','FAILED')),
  uploaded_by_identity_id TEXT NOT NULL REFERENCES console_identities(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(team_id,version)
);
CREATE INDEX team_documents_history ON team_documents(team_id,version DESC,status);
CREATE TRIGGER immutable_team_document_identity
BEFORE UPDATE OF id,team_id,version,object_key,filename,content_type,bytes,sha256,uploaded_by_identity_id,created_at
ON team_documents BEGIN
  SELECT RAISE(ABORT,'Team document identity is immutable');
END;
CREATE TRIGGER immutable_team_document_history
BEFORE DELETE ON team_documents BEGIN
  SELECT RAISE(ABORT,'Team document history is immutable');
END;
CREATE TRIGGER team_document_status_transition
BEFORE UPDATE OF status ON team_documents
WHEN OLD.status <> 'PENDING' AND NEW.status <> OLD.status BEGIN
  SELECT RAISE(ABORT,'Stored document status is immutable');
END;
