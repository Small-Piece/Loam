import type {
  BoardQuery,
  BoardSummary,
  BoardView,
  BoardGroup,
  BoardNote,
  BoardViewMode,
  CanvasItem,
  ImageHashMatch,
  ImageSize,
  ItemState,
  NewReference,
  PurgeResult,
  ReferenceDetail,
  ReferencePatch,
} from './types.ts'

/** Persistence for references, tags and boards (SQLite in the desktop app). */
export interface ReferenceRepository {
  /** Finds the reference holding this image, whether in the Library or the Trash. */
  findByImageHash(hash: string): ImageHashMatch | null
  /** Inserts unless the image hash is already stored; either way returns the reference id. */
  insertOrGet(reference: NewReference): { id: number; created: boolean }
  /** Runs work atomically: everything it writes is saved, or nothing is. */
  inTransaction<T>(work: () => T): T
  /**
   * Takes references off one board only (their notes attached on that board
   * go too); returns the item states that were removed.
   */
  removeFromBoard(boardId: number, refIds: readonly number[]): ItemState[]
  /** Inserts items, or moves, rescales and regroups the ones already on the board. */
  upsertItems(boardId: number, items: readonly ItemState[]): void
  listGroups(boardId: number): BoardGroup[]
  /** Notes on a board. includeTrashed also returns notes attached to images in the Trash. */
  listNotes(boardId: number, includeTrashed: boolean): BoardNote[]
  /** Board of a group or note id, or null when it does not exist. */
  boardOfGroup(groupId: number): number | null
  boardOfNote(noteId: number): number | null
  /** Inserts (no id) or replaces (with id, also re-inserting a deleted one) a group; returns its id. */
  putGroup(boardId: number, group: Omit<BoardGroup, 'id'> & { id?: number | undefined }): number
  deleteGroups(boardId: number, ids: readonly number[]): void
  putNote(boardId: number, note: Omit<BoardNote, 'id'> & { id?: number | undefined }): number
  deleteNotes(boardId: number, ids: readonly number[]): void
  /** Deletes groups with no items and no notes left; returns their ids. */
  deleteEmptyGroups(boardId: number | null): number[]
  /** Items on a board in z order. includeTrashed also returns references in the Trash. */
  listCanvas(boardId: number, includeTrashed: boolean): CanvasItem[]
  /** Image sizes of existing references (Library or Trash); unknown ids are left out. */
  imageSizes(refIds: readonly number[]): ImageSize[]
  getBoard(boardId: number): BoardSummary | null
  setViewMode(boardId: number, mode: BoardViewMode): void
  boardExists(boardId: number): boolean
  getDetail(id: number): ReferenceDetail | null
  /** Applies a normalized patch atomically; returns false when the reference is missing. */
  update(id: number, patch: ReferencePatch): boolean
  listBoard(query: BoardQuery): BoardView
  createBoard(name: string, createdAt: string): BoardSummary
  /** Names of the tags used by references in the Library (not the Trash). */
  tagNames(): string[]
  /** What copying references into a bible needs: their image and thumbnail hashes. */
  assetInfo(ids: readonly number[]): Array<{
    id: number
    title: string
    imageHash: string
    imageMime: string
    thumbHash: string
  }>
  findBoardByName(name: string): BoardSummary | null
  /** Moves Library references to the Trash; returns the ids that moved. */
  moveToTrash(refIds: readonly number[], deletedAt: string): number[]
  /** Brings references back from the Trash; returns the ids that came back. */
  restoreFromTrash(refIds: readonly number[]): number[]
  /** Permanently deletes every reference in the Trash, atomically. */
  purgeTrash(): PurgeResult
  /** True when any reference (Library or Trash) uses the hash as image or thumbnail. */
  isHashUsed(hash: string): boolean
}

/** Content-addressed binary store: bytes are filed under their SHA-256 hash. */
export interface BlobStore {
  put(hash: string, bytes: Uint8Array): Promise<void>
  /** Removes the blob; resolves false when it did not exist. */
  delete(hash: string): Promise<boolean>
}

export interface Hasher {
  /** Lowercase hex SHA-256 of the bytes. */
  sha256(bytes: Uint8Array): string
}

export interface Clock {
  now(): Date
}
