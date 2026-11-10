CREATE TABLE round_two_result_freeze (
  id INTEGER PRIMARY KEY CHECK(id=1),
  snapshot_id TEXT NOT NULL REFERENCES round_two_result_snapshots(id),
  frozen_by TEXT NOT NULL,
  frozen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE round_two_result_freeze_history (
  id TEXT NOT NULL UNIQUE,
  snapshot_id TEXT NOT NULL REFERENCES round_two_result_snapshots(id),
  action TEXT NOT NULL CHECK(action IN('FROZEN','UNFROZEN')),
  actor TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 10 AND 1000),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sequence INTEGER PRIMARY KEY AUTOINCREMENT
);
CREATE INDEX round_two_result_freeze_history_created
ON round_two_result_freeze_history(sequence DESC);
