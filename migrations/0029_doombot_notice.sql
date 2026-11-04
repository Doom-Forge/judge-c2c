CREATE TABLE IF NOT EXISTS matrix_doombot_notices(repository_id INTEGER NOT NULL,pr_number INTEGER NOT NULL,comment_id INTEGER,body_hash TEXT,lease_owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0,last_error TEXT,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(repository_id,pr_number));
UPDATE matrix_runs SET publication_status='NOTICE_ONLY';
