-- 0011_board_order: boards keep the order the user gives them in the sidebar.
-- Before this, the sidebar sorted boards by name (case-insensitive). Existing boards
-- get positions in that same order, so the sidebar looks the same after the upgrade.
-- Board names are unique (case-insensitive), so every board gets its own position.

ALTER TABLE boards ADD COLUMN position INTEGER;

UPDATE boards
SET position = (
  SELECT COUNT(*) FROM boards AS earlier
  WHERE earlier.name COLLATE NOCASE < boards.name COLLATE NOCASE
);
