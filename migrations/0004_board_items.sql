-- 0004_board_items: boards become canvases. A placement puts one Library
-- reference on one board at a position and size; being placed is what puts
-- a reference on a board, so board_items replaces board_refs.
-- Coordinates are canvas units. Drawn size = image size x scale.
-- rotation and flip are stored for later slices and stay 0 for now.

CREATE TABLE board_items (
  board_id      INTEGER NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
  reference_id  INTEGER NOT NULL REFERENCES refs (id) ON DELETE CASCADE,
  x             REAL NOT NULL,
  y             REAL NOT NULL,
  scale         REAL NOT NULL CHECK (scale > 0),
  rotation      REAL NOT NULL DEFAULT 0,
  z             INTEGER NOT NULL,
  flip_x        INTEGER NOT NULL DEFAULT 0 CHECK (flip_x IN (0, 1)),
  flip_y        INTEGER NOT NULL DEFAULT 0 CHECK (flip_y IN (0, 1)),
  PRIMARY KEY (board_id, reference_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX board_items_reference ON board_items (reference_id, board_id);

-- Existing memberships become placements in a simple grid, newest first,
-- 8 per row, each image scaled so its longest side is at most 600 units.
INSERT INTO board_items (board_id, reference_id, x, y, scale, z)
SELECT
  ranked.board_id,
  ranked.ref_id,
  ((ranked.position - 1) % 8) * 640.0,
  ((ranked.position - 1) / 8) * 640.0,
  min(1.0, 600.0 / max(ranked.image_width, ranked.image_height)),
  ranked.position
FROM (
  SELECT
    br.board_id,
    br.ref_id,
    r.image_width,
    r.image_height,
    ROW_NUMBER() OVER (PARTITION BY br.board_id ORDER BY r.created_at DESC, r.id DESC) AS position
  FROM board_refs br
  JOIN refs r ON r.id = br.ref_id
) AS ranked;

DROP TABLE board_refs;

-- Each board remembers whether it opens as a canvas or as a grid.
ALTER TABLE boards ADD COLUMN view_mode TEXT NOT NULL DEFAULT 'canvas'
  CHECK (view_mode IN ('canvas', 'grid'));
