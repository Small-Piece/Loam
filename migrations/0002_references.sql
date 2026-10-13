-- 0002_references: image references, tags, boards and full-text search.
-- Image and thumbnail bytes live in the content-addressed file store;
-- this schema keeps only their SHA-256 hashes.

CREATE TABLE refs (
  id            INTEGER PRIMARY KEY,
  image_hash    TEXT NOT NULL UNIQUE,
  image_mime    TEXT NOT NULL,
  image_bytes   INTEGER NOT NULL,
  image_width   INTEGER NOT NULL,
  image_height  INTEGER NOT NULL,
  thumb_hash    TEXT NOT NULL,
  thumb_width   INTEGER NOT NULL,
  thumb_height  INTEGER NOT NULL,
  title         TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
) STRICT;

CREATE INDEX refs_created_at ON refs (created_at DESC, id DESC);

CREATE TABLE tags (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE ref_tags (
  ref_id  INTEGER NOT NULL REFERENCES refs (id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (ref_id, tag_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX ref_tags_tag ON ref_tags (tag_id, ref_id);

CREATE TABLE boards (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at  TEXT NOT NULL
) STRICT;

CREATE TABLE board_refs (
  board_id  INTEGER NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
  ref_id    INTEGER NOT NULL REFERENCES refs (id) ON DELETE CASCADE,
  PRIMARY KEY (board_id, ref_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX board_refs_ref ON board_refs (ref_id, board_id);

-- Full-text index over title and note, kept in sync by triggers.
CREATE VIRTUAL TABLE refs_fts USING fts5 (
  title,
  note,
  content = 'refs',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER refs_fts_insert AFTER INSERT ON refs BEGIN
  INSERT INTO refs_fts (rowid, title, note) VALUES (new.id, new.title, new.note);
END;

CREATE TRIGGER refs_fts_delete AFTER DELETE ON refs BEGIN
  INSERT INTO refs_fts (refs_fts, rowid, title, note) VALUES ('delete', old.id, old.title, old.note);
END;

CREATE TRIGGER refs_fts_update AFTER UPDATE OF title, note ON refs BEGIN
  INSERT INTO refs_fts (refs_fts, rowid, title, note) VALUES ('delete', old.id, old.title, old.note);
  INSERT INTO refs_fts (rowid, title, note) VALUES (new.id, new.title, new.note);
END;
