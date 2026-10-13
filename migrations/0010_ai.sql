-- 0010_ai: local AI helpers. Settings, and tag suggestions kept apart from
-- real tags: nothing here is searched or filtered on until a suggestion is
-- accepted (then it becomes a normal row in ref_tags).

-- App-wide settings as JSON values (the AI switch, the pause list...).
CREATE TABLE app_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
) STRICT;

-- Tags a local model suggested for a reference. A rejected suggestion stays,
-- marked, so the same tag is never suggested for that image again.
CREATE TABLE tag_suggestions (
  ref_id      INTEGER NOT NULL REFERENCES refs (id) ON DELETE CASCADE,
  tag         TEXT NOT NULL,
  confidence  REAL NOT NULL,
  rejected    INTEGER NOT NULL DEFAULT 0 CHECK (rejected IN (0, 1)),
  PRIMARY KEY (ref_id, tag)
) STRICT, WITHOUT ROWID;

-- Which references the suggestion queue has looked at, and how it went:
-- suggested, unsupported (an image format the model cannot read) or failed.
CREATE TABLE tag_suggestion_runs (
  ref_id       INTEGER PRIMARY KEY REFERENCES refs (id) ON DELETE CASCADE,
  outcome      TEXT NOT NULL CHECK (outcome IN ('suggested', 'unsupported', 'failed')),
  finished_at  TEXT NOT NULL
) STRICT;
