-- 0008_bible_refs: what the decision tools need from the bible index.

-- Entries that a field points at (entry and entries fields, pillars,
-- promoted_to/from), as stored: an id, or a title typed by hand.
CREATE TABLE bible_refs (
  vault_id     INTEGER NOT NULL,
  source_path  TEXT NOT NULL,
  field_key    TEXT NOT NULL,
  target       TEXT NOT NULL,
  -- Lower-cased, trimmed target, to match a title typed by hand.
  target_key   TEXT NOT NULL,
  FOREIGN KEY (vault_id, source_path) REFERENCES bible_entries (vault_id, path) ON DELETE CASCADE
) STRICT;

CREATE INDEX bible_refs_target ON bible_refs (vault_id, target);
CREATE INDEX bible_refs_target_key ON bible_refs (vault_id, target_key);
CREATE INDEX bible_refs_source ON bible_refs (vault_id, source_path);

-- Images an entry uses from <vault>/_assets, by content hash, so the
-- Library can show where its references are used.
CREATE TABLE bible_assets (
  vault_id     INTEGER NOT NULL,
  source_path  TEXT NOT NULL,
  asset_hash   TEXT NOT NULL,
  FOREIGN KEY (vault_id, source_path) REFERENCES bible_entries (vault_id, path) ON DELETE CASCADE
) STRICT;

CREATE INDEX bible_assets_hash ON bible_assets (asset_hash);

ALTER TABLE bible_entries ADD COLUMN created TEXT;

-- The starter-kit fingerprint the user last applied or dismissed, so the
-- "Kit updates available" notice stays away until the kit changes again.
ALTER TABLE bible_vaults ADD COLUMN kit_seen TEXT;

-- The new tables and column are filled when files are read. The index is
-- rebuildable, so it is cleared and every vault is read again on its next
-- open. Vault files are not touched.
DELETE FROM bible_fts;
DELETE FROM bible_links;
DELETE FROM bible_entries;
