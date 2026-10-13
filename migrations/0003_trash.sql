-- 0003_trash: soft delete. A reference with deleted_at set is in the Trash;
-- its tags and board memberships stay intact so a restore brings it back whole.

ALTER TABLE refs ADD COLUMN deleted_at TEXT;

CREATE INDEX refs_deleted_at ON refs (deleted_at) WHERE deleted_at IS NOT NULL;

-- Emptying the Trash checks whether a file is still used as an image or a thumbnail.
CREATE INDEX refs_thumb_hash ON refs (thumb_hash);
