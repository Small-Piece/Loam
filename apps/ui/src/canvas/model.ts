import type {
  BoardGroup,
  BoardNote,
  CanvasItem,
  CanvasOp,
  NoteSize,
  PaletteColor,
} from '@loam/protocol'
import { boundsOf, intersects, itemBox, type Box, type Point } from './geometry.ts'

/** Selection and DOM keys: i:<referenceId>, n:<noteId>, g:<groupId>. */
export type ObjectKey = `i:${number}` | `n:${number}` | `g:${number}`

export const itemKey = (id: number): ObjectKey => `i:${id}`
export const noteKey = (id: number): ObjectKey => `n:${id}`
export const groupKey = (id: number): ObjectKey => `g:${id}`

export function parseKey(key: string): { kind: 'i' | 'n' | 'g'; id: number } | null {
  const match = /^([ing]):(\d+)$/.exec(key)
  if (!match) return null
  return { kind: match[1] as 'i' | 'n' | 'g', id: Number(match[2]) }
}

/** Space around a group's children, and the band above them that holds the title (canvas units). */
export const GROUP_PADDING = 24
export const GROUP_HEADER = 44

/** Note font sizes in canvas units, and the inner padding of a note. */
export const NOTE_FONT: Record<NoteSize, number> = { S: 16, M: 24, L: 36, XL: 56 }
export const NOTE_PADDING = 10

/** Hex values for the palette. Groups use them translucent; notes use them for text. */
export const PALETTE_HEX: Record<PaletteColor, string> = {
  paper: '#e6e6e6',
  slate: '#8a94a6',
  blue: '#6aa6ff',
  teal: '#4fc3b8',
  green: '#7bcf7b',
  amber: '#f0b450',
  red: '#f07a6a',
  violet: '#b58cf0',
  pink: '#f08cc4',
}

export interface CanvasState {
  items: CanvasItem[]
  groups: BoardGroup[]
  notes: BoardNote[]
}

/** Measured note sizes in canvas units; a rough guess is used until a note is measured. */
export type NoteSizes = ReadonlyMap<number, { width: number; height: number }>

export function estimateNoteSize(note: BoardNote): { width: number; height: number } {
  const font = NOTE_FONT[note.fontSize]
  const lines = note.text.split('\n')
  const longest = Math.max(1, ...lines.map((line) => line.length))
  const width = note.width ?? longest * font * 0.55 + NOTE_PADDING * 2
  const wrapped = note.width
    ? lines.reduce(
        (sum, line) => sum + Math.max(1, Math.ceil((line.length * font * 0.55) / note.width!)),
        0,
      )
    : lines.length
  return { width, height: wrapped * font * 1.3 + NOTE_PADDING * 2 }
}

/** Where a note is on the canvas. An attached note sits at its offset from its image, scaled with it. */
export function notePosition(
  note: BoardNote,
  itemsById: ReadonlyMap<number, CanvasItem>,
): Point | null {
  if (note.attachedReferenceId === null) return { x: note.x, y: note.y }
  const image = itemsById.get(note.attachedReferenceId)
  if (!image) return null
  return { x: image.x + note.x * image.scale, y: image.y + note.y * image.scale }
}

export function noteBox(
  note: BoardNote,
  itemsById: ReadonlyMap<number, CanvasItem>,
  sizes: NoteSizes,
): Box | null {
  const at = notePosition(note, itemsById)
  if (!at) return null
  const size = sizes.get(note.id) ?? estimateNoteSize(note)
  return { x: at.x, y: at.y, width: note.width ?? size.width, height: size.height }
}

/** The offset to store when a note is attached to an image at its current canvas position. */
export function attachOffset(position: Point, image: CanvasItem): Point {
  return { x: (position.x - image.x) / image.scale, y: (position.y - image.y) / image.scale }
}

export function byId<T extends { id: number }>(list: readonly T[]): Map<number, T> {
  return new Map(list.map((entry) => [entry.id, entry]))
}

export function itemsByRef(items: readonly CanvasItem[]): Map<number, CanvasItem> {
  return new Map(items.map((item) => [item.referenceId, item]))
}

/**
 * A group's frame: its children (images, free notes, and notes attached to
 * its images) plus padding, with the title band on top. Null when no child
 * is visible.
 */
export function groupBounds(groupId: number, state: CanvasState, sizes: NoteSizes): Box | null {
  const refs = itemsByRef(state.items)
  const childItems = state.items.filter((item) => item.groupId === groupId)
  const childRefs = new Set(childItems.map((item) => item.referenceId))
  const boxes: Box[] = childItems.map(itemBox)
  for (const note of state.notes) {
    const belongs =
      note.groupId === groupId ||
      (note.attachedReferenceId !== null && childRefs.has(note.attachedReferenceId))
    if (!belongs) continue
    const box = noteBox(note, refs, sizes)
    if (box) boxes.push(box)
  }
  const inner = boundsOf(boxes)
  if (!inner) return null
  return {
    x: inner.x - GROUP_PADDING,
    y: inner.y - GROUP_PADDING - GROUP_HEADER,
    width: inner.width + GROUP_PADDING * 2,
    height: inner.height + GROUP_PADDING * 2 + GROUP_HEADER,
  }
}

/** Canvas box of any object. */
export function objectBox(key: ObjectKey, state: CanvasState, sizes: NoteSizes): Box | null {
  const parsed = parseKey(key)
  if (!parsed) return null
  if (parsed.kind === 'g') return groupBounds(parsed.id, state, sizes)
  if (parsed.kind === 'i') {
    const item = state.items.find((entry) => entry.referenceId === parsed.id)
    return item ? itemBox(item) : null
  }
  const note = state.notes.find((entry) => entry.id === parsed.id)
  return note ? noteBox(note, itemsByRef(state.items), sizes) : null
}

export interface DrawEntry {
  key: ObjectKey
  order: number[]
}

/**
 * Draw order across images, notes and groups: one z for everything at the
 * top level; a group's children draw right above its frame, in their own z;
 * a note attached to an image draws right above that image.
 */
export function drawOrder(state: CanvasState): ObjectKey[] {
  const groups = byId(state.groups)
  const entries: DrawEntry[] = []
  const itemOrder = new Map<number, number[]>()
  for (const group of state.groups)
    entries.push({ key: groupKey(group.id), order: [group.z, 0, 0, 0, group.id] })
  for (const item of state.items) {
    const group = item.groupId === null ? undefined : groups.get(item.groupId)
    const order = group
      ? [group.z, 1, item.z, 0, item.referenceId]
      : [item.z, 0, 0, 1, item.referenceId]
    itemOrder.set(item.referenceId, order)
    entries.push({ key: itemKey(item.referenceId), order })
  }
  for (const note of state.notes) {
    let order: number[]
    if (note.attachedReferenceId !== null) {
      const base = itemOrder.get(note.attachedReferenceId)
      if (!base) continue
      order = [...base, 1, note.z, note.id]
    } else {
      const group = note.groupId === null ? undefined : groups.get(note.groupId)
      order = group ? [group.z, 1, note.z, 2, note.id] : [note.z, 0, 0, 2, note.id]
    }
    entries.push({ key: noteKey(note.id), order })
  }
  const compare = (a: number[], b: number[]) => {
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      const difference = (a[index] ?? -Infinity) - (b[index] ?? -Infinity)
      if (difference !== 0) return difference
    }
    return 0
  }
  return entries.sort((a, b) => compare(a.order, b.order)).map((entry) => entry.key)
}

/** The group an object belongs to (attached notes follow their image's group). */
export function groupOf(key: ObjectKey, state: CanvasState): number | null {
  const parsed = parseKey(key)
  if (!parsed || parsed.kind === 'g') return null
  if (parsed.kind === 'i')
    return state.items.find((item) => item.referenceId === parsed.id)?.groupId ?? null
  const note = state.notes.find((entry) => entry.id === parsed.id)
  if (!note) return null
  if (note.attachedReferenceId !== null) {
    return (
      state.items.find((item) => item.referenceId === note.attachedReferenceId)?.groupId ?? null
    )
  }
  return note.groupId
}

/** Images and free notes directly in a group (attached notes come with their images). */
export function childrenOf(groupId: number, state: CanvasState): ObjectKey[] {
  return [
    ...state.items
      .filter((item) => item.groupId === groupId)
      .map((item) => itemKey(item.referenceId)),
    ...state.notes
      .filter((note) => note.groupId === groupId && note.attachedReferenceId === null)
      .map((note) => noteKey(note.id)),
  ]
}

/** Objects at the top level: groups, ungrouped images and ungrouped free notes. */
export function topLevel(state: CanvasState): ObjectKey[] {
  return [
    ...state.groups.map((group) => groupKey(group.id)),
    ...state.items.filter((item) => item.groupId === null).map((item) => itemKey(item.referenceId)),
    ...state.notes
      .filter((note) => note.groupId === null && note.attachedReferenceId === null)
      .map((note) => noteKey(note.id)),
  ]
}

function zOf(key: ObjectKey, state: CanvasState): number {
  const parsed = parseKey(key)
  if (!parsed) return 0
  if (parsed.kind === 'g') return state.groups.find((group) => group.id === parsed.id)?.z ?? 0
  if (parsed.kind === 'i') return state.items.find((item) => item.referenceId === parsed.id)?.z ?? 0
  return state.notes.find((note) => note.id === parsed.id)?.z ?? 0
}

/** Steps that set new z values for objects (items, notes or groups). */
export function zOps(changes: ReadonlyMap<ObjectKey, number>, state: CanvasState): CanvasOp[] {
  const items = state.items
    .filter((item) => changes.has(itemKey(item.referenceId)))
    .map((item) => ({
      referenceId: item.referenceId,
      x: item.x,
      y: item.y,
      scale: item.scale,
      groupId: item.groupId,
      z: changes.get(itemKey(item.referenceId))!,
    }))
  const notes = state.notes
    .filter((note) => changes.has(noteKey(note.id)))
    .map((note) => ({ ...note, z: changes.get(noteKey(note.id))! }))
  const groups = state.groups
    .filter((group) => changes.has(groupKey(group.id)))
    .map((group) => ({ ...group, z: changes.get(groupKey(group.id))! }))
  const ops: CanvasOp[] = []
  if (groups.length > 0) ops.push({ op: 'putGroups', groups })
  if (items.length > 0) ops.push({ op: 'putItems', items })
  if (notes.length > 0) ops.push({ op: 'putNotes', notes })
  return ops
}

/**
 * Brings objects to the front or sends them to the back among their peers:
 * the top level, or the children of the group they are in. Their own order
 * is kept.
 */
export function restackObjects(
  keys: readonly ObjectKey[],
  state: CanvasState,
  direction: 'front' | 'back',
): Map<ObjectKey, number> {
  const changes = new Map<ObjectKey, number>()
  const containers = new Map<string, ObjectKey[]>()
  for (const key of keys) {
    const parsed = parseKey(key)
    if (!parsed) continue
    // Attached notes always stay right above their image.
    if (
      parsed.kind === 'n' &&
      state.notes.find((note) => note.id === parsed.id)?.attachedReferenceId != null
    )
      continue
    const group = parsed.kind === 'g' ? null : groupOf(key, state)
    const container = group === null ? 'top' : `g${group}`
    containers.set(container, [...(containers.get(container) ?? []), key])
  }
  for (const [container, chosen] of containers) {
    const peers =
      container === 'top' ? topLevel(state) : childrenOf(Number(container.slice(1)), state)
    const others = peers.filter((key) => !chosen.includes(key))
    const ordered = [...chosen].sort((a, b) => zOf(a, state) - zOf(b, state))
    const peerZ = others.map((key) => zOf(key, state))
    if (direction === 'front') {
      const top = Math.max(0, ...peerZ, ...ordered.map((key) => zOf(key, state)))
      ordered.forEach((key, index) => changes.set(key, top + 1 + index))
    } else {
      const bottom = Math.min(0, ...peerZ, ...ordered.map((key) => zOf(key, state)))
      ordered.forEach((key, index) => changes.set(key, bottom - ordered.length + index))
    }
  }
  return changes
}

/**
 * z values that keep the picture the same after groups dissolve: the top
 * level is renumbered in draw order, with each dissolving group replaced by
 * its children.
 */
export function zAfterUngroup(
  groupIds: readonly number[],
  state: CanvasState,
): Map<ObjectKey, number> {
  const dissolving = new Set(groupIds)
  const ordered: ObjectKey[] = []
  const units = topLevel(state).sort((a, b) => zOf(a, state) - zOf(b, state))
  for (const key of units) {
    const parsed = parseKey(key)
    if (parsed?.kind === 'g' && dissolving.has(parsed.id)) {
      ordered.push(...childrenOf(parsed.id, state).sort((a, b) => zOf(a, state) - zOf(b, state)))
    } else {
      ordered.push(key)
    }
  }
  const changes = new Map<ObjectKey, number>()
  ordered.forEach((key, index) => {
    if (zOf(key, state) !== index + 1) changes.set(key, index + 1)
  })
  return changes
}

/** Topmost free group whose frame (without the moving objects) contains the point. */
export function groupAtPoint(
  point: Point,
  state: CanvasState,
  sizes: NoteSizes,
  exclude: ReadonlySet<ObjectKey>,
): number | null {
  const order = drawOrder(state)
  for (let index = order.length - 1; index >= 0; index--) {
    const parsed = parseKey(order[index]!)
    if (parsed?.kind !== 'g') continue
    const box = groupBounds(parsed.id, withoutObjects(state, exclude), sizes)
    if (box && contains(box, point)) return parsed.id
  }
  return null
}

/** The state with some images and notes taken out (to measure a group without what is being dragged). */
export function withoutObjects(state: CanvasState, keys: ReadonlySet<ObjectKey>): CanvasState {
  return {
    groups: state.groups,
    items: state.items.filter((item) => !keys.has(itemKey(item.referenceId))),
    notes: state.notes.filter((note) => !keys.has(noteKey(note.id))),
  }
}

export function contains(box: Box, point: Point): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  )
}

export function center(box: Box): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/**
 * Image to attach a note to: the topmost image under the note's center, or
 * else the one it overlaps most. Null when the note is over no image.
 */
export function attachTarget(noteArea: Box, state: CanvasState): CanvasItem | null {
  const order = drawOrder(state)
  const point = center(noteArea)
  const refs = itemsByRef(state.items)
  for (let index = order.length - 1; index >= 0; index--) {
    const parsed = parseKey(order[index]!)
    if (parsed?.kind !== 'i') continue
    const item = refs.get(parsed.id)
    if (item && contains(itemBox(item), point)) return item
  }
  let best: CanvasItem | null = null
  let bestArea = 0
  for (const item of state.items) {
    const box = itemBox(item)
    if (!intersects(box, noteArea)) continue
    const width =
      Math.min(box.x + box.width, noteArea.x + noteArea.width) - Math.max(box.x, noteArea.x)
    const height =
      Math.min(box.y + box.height, noteArea.y + noteArea.height) - Math.max(box.y, noteArea.y)
    if (width * height > bestArea) {
      bestArea = width * height
      best = item
    }
  }
  return best
}
