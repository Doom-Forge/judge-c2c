CREATE TABLE github_connections (
  organization TEXT PRIMARY KEY CHECK(organization IN('Doom-Forge','180DC-VIT-CHENNAI')),
  app_id INTEGER NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  encrypted TEXT NOT NULL,
  installation_id INTEGER,
  suspended INTEGER NOT NULL DEFAULT 0 CHECK(suspended IN(0,1))
);

INSERT OR IGNORE INTO github_connections(
  organization, app_id, slug, encrypted, installation_id
)
SELECT 'Doom-Forge', app_id, slug, encrypted, installation_id
FROM github_connection
WHERE id=1;

UPDATE github_connections
SET suspended=COALESCE((SELECT suspended FROM github_connection WHERE id=1),0)
WHERE organization='Doom-Forge';

ALTER TABLE github_setup_states
ADD COLUMN organization TEXT NOT NULL DEFAULT 'Doom-Forge'
CHECK(organization IN('Doom-Forge','180DC-VIT-CHENNAI'));
