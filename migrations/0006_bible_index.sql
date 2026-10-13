-- 0006_bible_index: the Creative Bible's index. The vault (a folder of
-- Markdown files) is the source of truth; everything here except the list of
-- known vaults can be deleted and is rebuilt from the files on the next open.

-- Vaults the app has opened; the most recently opened one is reopened on start.
CREATE TABLE bible_vaults (
  id              INTEGER PRIMARY KEY,
  path            TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  last_opened_at  TEXT NOT NULL,
  -- Vault-relative path of the entry that was open last, if any.
  last_entry      TEXT
) STRICT;

-- One row per entry file. path is vault-relative with forward slashes.
-- entry_id is the front-matter id, or "path:<path>" for a file without one.
CREATE TABLE bible_entries (
  vault_id   INTEGER NOT NULL REFERENCES bible_vaults (id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  entry_id   TEXT NOT NULL,
  section    TEXT NOT NULL,
  title      TEXT NOT NULL,
  -- Lower-cased, trimmed title: what [[links]] match against.
  title_key  TEXT NOT NULL,
  sort_order REAL NOT NULL,
  updated    TEXT,
  -- File modification time and size when indexed, to skip unchanged files.
  mtime_ms   REAL NOT NULL,
  size       INTEGER NOT NULL,
  PRIMARY KEY (vault_id, path)
) STRICT;

CREATE INDEX bible_entries_title ON bible_entries (vault_id, title_key);
CREATE INDEX bible_entries_id ON bible_entries (vault_id, entry_id);

-- Every [[link]] in an entry, by the lower-cased title it points at.
CREATE TABLE bible_links (
  vault_id     INTEGER NOT NULL,
  source_path  TEXT NOT NULL,
  target_key   TEXT NOT NULL,
  FOREIGN KEY (vault_id, source_path) REFERENCES bible_entries (vault_id, path) ON DELETE CASCADE
) STRICT;

CREATE INDEX bible_links_target ON bible_links (vault_id, target_key);
CREATE INDEX bible_links_source ON bible_links (vault_id, source_path);

-- Full-text search over titles and bodies, kept in step with bible_entries.
CREATE VIRTUAL TABLE bible_fts USING fts5 (
  vault_id UNINDEXED,
  path UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
