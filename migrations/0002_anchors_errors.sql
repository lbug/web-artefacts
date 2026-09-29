-- The element a comment points at, as JSON: {"selector": "...", "text": "..."}.
ALTER TABLE comments ADD COLUMN anchor TEXT;

-- Errors the viewer saw while showing a version: exceptions, failed loads,
-- requests blocked by the CSP. One row per distinct message and version.
CREATE TABLE IF NOT EXISTS errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  version     INTEGER NOT NULL,
  message     TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 1,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  UNIQUE (artifact_id, version, message)
);
