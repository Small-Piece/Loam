-- 0009_journal: the study journal and the link picker's memory.

-- What a vault is to the app: a game bible, or the study journal (a vault
-- made from the Journal kit). Vaults known so far are bibles.
ALTER TABLE bible_vaults ADD COLUMN role TEXT NOT NULL DEFAULT 'bible';

-- The section the user last chose for an entry created from a missing link,
-- per vault and the section the link was in.
CREATE TABLE bible_link_sections (
  vault_id        INTEGER NOT NULL REFERENCES bible_vaults (id) ON DELETE CASCADE,
  source_section  TEXT NOT NULL,
  target_section  TEXT NOT NULL,
  PRIMARY KEY (vault_id, source_section)
) STRICT;
