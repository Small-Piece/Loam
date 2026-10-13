-- 0005_groups_notes: labelled groups and text notes on a board's canvas.
-- One z order covers images, notes and groups; a group always draws behind
-- its own children, which are ordered by their own z inside it.

-- AUTOINCREMENT: an id is never reused, so an undo that re-inserts a
-- deleted group or note by id can never collide with a newer one.
CREATE TABLE board_groups (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id  INTEGER NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
  title     TEXT NOT NULL DEFAULT 'Group',
  color     TEXT NOT NULL,
  locked    INTEGER NOT NULL DEFAULT 1 CHECK (locked IN (0, 1)),
  z         INTEGER NOT NULL
) STRICT;

CREATE INDEX board_groups_board ON board_groups (board_id);

-- x and y are canvas units, except for a note attached to an image: then
-- they are the offset from the image's top-left corner in the image's own
-- pixels, so the note follows the image and its offset scales with it.
-- width NULL means the note sizes itself to its text.
CREATE TABLE board_notes (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id               INTEGER NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
  text                   TEXT NOT NULL DEFAULT '',
  x                      REAL NOT NULL,
  y                      REAL NOT NULL,
  width                  REAL CHECK (width IS NULL OR width > 0),
  font_size              TEXT NOT NULL DEFAULT 'M' CHECK (font_size IN ('S', 'M', 'L', 'XL')),
  color                  TEXT NOT NULL,
  background             INTEGER NOT NULL DEFAULT 1 CHECK (background IN (0, 1)),
  z                      INTEGER NOT NULL,
  attached_reference_id  INTEGER REFERENCES refs (id) ON DELETE CASCADE,
  group_id               INTEGER REFERENCES board_groups (id) ON DELETE SET NULL
) STRICT;

CREATE INDEX board_notes_board ON board_notes (board_id);
CREATE INDEX board_notes_attached ON board_notes (attached_reference_id);

ALTER TABLE board_items ADD COLUMN group_id INTEGER REFERENCES board_groups (id) ON DELETE SET NULL;
