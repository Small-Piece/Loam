-- 0007_bible_tags: the bible index also keeps each entry's tags, for tag
-- autocomplete in the Properties panel.
ALTER TABLE bible_entries ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';

-- Rows indexed before this migration have no tags. The bible index is
-- rebuildable from the vault files, so it is cleared here and every vault
-- is read again the next time it opens. The vault files are not touched.
DELETE FROM bible_fts;
DELETE FROM bible_links;
DELETE FROM bible_entries;
