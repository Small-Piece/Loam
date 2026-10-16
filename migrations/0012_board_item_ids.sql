-- 0012_board_item_ids: a placement gets its own id, so one image can be placed
-- on a board more than once. Notes attach to a placement instead of to an
-- image, so a note stays on the one copy it was attached to.
--
-- Every placement keeps all its values (position, scale, rotation, z, flips,
-- group). Ids are handed out per board in draw order (z, then reference id,
-- the order the canvas used to break z ties), so the canvas draws exactly as
-- before. AUTOINCREMENT, as in 0005: an undo that re-inserts a removed
-- placement by id can never collide with a newer one.

CREATE TABLE board_items_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id      INTEGER NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
  reference_id  INTEGER NOT NULL REFERENCES refs (id) ON DELETE CASCADE,
  x             REAL NOT NULL,
  y             REAL NOT NULL,
  scale         REAL NOT NULL CHECK (scale > 0),
  rotation      REAL NOT NULL DEFAULT 0,
  z             INTEGER NOT NULL,
  flip_x        INTEGER NOT NULL DEFAULT 0 CHECK (flip_x IN (0, 1)),
  flip_y        INTEGER NOT NULL DEFAULT 0 CHECK (flip_y IN (0, 1)),
  group_id      INTEGER REFERENCES board_groups (id) ON DELETE SET NULL
) STRICT;

INSERT INTO board_items_new
  (board_id, reference_id, x, y, scale, rotation, z, flip_x, flip_y, group_id)
SELECT board_id, reference_id, x, y, scale, rotation, z, flip_x, flip_y, group_id
FROM board_items
ORDER BY board_id, z, reference_id;

DROP TABLE board_items;
ALTER TABLE board_items_new RENAME TO board_items;

CREATE INDEX board_items_board ON board_items (board_id, z);
CREATE INDEX board_items_reference ON board_items (reference_id, board_id);

-- Notes: attached_reference_id is replaced by attached_item_id, filled from the
-- placement of that image on the note's board (there was at most one). A note
-- goes with its placement when that is removed. Every note keeps its id.
-- A note whose image was not on its board could not be shown or reached
-- (0005 never allowed one); such a note is not carried over.

CREATE TABLE board_notes_new (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id          INTEGER NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
  text              TEXT NOT NULL DEFAULT '',
  x                 REAL NOT NULL,
  y                 REAL NOT NULL,
  width             REAL CHECK (width IS NULL OR width > 0),
  font_size         TEXT NOT NULL DEFAULT 'M' CHECK (font_size IN ('S', 'M', 'L', 'XL')),
  color             TEXT NOT NULL,
  background        INTEGER NOT NULL DEFAULT 1 CHECK (background IN (0, 1)),
  z                 INTEGER NOT NULL,
  attached_item_id  INTEGER REFERENCES board_items (id) ON DELETE CASCADE,
  group_id          INTEGER REFERENCES board_groups (id) ON DELETE SET NULL
) STRICT;

INSERT INTO board_notes_new
  (id, board_id, text, x, y, width, font_size, color, background, z, attached_item_id, group_id)
SELECT n.id, n.board_id, n.text, n.x, n.y, n.width, n.font_size, n.color, n.background, n.z,
  bi.id, n.group_id
FROM board_notes n
LEFT JOIN board_items bi ON bi.board_id = n.board_id AND bi.reference_id = n.attached_reference_id
WHERE n.attached_reference_id IS NULL OR bi.id IS NOT NULL
ORDER BY n.id;

-- Keep the note id counter, so ids of deleted notes are never handed out again.
DELETE FROM sqlite_sequence WHERE name = 'board_notes_new';
INSERT INTO sqlite_sequence (name, seq)
SELECT 'board_notes_new', seq FROM sqlite_sequence WHERE name = 'board_notes';

DROP TABLE board_notes;
ALTER TABLE board_notes_new RENAME TO board_notes;

CREATE INDEX board_notes_board ON board_notes (board_id);
CREATE INDEX board_notes_attached ON board_notes (attached_item_id);
