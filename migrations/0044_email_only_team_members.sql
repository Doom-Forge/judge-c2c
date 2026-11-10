CREATE TABLE team_roster_members (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  hackathon_id TEXT NOT NULL REFERENCES hackathons(id),
  display_name TEXT NOT NULL,
  email TEXT NOT NULL,
  external_id TEXT,
  linked_team_member_id TEXT REFERENCES team_members(id),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  removed_at TEXT
);
CREATE UNIQUE INDEX one_active_roster_email
ON team_roster_members(hackathon_id,lower(email))
WHERE active=1;
CREATE UNIQUE INDEX one_active_roster_link
ON team_roster_members(linked_team_member_id)
WHERE active=1 AND linked_team_member_id IS NOT NULL;
CREATE INDEX roster_members_team ON team_roster_members(team_id,active);
ALTER TABLE console_identities
ADD COLUMN team_roster_member_id TEXT REFERENCES team_roster_members(id);
CREATE INDEX participant_identity_roster_member
ON console_identities(team_roster_member_id)
WHERE team_roster_member_id IS NOT NULL;
