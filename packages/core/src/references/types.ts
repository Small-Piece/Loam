/** Image formats the board accepts, identified by file signature, not by name. */
export type ImageMime =
  'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/bmp' | 'image/avif'

/** A decoded image as handed to the importer: original bytes plus a thumbnail. */
export interface ImageUpload {
  fileName: string
  bytes: Uint8Array
  width: number
  height: number
  thumbnail: {
    bytes: Uint8Array
    width: number
    height: number
  }
}

export type ImportOutcome =
  | { fileName: string; status: 'created'; id: number }
  | { fileName: string; status: 'duplicate'; id: number }
  /** The image was in the Trash; importing it again brought it back unchanged. */
  | { fileName: string; status: 'restored'; id: number }
  | { fileName: string; status: 'rejected'; reason: string }

/** Everything stored for a new reference, ready for the repository. */
export interface NewReference {
  imageHash: string
  imageMime: ImageMime
  imageBytes: number
  imageWidth: number
  imageHeight: number
  thumbHash: string
  thumbWidth: number
  thumbHeight: number
  title: string
  createdAt: string
}

export interface ReferenceCard {
  id: number
  title: string
  thumbHash: string
  thumbWidth: number
  thumbHeight: number
  /** The full image, so the viewer can open and step through cards without another fetch. */
  imageHash: string
  imageWidth: number
  imageHeight: number
  tags: string[]
}

export interface ReferenceDetail {
  id: number
  title: string
  note: string
  source: string
  createdAt: string
  tags: string[]
  boardIds: number[]
  imageHash: string
  imageMime: string
  imageBytes: number
  imageWidth: number
  imageHeight: number
  /** Set while the reference is in the Trash. */
  deletedAt: string | null
}

/** Fields to change; an absent or undefined field is left as it is. */
export interface ReferencePatch {
  title?: string | undefined
  note?: string | undefined
  source?: string | undefined
  tags?: string[] | undefined
  boardIds?: number[] | undefined
}

export type BoardViewMode = 'canvas' | 'grid'

export interface BoardSummary {
  id: number
  name: string
  count: number
  viewMode: BoardViewMode
}

export interface TagCount {
  name: string
  count: number
}

/**
 * Board view query. A null boardId means every reference in the Library;
 * inTrash lists the Trash instead (boardId must then be null). Tags combine with AND.
 */
export interface BoardQuery {
  boardId: number | null
  inTrash: boolean
  tags: string[]
  text: string
}

export interface BoardView {
  boards: BoardSummary[]
  /** References in the Library, not counting the Trash. */
  totalCount: number
  trashCount: number
  tags: TagCount[]
  items: ReferenceCard[]
}

export interface ImageHashMatch {
  id: number
  inTrash: boolean
}

export interface PurgeResult {
  purgedIds: number[]
  /** Hashes that belonged to purged references and are used by no remaining reference. */
  unusedHashes: string[]
}

export interface EmptyTrashResult {
  deletedReferences: number
  deletedFiles: number
}

/** Where a reference sits on one board's canvas. Drawn size = image size x scale. */
export interface Placement {
  referenceId: number
  x: number
  y: number
  scale: number
  z: number
}

/** A placement plus what the canvas needs to draw it. */
export interface CanvasItem extends Placement {
  /** The group the item belongs to on this board, if any. */
  groupId: number | null
  title: string
  thumbHash: string
  thumbWidth: number
  thumbHeight: number
  imageHash: string
  imageWidth: number
  imageHeight: number
  /** Stored for later slices (rotate, flip); always 0 / false for now. */
  rotation: number
  flipX: boolean
  flipY: boolean
}

export interface CanvasView {
  board: BoardSummary
  items: CanvasItem[]
  groups: BoardGroup[]
  notes: BoardNote[]
}

export interface Point {
  x: number
  y: number
}

export interface ImageSize {
  referenceId: number
  width: number
  height: number
}

/** Preset colours for group backgrounds and note text, chosen to read on the dark theme. */
export const PALETTE = [
  'paper',
  'slate',
  'blue',
  'teal',
  'green',
  'amber',
  'red',
  'violet',
  'pink',
] as const
export type PaletteColor = (typeof PALETTE)[number]

export const NOTE_SIZES = ['S', 'M', 'L', 'XL'] as const
export type NoteSize = (typeof NOTE_SIZES)[number]

/** An item's full state on a board: where it is and which group it is in. */
export interface ItemState extends Placement {
  groupId: number | null
}

export interface BoardGroup {
  id: number
  title: string
  color: PaletteColor
  locked: boolean
  z: number
}

/**
 * A text note on a board. When attachedReferenceId is set, x and y are the
 * offset from that image's top-left corner in the image's own pixels.
 */
export interface BoardNote {
  id: number
  text: string
  x: number
  y: number
  /** null: the note sizes itself to its text. */
  width: number | null
  fontSize: NoteSize
  color: PaletteColor
  background: boolean
  z: number
  attachedReferenceId: number | null
  groupId: number | null
}

/**
 * Items, groups and notes in an edit can point at a group created in the
 * same edit by its client key instead of an id.
 */
export interface GroupLink {
  groupId: number | null
  groupKey?: string | undefined
}

export type GroupInput = Omit<BoardGroup, 'id'> & {
  id?: number | undefined
  key?: string | undefined
}
export type NoteInput = Omit<BoardNote, 'id' | 'groupId'> &
  GroupLink & { id?: number | undefined; key?: string | undefined }
export type ItemInput = Placement & GroupLink

/** One step of a canvas edit. A whole edit applies atomically. */
export type CanvasOp =
  | { op: 'putItems'; items: ItemInput[] }
  | { op: 'removeItems'; referenceIds: number[] }
  | { op: 'putGroups'; groups: GroupInput[] }
  | { op: 'deleteGroups'; ids: number[] }
  | { op: 'putNotes'; notes: NoteInput[] }
  | { op: 'deleteNotes'; ids: number[] }

export interface ApplyResult {
  view: CanvasView
  /** Applying these puts the board back exactly as it was before the edit. */
  undo: CanvasOp[]
  /** Ids given to groups and notes created with a client key. */
  created: { groups: Record<string, number>; notes: Record<string, number> }
}
