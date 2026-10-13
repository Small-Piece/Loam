import { z } from 'zod'

const id = z.number().int().positive()
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const dimension = z.number().int().positive().max(32_768)
const bytes = (max: number) =>
  z.instanceof(Uint8Array).refine((value) => value.length <= max, {
    message: `Must be at most ${max} bytes`,
  })

const tagName = z.string().max(100)
/** A selection acted on in one round trip (delete, restore, remove from board). */
const idList = z.array(id).min(1).max(10_000)
const coordinate = z.number().finite().min(-1e9).max(1e9)
/** A point in canvas units (not screen pixels). */
const point = z.strictObject({ x: coordinate, y: coordinate })
const viewMode = z.enum(['canvas', 'grid'])

/** Where a reference sits on a board's canvas. Drawn size = image size x scale. */
export const placementSchema = z.strictObject({
  referenceId: id,
  x: coordinate,
  y: coordinate,
  scale: z.number().finite().min(0.005).max(50),
  z: z.number().int().min(-1e9).max(1e9),
})

const zOrder = z.number().int().min(-1e9).max(1e9)
/** Preset colours that read on the dark theme (group backgrounds, note text). */
export const paletteSchema = z.enum([
  'paper',
  'slate',
  'blue',
  'teal',
  'green',
  'amber',
  'red',
  'violet',
  'pink',
])
export const noteSizeSchema = z.enum(['S', 'M', 'L', 'XL'])
/** Client key naming a group or note created in the same edit. */
const clientKey = z.string().min(1).max(64)

export const groupSchema = z.strictObject({
  id,
  title: z.string().max(200),
  color: paletteSchema,
  locked: z.boolean(),
  z: zOrder,
})

export const noteSchema = z.strictObject({
  id,
  text: z.string().max(10_000),
  x: coordinate,
  y: coordinate,
  width: z.number().finite().min(10).max(20_000).nullable(),
  fontSize: noteSizeSchema,
  color: paletteSchema,
  background: z.boolean(),
  z: zOrder,
  attachedReferenceId: id.nullable(),
  groupId: id.nullable(),
})

const groupLink = { groupId: id.nullable(), groupKey: clientKey.optional() }

/** One step of a canvas edit; the whole edit applies atomically. */
export const canvasOpSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('putItems'),
    items: z.array(z.strictObject({ ...placementSchema.shape, ...groupLink })).max(10_000),
  }),
  z.strictObject({ op: z.literal('removeItems'), referenceIds: z.array(id).max(10_000) }),
  z.strictObject({
    op: z.literal('putGroups'),
    groups: z
      .array(
        z.strictObject({
          ...groupSchema.omit({ id: true }).shape,
          id: id.optional(),
          key: clientKey.optional(),
        }),
      )
      .max(1_000),
  }),
  z.strictObject({ op: z.literal('deleteGroups'), ids: z.array(id).max(1_000) }),
  z.strictObject({
    op: z.literal('putNotes'),
    notes: z
      .array(
        z.strictObject({
          ...noteSchema.omit({ id: true, groupId: true }).shape,
          ...groupLink,
          id: id.optional(),
          key: clientKey.optional(),
        }),
      )
      .max(10_000),
  }),
  z.strictObject({ op: z.literal('deleteNotes'), ids: z.array(id).max(10_000) }),
])

export const canvasItemSchema = z.strictObject({
  ...placementSchema.shape,
  groupId: id.nullable(),
  title: z.string(),
  thumbHash: hash,
  thumbWidth: dimension,
  thumbHeight: dimension,
  imageHash: hash,
  imageWidth: dimension,
  imageHeight: dimension,
  rotation: z.number().finite(),
  flipX: z.boolean(),
  flipY: z.boolean(),
})

export const referenceCardSchema = z.strictObject({
  id,
  title: z.string(),
  thumbHash: hash,
  thumbWidth: dimension,
  thumbHeight: dimension,
  imageHash: hash,
  imageWidth: dimension,
  imageHeight: dimension,
  tags: z.array(z.string()),
})

export const referenceDetailSchema = z.strictObject({
  id,
  title: z.string(),
  note: z.string(),
  source: z.string(),
  createdAt: z.iso.datetime(),
  tags: z.array(z.string()),
  boardIds: z.array(id),
  imageHash: hash,
  imageMime: z.string(),
  imageBytes: z.number().int().nonnegative(),
  imageWidth: dimension,
  imageHeight: dimension,
  deletedAt: z.iso.datetime().nullable(),
})

export const boardSummarySchema = z.strictObject({
  id,
  name: z.string(),
  count: z.number().int().nonnegative(),
  viewMode,
})

export const imageUploadSchema = z.strictObject({
  fileName: z.string().max(260),
  bytes: bytes(64 * 1024 * 1024),
  width: dimension,
  height: dimension,
  thumbnail: z.strictObject({
    bytes: bytes(2 * 1024 * 1024),
    width: dimension,
    height: dimension,
  }),
})

export type ReferenceCard = z.infer<typeof referenceCardSchema>
export type ReferenceDetail = z.infer<typeof referenceDetailSchema>
export type BoardSummary = z.infer<typeof boardSummarySchema>
export type ImageUpload = z.infer<typeof imageUploadSchema>
export type Placement = z.infer<typeof placementSchema>
export type CanvasItem = z.infer<typeof canvasItemSchema>
export type BoardGroup = z.infer<typeof groupSchema>
export type BoardNote = z.infer<typeof noteSchema>
export type CanvasOp = z.infer<typeof canvasOpSchema>
export type PaletteColor = z.infer<typeof paletteSchema>
export type NoteSize = z.infer<typeof noteSizeSchema>

/** Everything a canvas draws, in one round trip. */
const canvasViewSchema = z.strictObject({
  board: boardSummarySchema,
  items: z.array(canvasItemSchema),
  groups: z.array(groupSchema),
  notes: z.array(noteSchema),
})

/** Reference Board messages. Each one serves a single user action. */
export const referenceMessages = {
  /**
   * Everything the board screen shows: boards, counts, tag counts and the
   * filtered cards. inTrash lists the Trash instead of the Library.
   */
  'refs:listBoard': {
    request: z.strictObject({
      boardId: id.nullable(),
      inTrash: z.boolean(),
      tags: z.array(tagName).max(30),
      text: z.string().max(200),
    }),
    response: z.strictObject({
      boards: z.array(boardSummarySchema),
      totalCount: z.number().int().nonnegative(),
      trashCount: z.number().int().nonnegative(),
      tags: z.array(z.strictObject({ name: z.string(), count: z.number().int().positive() })),
      items: z.array(referenceCardSchema),
    }),
  },
  'refs:getDetail': {
    request: z.strictObject({ id }),
    response: z.strictObject({
      detail: referenceDetailSchema.nullable(),
      /** Tags a local model suggested, not yet accepted (never searched or filtered on). */
      suggestions: z.array(z.strictObject({ tag: z.string(), confidence: z.number() })),
    }),
  },
  /** One drop or paste: all images in a single round trip. */
  'refs:import': {
    request: z.strictObject({
      items: z.array(imageUploadSchema).min(1).max(200),
      boardId: id.nullable(),
      /** Canvas point to place the images around (drop or paste on a canvas). */
      at: point.nullable(),
    }),
    response: z.strictObject({
      results: z.array(
        z.discriminatedUnion('status', [
          z.strictObject({ fileName: z.string(), status: z.literal('created'), id }),
          z.strictObject({ fileName: z.string(), status: z.literal('duplicate'), id }),
          z.strictObject({ fileName: z.string(), status: z.literal('restored'), id }),
          z.strictObject({
            fileName: z.string(),
            status: z.literal('rejected'),
            reason: z.string(),
          }),
        ]),
      ),
    }),
  },
  /** Saves edited fields; omitted fields stay as they are. */
  'refs:update': {
    request: z.strictObject({
      id,
      title: z.string().max(200).optional(),
      note: z.string().max(20_000).optional(),
      source: z.string().max(2_000).optional(),
      tags: z.array(tagName).max(30).optional(),
      boardIds: z.array(id).max(500).optional(),
    }),
    response: z.strictObject({ detail: referenceDetailSchema.nullable() }),
  },
  'boards:create': {
    request: z.strictObject({ name: z.string().min(1).max(80) }),
    response: z.strictObject({ board: boardSummarySchema }),
  },
  /** Moves a selection to the Trash; returns the ids that moved. */
  'refs:delete': {
    request: z.strictObject({ ids: idList }),
    response: z.strictObject({ ids: z.array(id) }),
  },
  /** Brings a selection back from the Trash (Restore, or Undo of a delete). */
  'refs:restore': {
    request: z.strictObject({ ids: idList }),
    response: z.strictObject({ ids: z.array(id) }),
  },
  /** Permanently deletes the Trash; files are removed only when no other reference uses them. */
  'trash:empty': {
    request: z.strictObject({}),
    response: z.strictObject({
      deletedReferences: z.number().int().nonnegative(),
      deletedFiles: z.number().int().nonnegative(),
    }),
  },
  /**
   * Takes a selection off one board; the references stay in the Library.
   * Returns the removed placements, so an undo can put them back exactly.
   */
  'boards:removeRefs': {
    request: z.strictObject({ boardId: id, ids: idList }),
    response: z.strictObject({ ids: z.array(id), undo: z.array(canvasOpSchema) }),
  },
  /** Places Library references on a board, around `at` or below what is there. */
  'boards:addRefs': {
    request: z.strictObject({ boardId: id, ids: idList, at: point.nullable() }),
    response: z.strictObject({ ids: z.array(id) }),
  },
  'boards:setViewMode': {
    request: z.strictObject({ boardId: id, mode: viewMode }),
    response: z.strictObject({ mode: viewMode }),
  },
  /** Everything a board's canvas draws, bottom to top. */
  'canvas:get': {
    request: z.strictObject({ boardId: id }),
    response: canvasViewSchema,
  },
  /**
   * One canvas edit (move, group, note, attach, remove...), applied atomically.
   * Returns the new canvas, the steps that undo it, and ids of created groups and notes.
   */
  'canvas:apply': {
    request: z.strictObject({ boardId: id, ops: z.array(canvasOpSchema).min(1).max(100) }),
    response: z.strictObject({
      view: canvasViewSchema,
      undo: z.array(canvasOpSchema),
      created: z.strictObject({
        groups: z.record(clientKey, id),
        notes: z.record(clientKey, id),
      }),
    }),
  },
} as const
