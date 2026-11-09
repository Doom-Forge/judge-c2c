CREATE TABLE round_two_result_snapshots (
  id TEXT PRIMARY KEY,
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER immutable_round_two_result_snapshot
BEFORE UPDATE ON round_two_result_snapshots BEGIN
  SELECT RAISE(ABORT,'Round two result snapshots are immutable');
END;
CREATE TRIGGER immutable_round_two_result_snapshot_history
BEFORE DELETE ON round_two_result_snapshots BEGIN
  SELECT RAISE(ABORT,'Round two result snapshot history is immutable');
END;
CREATE TABLE round_two_result_publication (
  id INTEGER PRIMARY KEY CHECK(id=1),
  snapshot_id TEXT REFERENCES round_two_result_snapshots(id),
  updated_by TEXT NOT NULL,
  published_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK((snapshot_id IS NULL AND published_at IS NULL) OR
    (snapshot_id IS NOT NULL AND published_at IS NOT NULL))
);
CREATE TABLE round_two_result_publication_history (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT REFERENCES round_two_result_snapshots(id),
  action TEXT NOT NULL CHECK(action IN('PUBLISHED','WITHDRAWN')),
  actor TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 10 AND 1000),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX round_two_result_publication_history_created
ON round_two_result_publication_history(created_at DESC,id);
