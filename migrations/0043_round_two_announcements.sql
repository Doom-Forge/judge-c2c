CREATE TABLE round_two_announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 5000),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX round_two_announcements_recent
ON round_two_announcements(created_at DESC,id DESC);
CREATE TRIGGER immutable_round_two_announcement_update
BEFORE UPDATE ON round_two_announcements BEGIN
  SELECT RAISE(ABORT,'Announcements are immutable');
END;
CREATE TRIGGER immutable_round_two_announcement_delete
BEFORE DELETE ON round_two_announcements BEGIN
  SELECT RAISE(ABORT,'Announcements are immutable');
END;
