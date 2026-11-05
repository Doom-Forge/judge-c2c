CREATE TABLE matrix_start_reservations(owner TEXT PRIMARY KEY, reserved_ms INTEGER NOT NULL, reserved_seconds INTEGER NOT NULL CHECK(reserved_seconds=180));
CREATE INDEX matrix_start_reservations_time ON matrix_start_reservations(reserved_ms);
CREATE TABLE matrix_baseline_cache(repository TEXT NOT NULL, baseline_sha TEXT NOT NULL, matrix_digest TEXT NOT NULL, image_uri TEXT NOT NULL, report TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(repository,baseline_sha,matrix_digest,image_uri));
