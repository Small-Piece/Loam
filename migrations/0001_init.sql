-- 0001_init: key/value metadata, including the schema version.
-- The migration runner writes meta.schema_version after each migration.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;
