-- The project an artifact belongs to: the name of the agent's git repository
-- (or working directory). NULL when the agent had no project directory.
ALTER TABLE artifacts ADD COLUMN project TEXT;
