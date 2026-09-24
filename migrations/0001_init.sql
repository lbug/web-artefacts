-- Artifacts: one row per URL. version_counter hands out version numbers atomically.
CREATE TABLE IF NOT EXISTS artifacts (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  version_counter INTEGER NOT NULL DEFAULT 0
);

-- One row per published version; the HTML itself lives in the blob store.
CREATE TABLE IF NOT EXISTS versions (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  version     INTEGER NOT NULL,
  title       TEXT NOT NULL,
  agent       TEXT,
  size        INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version)
);

CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  version     INTEGER NOT NULL,
  author      TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'user', -- 'user' (viewer) or 'agent' (MCP note)
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS comments_by_artifact ON comments(artifact_id, id);
