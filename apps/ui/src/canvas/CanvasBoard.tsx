import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type MutableRefObject,
  type PointerEvent,
} from 'react'
import {
  assetUrl,
  type BoardNote,
  type CanvasItem,
  type CanvasOp,
  type NoteSize,
  type PaletteColor,
  type ReferenceCard,
  type ResponseOf,
} from '@loam/protocol'
import { call } from '../api.ts'
import { ContextMenu, copyMenuItems } from '../board/ContextMenu.tsx'
import {
  fitView,
  intersects,
  itemBox,
  readingOrder,
  scaleFromCorner,
  toCanvas,
  zoomAround,
  type Box,
  type Corner,
  type Point,
  type View,
} from './geometry.ts'
import {
  attachOffset,
  attachTarget,
  byId,
  center,
  childrenOf,
  contains,
  copyItems,
  drawOrder,
  groupAtPoint,
  groupBounds,
  groupKey,
  groupOf,
  itemKey,
  itemsById,
  NOTE_FONT,
  noteBox,
  noteKey,
  notePosition,
  objectBox,
  PALETTE_HEX,
  parseKey,
  restackObjects,
  topLevel,
  withoutObjects,
  zAfterUngroup,
  zOps,
  type CanvasState,
  type NoteSizes,
  type ObjectKey,
} from './model.ts'
import { ObjectToolbar } from './ObjectToolbar.tsx'

/** Drag type for Library thumbnails dropped on a canvas. */
export const LIBRARY_DRAG_TYPE = 'application/x-loam-refs'

/** What the board page needs from the canvas to place dropped or pasted files. */
export interface CanvasApi {
  /** Canvas point under a window coordinate, or null when it is outside the canvas. */
  canvasPointAt(clientX: number, clientY: number): Point | null
  /** Canvas point at the middle of what is on screen. */
  viewCenter(): Point
}

interface Props {
  boardId: number
  /** Bump to reload (after an import, an undo, a Library drop). */
  version: number
  apiRef: MutableRefObject<CanvasApi | null>
  /** Keys are ignored while the viewer or a dialog is open. */
  keysEnabled: boolean
  onItemsLoaded: (ids: number[]) => void
  /** An edit Ctrl+Z can revert by applying these steps. */
  onUndoable: (undo: CanvasOp[], message: string) => void
  onOpenViewer: (cards: ReferenceCard[], index: number) => void
  /** Copies these references' images to the clipboard (Ctrl+C, right-click → Copy image). */
  onCopy: (referenceIds: number[]) => void
  onError: (message: string) => void
}

type Gesture =
  | { kind: 'pan'; x: number; y: number; view: View }
  | {
      kind: 'move'
      x: number
      y: number
      start: CanvasState
      /** Images and notes that move. */
      moving: ReadonlySet<ObjectKey>
      /** Objects moved on their own (not as part of a whole group): they can join or leave groups. */
      loose: ReadonlySet<ObjectKey>
      moved: boolean
      preview: CanvasState | null
      /** Alt+drag: these items stay, and copies of them are dragged instead. */
      copyOf: ReadonlySet<number> | null
    }
  | {
      kind: 'scale'
      item: CanvasItem
      corner: Corner
      start: CanvasState
      preview: CanvasState | null
    }
  | { kind: 'width'; note: BoardNote; start: CanvasState; preview: CanvasState | null }
  | {
      kind: 'box'
      x: number
      y: number
      additive: boolean
      base: ReadonlySet<ObjectKey>
      moved: boolean
    }

type Detail = 'thumb' | 'loading' | 'full'
type CanvasView = ResponseOf<'canvas:get'>

const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']
const WHEEL_SENSITIVITY = 0.0018
const LINE_HEIGHT_PX = 33
const DRAG_THRESHOLD = 3
const MIN_NOTE_WIDTH = 40
const DRAFT = -1
const EMPTY: CanvasState = { items: [], groups: [], notes: [] }
/** How far Ctrl+D moves a copy from its original, in screen pixels. */
const DUPLICATE_OFFSET_PX = 24

function viewStorageKey(boardId: number): string {
  return `loam.canvasView.${boardId}`
}

function loadSavedView(boardId: number): View | null {
  try {
    const raw = localStorage.getItem(viewStorageKey(boardId))
    if (!raw) return null
    const { x, y, scale } = JSON.parse(raw) as Partial<View>
    if ([x, y, scale].every((value) => typeof value === 'number' && Number.isFinite(value))) {
      return { x: x as number, y: y as number, scale: scale as number }
    }
  } catch {
    // Storage can be unavailable; the canvas then opens fitted.
  }
  return null
}

function saveView(boardId: number, view: View): void {
  try {
    localStorage.setItem(viewStorageKey(boardId), JSON.stringify(view))
  } catch {
    // Remembering the view is a convenience only.
  }
}

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.matches('input, textarea, select'))
  )
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function toState(view: CanvasView): CanvasState {
  return { items: view.items, groups: view.groups, notes: view.notes }
}

function itemInput(item: CanvasItem) {
  return {
    id: item.id,
    referenceId: item.referenceId,
    x: item.x,
    y: item.y,
    scale: item.scale,
    z: item.z,
    groupId: item.groupId,
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A new placement to save: what putItems takes for an item that has no id yet. */
function newItemInput(item: CanvasItem & { key: string }) {
  const { id: _unsaved, ...fields } = itemInput(item)
  return { ...fields, key: item.key }
}

/**
 * The references of these items, each once, in reading order (rows top to bottom,
 * then left to right), so "the first" is the one a person reads first.
 */
function referencesInReadingOrder(items: readonly CanvasItem[]): number[] {
  return [...new Set(readingOrder(items).map((item) => item.referenceId))]
}

/** Reference ids on the board, each once (an image can be placed several times). */
function referenceIdsOf(items: readonly CanvasItem[]): number[] {
  return [...new Set(items.map((item) => item.referenceId))]
}

/** Moves images and notes by (dx, dy) canvas units; attached notes moved alone shift their offset. */
function moveObjects(
  state: CanvasState,
  moving: ReadonlySet<ObjectKey>,
  dx: number,
  dy: number,
): CanvasState {
  const items = itemsById(state.items)
  return {
    groups: state.groups,
    items: state.items.map((item) =>
      moving.has(itemKey(item.id)) ? { ...item, x: item.x + dx, y: item.y + dy } : item,
    ),
    notes: state.notes.map((note) => {
      if (!moving.has(noteKey(note.id))) return note
      if (note.attachedItemId === null) return { ...note, x: note.x + dx, y: note.y + dy }
      if (moving.has(itemKey(note.attachedItemId))) return note
      const image = items.get(note.attachedItemId)
      return image ? { ...note, x: note.x + dx / image.scale, y: note.y + dy / image.scale } : note
    }),
  }
}

/**
 * Unsaved copies of items for an Alt+drag, with temporary negative ids so they can be
 * drawn and dragged before the edit gives them real ones.
 */
function withDragCopies(
  state: CanvasState,
  ids: ReadonlySet<number>,
): { state: CanvasState; copies: Array<CanvasItem & { key: string }> } {
  const copies = copyItems(ids, state, 0, 0).map((copy, index) => ({ ...copy, id: -2 - index }))
  return { state: { ...state, items: [...state.items, ...copies] }, copies }
}

/**
 * PureRef-style canvas for one board: images, text notes and labelled
 * groups. The camera and in-progress drags are written straight to the DOM;
 * every finished edit is one canvas:apply round trip, undoable in one step.
 */
export function CanvasBoard({
  boardId,
  version,
  apiRef,
  keysEnabled,
  onItemsLoaded,
  onUndoable,
  onOpenViewer,
  onCopy,
  onError,
}: Props) {
  const [state, setState] = useState<CanvasState>(EMPTY)
  const [selected, setSelected] = useState<ReadonlySet<ObjectKey>>(new Set())
  const [entered, setEntered] = useState<number | null>(null)
  const [editingNote, setEditingNote] = useState<number | null>(null)
  const [draft, setDraft] = useState<BoardNote | null>(null)
  const [editingTitle, setEditingTitle] = useState<number | null>(null)
  const [noteSizes, setNoteSizes] = useState<NoteSizes>(new Map())
  const [groupDialog, setGroupDialog] = useState<number[] | null>(null)
  const [zoomLabel, setZoomLabel] = useState('100%')
  const [box, setBox] = useState<Box | null>(null)
  const [panReady, setPanReady] = useState(false)
  const [loaded, setLoaded] = useState(false)
  /** The right-click menu on images: the references it copies, at the pointer. */
  const [menu, setMenu] = useState<{ ids: number[]; x: number; y: number } | null>(null)
  const stage = useRef<HTMLDivElement>(null)
  const world = useRef<HTMLDivElement>(null)
  const view = useRef<View>({ x: 0, y: 0, scale: 1 })
  const frame = useRef(0)
  const gesture = useRef<Gesture | null>(null)
  const spaceDown = useRef(false)
  const pointer = useRef<Point | null>(null)
  const stateRef = useRef<CanvasState>(EMPTY)
  const sizesRef = useRef<NoteSizes>(new Map())
  const elements = useRef(new Map<string, HTMLElement>())
  const images = useRef(new Map<number, HTMLImageElement>())
  const detail = useRef(new Map<number, Detail>())
  const viewReady = useRef(false)
  const callbacks = useRef({ onItemsLoaded, onUndoable, onOpenViewer, onCopy, onError })
  useEffect(() => {
    callbacks.current = { onItemsLoaded, onUndoable, onOpenViewer, onCopy, onError }
  })
  useEffect(() => {
    stateRef.current = state
    sizesRef.current = noteSizes
  }, [state, noteSizes])

  const order = useMemo(() => drawOrder(state), [state])
  const itemMap = useMemo(() => itemsById(state.items), [state.items])
  const groups = useMemo(() => byId(state.groups), [state.groups])

  const viewport = useCallback(() => {
    const el = stage.current
    return { width: el?.clientWidth ?? 0, height: el?.clientHeight ?? 0 }
  }, [])

  const reportError = useCallback(
    (error: unknown) => callbacks.current.onError(messageOf(error)),
    [],
  )

  /** Swaps originals in for images drawn larger than their thumbnail, and back out when not. */
  const updateDetail = useCallback(() => {
    const { width, height } = viewport()
    const screen: Box = { x: 0, y: 0, width, height }
    const { x, y, scale } = view.current
    const density = window.devicePixelRatio || 1
    for (const item of stateRef.current.items) {
      const img = images.current.get(item.id)
      if (!img) continue
      const drawn = itemBox(item)
      const onScreen: Box = {
        x: drawn.x * scale + x,
        y: drawn.y * scale + y,
        width: drawn.width * scale,
        height: drawn.height * scale,
      }
      const want =
        item.imageWidth > item.thumbWidth &&
        onScreen.width * density > item.thumbWidth * 1.1 &&
        intersects(onScreen, screen)
      const current = detail.current.get(item.id) ?? 'thumb'
      if (want && current === 'thumb') {
        detail.current.set(item.id, 'loading')
        const original = new Image()
        original.src = assetUrl(item.imageHash)
        original
          .decode()
          .then(() => {
            if (detail.current.get(item.id) !== 'loading') return
            img.src = original.src
            detail.current.set(item.id, 'full')
          })
          .catch(() => detail.current.set(item.id, 'thumb'))
      } else if (!want && current !== 'thumb') {
        // Drop the original as soon as it is small or off screen, so memory stays bounded.
        detail.current.set(item.id, 'thumb')
        img.src = assetUrl(item.thumbHash)
      }
    }
  }, [viewport])

  const applyNow = useCallback(() => {
    const el = world.current
    const { x, y, scale } = view.current
    if (el) {
      el.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
      // Handles, outlines and labels stay readable at any zoom.
      el.style.setProperty('--inverse-zoom', String(1 / scale))
    }
    setZoomLabel(`${Math.round(scale * 100)}%`)
    updateDetail()
  }, [updateDetail])

  const apply = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(applyNow)
  }, [applyNow])

  const allBoxes = useCallback((): Box[] => {
    const current = stateRef.current
    return topLevel(current)
      .map((key) => objectBox(key, current, sizesRef.current))
      .filter((entry): entry is Box => entry !== null)
  }, [])

  const fitAll = useCallback(() => {
    view.current = fitView(allBoxes(), viewport())
    applyNow()
    saveView(boardId, view.current)
  }, [allBoxes, applyNow, boardId, viewport])

  /** Loads the board; a newer request always wins over an older one. */
  const latestLoad = useRef(0)
  const load = useCallback(
    (loadNumber: number) => {
      call('canvas:get', { boardId })
        .then((response) => {
          if (loadNumber !== latestLoad.current) return
          detail.current.clear()
          setState(toState(response))
          setLoaded(true)
          callbacks.current.onItemsLoaded(referenceIdsOf(response.items))
        })
        .catch(reportError)
    },
    [boardId, reportError],
  )
  const reload = useCallback(() => load(++latestLoad.current), [load])

  // The parent bumps version after imports, undos and Library drops.
  useEffect(() => {
    latestLoad.current = Math.max(latestLoad.current + 1, version)
    load(latestLoad.current)
  }, [load, version])

  // On first load the board opens where it was last left, or fitted to its content.
  // The parent remounts this component per board, so this runs once per board.
  useLayoutEffect(() => {
    stateRef.current = state
    if (!loaded) return
    if (viewReady.current) {
      updateDetail()
      return
    }
    viewReady.current = true
    const saved = loadSavedView(boardId)
    if (saved) {
      view.current = saved
      applyNow()
    } else if (state.items.length + state.notes.length > 0) {
      fitAll()
    } else {
      view.current = { x: viewport().width / 2, y: viewport().height / 2, scale: 1 }
      applyNow()
    }
  }, [applyNow, boardId, fitAll, loaded, state, updateDetail, viewport])

  // Notes size themselves to their text: measure them so group frames fit.
  useLayoutEffect(() => {
    let changed = false
    const next = new Map(sizesRef.current)
    for (const note of state.notes) {
      const el = elements.current.get(noteKey(note.id))
      if (!el) continue
      const size = { width: el.offsetWidth, height: el.offsetHeight }
      const known = next.get(note.id)
      if (!known || known.width !== size.width || known.height !== size.height) {
        next.set(note.id, size)
        changed = true
      }
    }
    if (changed) {
      sizesRef.current = next
      setNoteSizes(next)
    }
  }, [state.notes])

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  useEffect(() => {
    apiRef.current = {
      canvasPointAt(clientX, clientY) {
        const el = stage.current
        if (!el) return null
        const rect = el.getBoundingClientRect()
        if (
          clientX < rect.left ||
          clientX > rect.right ||
          clientY < rect.top ||
          clientY > rect.bottom
        ) {
          return null
        }
        return toCanvas(view.current, { x: clientX - rect.left, y: clientY - rect.top })
      },
      viewCenter() {
        const { width, height } = viewport()
        return toCanvas(view.current, { x: width / 2, y: height / 2 })
      },
    }
    return () => {
      apiRef.current = null
    }
  }, [apiRef, viewport])

  /**
   * Sends one edit. The optimistic state is shown at once (so a drag does not
   * snap back); the server's answer then replaces it.
   */
  const edit = useCallback(
    async (ops: CanvasOp[], message: string, optimistic?: CanvasState) => {
      if (ops.length === 0) return null
      if (optimistic) setState(optimistic)
      try {
        const result = await call('canvas:apply', { boardId, ops })
        setState(toState(result.view))
        if (result.undo.length > 0) callbacks.current.onUndoable(result.undo, message)
        callbacks.current.onItemsLoaded(referenceIdsOf(result.view.items))
        return result
      } catch (error) {
        reportError(error)
        reload()
        return null
      }
    },
    [boardId, reload, reportError],
  )

  /** The object a click on `key` selects: a locked group selects as a whole unless entered or Alt is held. */
  const clickTarget = useCallback(
    (key: ObjectKey, alt: boolean): ObjectKey => {
      const group = groupOf(key, stateRef.current)
      if (group === null) return key
      if (groups.get(group)?.locked && !alt && entered !== group) return groupKey(group)
      return key
    },
    [entered, groups],
  )

  /** Images and notes a selection moves: groups expand to their children. */
  const movingSet = useCallback(
    (keys: Iterable<ObjectKey>): { moving: Set<ObjectKey>; loose: Set<ObjectKey> } => {
      const current = stateRef.current
      const moving = new Set<ObjectKey>()
      const loose = new Set<ObjectKey>()
      for (const key of keys) {
        const parsed = parseKey(key)
        if (parsed?.kind === 'g') {
          // A whole group moves together and keeps its children.
          for (const child of childrenOf(parsed.id, current)) moving.add(child)
        } else {
          moving.add(key)
          loose.add(key)
        }
      }
      // Notes attached to moving images follow them through their offset.
      for (const note of current.notes) {
        if (note.attachedItemId !== null && moving.has(itemKey(note.attachedItemId))) {
          moving.delete(noteKey(note.id))
          loose.delete(noteKey(note.id))
        }
      }
      return { moving, loose }
    },
    [],
  )

  /** Writes positions for a preview state straight to the DOM (images, notes, group frames). */
  const paintPreview = useCallback((preview: CanvasState) => {
    const previewItems = itemsById(preview.items)
    for (const item of preview.items) {
      const el = elements.current.get(itemKey(item.id))
      if (!el) continue
      el.style.left = `${item.x}px`
      el.style.top = `${item.y}px`
      el.style.width = `${item.imageWidth * item.scale}px`
      el.style.height = `${item.imageHeight * item.scale}px`
    }
    for (const note of preview.notes) {
      const el = elements.current.get(noteKey(note.id))
      const at = notePosition(note, previewItems)
      if (!el || !at) continue
      el.style.left = `${at.x}px`
      el.style.top = `${at.y}px`
      if (note.width !== null) el.style.width = `${note.width}px`
    }
    for (const group of preview.groups) {
      const el = elements.current.get(groupKey(group.id))
      const frameBox = groupBounds(group.id, preview, sizesRef.current)
      if (!el || !frameBox) continue
      el.style.left = `${frameBox.x}px`
      el.style.top = `${frameBox.y}px`
      el.style.width = `${frameBox.width}px`
      el.style.height = `${frameBox.height}px`
    }
  }, [])

  // ---- Edits -------------------------------------------------------------

  const groupSelection = useCallback(async () => {
    const current = stateRef.current
    const members = new Set<ObjectKey>()
    let z = -Infinity
    for (const key of selected) {
      const parsed = parseKey(key)
      if (!parsed) continue
      if (parsed.kind === 'g') {
        childrenOf(parsed.id, current).forEach((child) => members.add(child))
        z = Math.max(z, groups.get(parsed.id)?.z ?? 0)
      } else if (
        parsed.kind === 'n' &&
        current.notes.find((n) => n.id === parsed.id)?.attachedItemId != null
      ) {
        continue // an attached note follows its image
      } else {
        members.add(key)
        const group = groupOf(key, current)
        const own =
          parsed.kind === 'i'
            ? current.items.find((item) => item.id === parsed.id)?.z
            : current.notes.find((note) => note.id === parsed.id)?.z
        z = Math.max(z, group === null ? (own ?? 0) : (groups.get(group)?.z ?? 0))
      }
    }
    if (members.size === 0) return
    const ops: CanvasOp[] = [
      {
        op: 'putGroups',
        groups: [{ key: 'new', title: 'Group', color: 'slate', locked: true, z }],
      },
    ]
    const items = current.items
      .filter((item) => members.has(itemKey(item.id)))
      .map((item) => ({ ...itemInput(item), groupId: null, groupKey: 'new' }))
    const notes = current.notes
      .filter((note) => members.has(noteKey(note.id)))
      .map((note) => ({ ...note, groupId: null, groupKey: 'new' }))
    if (items.length > 0) ops.push({ op: 'putItems', items })
    if (notes.length > 0) ops.push({ op: 'putNotes', notes })
    const result = await edit(ops, `Grouped ${plural(members.size, 'object')}`)
    const id = result?.created.groups['new']
    if (id !== undefined) {
      setSelected(new Set([groupKey(id)]))
      setEntered(null)
    }
  }, [edit, groups, selected])

  const ungroupSelection = useCallback(async () => {
    const current = stateRef.current
    const ids = new Set<number>()
    for (const key of selected) {
      const parsed = parseKey(key)
      if (parsed?.kind === 'g') ids.add(parsed.id)
      else {
        const group = groupOf(key, current)
        if (group !== null) ids.add(group)
      }
    }
    if (ids.size === 0) return
    const children = [...ids].flatMap((id) => childrenOf(id, current))
    const ops = [
      ...zOps(zAfterUngroup([...ids], current), current),
      { op: 'deleteGroups' as const, ids: [...ids] },
    ]
    await edit(ops, ids.size === 1 ? 'Ungrouped' : `Ungrouped ${ids.size} groups`)
    setSelected(new Set(children))
    setEntered(null)
  }, [edit, selected])

  /** Deletes what is selected; groups first ask whether to keep their children. */
  const deleteSelection = useCallback(
    async (groupChoice?: 'keep' | 'remove') => {
      const current = stateRef.current
      const groupIds = [...selected]
        .map(parseKey)
        .filter((p) => p?.kind === 'g')
        .map((p) => p!.id)
      if (groupIds.length > 0 && groupChoice === undefined) {
        setGroupDialog(groupIds)
        return
      }
      setGroupDialog(null)
      const itemIds = new Set<number>()
      const noteIds = new Set<number>()
      for (const key of selected) {
        const parsed = parseKey(key)
        if (parsed?.kind === 'i') itemIds.add(parsed.id)
        if (parsed?.kind === 'n') noteIds.add(parsed.id)
      }
      const ops: CanvasOp[] = []
      if (groupIds.length > 0 && groupChoice === 'keep') {
        ops.push(...zOps(zAfterUngroup(groupIds, current), current))
      }
      if (groupChoice === 'remove') {
        for (const id of groupIds) {
          for (const child of childrenOf(id, current)) {
            const parsed = parseKey(child)
            if (parsed?.kind === 'i') itemIds.add(parsed.id)
            if (parsed?.kind === 'n') noteIds.add(parsed.id)
          }
        }
      }
      if (noteIds.size > 0) ops.push({ op: 'deleteNotes', ids: [...noteIds] })
      if (itemIds.size > 0) ops.push({ op: 'removeItems', itemIds: [...itemIds] })
      if (groupIds.length > 0) ops.push({ op: 'deleteGroups', ids: groupIds })
      const parts: string[] = []
      if (itemIds.size > 0)
        parts.push(`${plural(itemIds.size, 'image')} from the board (still in the Library)`)
      if (noteIds.size > 0) parts.push(plural(noteIds.size, 'note'))
      if (groupIds.length > 0) parts.push(plural(groupIds.length, 'group'))
      await edit(ops, `Removed ${parts.join(', ')}`)
      setSelected(new Set())
      setEntered(null)
    },
    [edit, selected],
  )

  /** Saves copies of items as new placements and selects the copies. */
  const saveCopies = useCallback(
    async (copies: Array<CanvasItem & { key: string }>, optimistic?: CanvasState) => {
      if (copies.length === 0) return
      const result = await edit(
        [{ op: 'putItems', items: copies.map(newItemInput) }],
        `Copied ${plural(copies.length, 'image')}`,
        optimistic,
      )
      if (result) setSelected(new Set(Object.values(result.created.items).map(itemKey)))
    },
    [edit],
  )

  /** Ctrl+D: copies the selected images, slightly offset; the copies join the same groups. */
  const duplicateSelection = useCallback(() => {
    const ids = new Set<number>()
    for (const key of selected) {
      const parsed = parseKey(key)
      if (parsed?.kind === 'i') ids.add(parsed.id)
    }
    const offset = DUPLICATE_OFFSET_PX / view.current.scale
    void saveCopies(copyItems(ids, stateRef.current, offset, offset))
  }, [saveCopies, selected])

  /** Ctrl+C: copies the images of the selected items (groups and notes are not copied). */
  const copySelection = useCallback(() => {
    const items = stateRef.current.items.filter((item) => selected.has(itemKey(item.id)))
    const ids = referencesInReadingOrder(items)
    if (ids.length > 0) callbacks.current.onCopy(ids)
    return ids.length > 0
  }, [selected])

  const restackSelected = useCallback(
    (direction: 'front' | 'back') => {
      const current = stateRef.current
      const ops = zOps(restackObjects([...selected], current, direction), current)
      void edit(ops, direction === 'front' ? 'Brought to front' : 'Sent to back')
    },
    [edit, selected],
  )

  /** Starts a new note at a canvas point; it is saved once it has text. */
  const startNote = useCallback((at: Point) => {
    const current = stateRef.current
    const top = Math.max(
      0,
      ...current.items.map((i) => i.z),
      ...current.groups.map((g) => g.z),
      ...current.notes.map((n) => n.z),
    )
    setDraft({
      id: DRAFT,
      text: '',
      x: at.x,
      y: at.y,
      width: null,
      fontSize: 'M',
      color: 'paper',
      background: true,
      z: top + 1,
      attachedItemId: null,
      groupId: null,
    })
    setEditingNote(DRAFT)
    setSelected(new Set())
  }, [])

  const finishNote = useCallback(
    async (text: string) => {
      const id = editingNote
      setEditingNote(null)
      if (id === DRAFT) {
        const note = draft
        setDraft(null)
        if (!note || text.trim() === '') return
        const { id: _drop, ...fields } = note
        const result = await edit(
          [{ op: 'putNotes', notes: [{ ...fields, text, key: 'new' }] }],
          'Added a note',
        )
        const created = result?.created.notes['new']
        if (created !== undefined) setSelected(new Set([noteKey(created)]))
        return
      }
      const note = stateRef.current.notes.find((entry) => entry.id === id)
      if (!note || note.text === text) return
      if (text.trim() === '') {
        await edit([{ op: 'deleteNotes', ids: [note.id] }], 'Removed an empty note')
      } else {
        await edit([{ op: 'putNotes', notes: [{ ...note, text }] }], 'Edited a note')
      }
    },
    [draft, edit, editingNote],
  )

  const styleNotes = useCallback(
    (patch: { fontSize?: NoteSize; color?: PaletteColor; background?: boolean }) => {
      const notes = stateRef.current.notes
        .filter((note) => selected.has(noteKey(note.id)))
        .map((note) => ({ ...note, ...patch }))
      void edit(notes.length > 0 ? [{ op: 'putNotes', notes }] : [], 'Changed note style')
    },
    [edit, selected],
  )

  const styleGroups = useCallback(
    (patch: { color?: PaletteColor; locked?: boolean; title?: string }) => {
      const list = stateRef.current.groups
        .filter((group) => selected.has(groupKey(group.id)))
        .map((group) => ({ ...group, ...patch }))
      const message =
        patch.locked !== undefined
          ? patch.locked
            ? 'Locked group'
            : 'Unlocked group'
          : 'Changed group'
      void edit(list.length > 0 ? [{ op: 'putGroups', groups: list }] : [], message)
    },
    [edit, selected],
  )

  const renameGroup = useCallback(
    (id: number, title: string) => {
      setEditingTitle(null)
      const group = stateRef.current.groups.find((entry) => entry.id === id)
      if (!group || group.title === title.trim()) return
      void edit([{ op: 'putGroups', groups: [{ ...group, title }] }], 'Renamed group')
    },
    [edit],
  )

  /** Attaches the selected note to the image under it, or detaches it where it is. */
  const toggleAttach = useCallback(() => {
    const current = stateRef.current
    const id = [...selected].map(parseKey).find((p) => p?.kind === 'n')?.id
    const note = current.notes.find((entry) => entry.id === id)
    if (!note) return
    const area = noteBox(note, itemsById(current.items), sizesRef.current)
    if (!area) return
    if (note.attachedItemId !== null) {
      void edit(
        [
          {
            op: 'putNotes',
            notes: [{ ...note, x: area.x, y: area.y, attachedItemId: null, groupId: null }],
          },
        ],
        'Detached note',
      )
      return
    }
    const target = attachTarget(area, current)
    if (!target) {
      callbacks.current.onError('Move the note over an image to attach it.')
      return
    }
    const offset = attachOffset(area, target)
    void edit(
      [
        {
          op: 'putNotes',
          notes: [{ ...note, ...offset, attachedItemId: target.id, groupId: null }],
        },
      ],
      'Attached note to image',
    )
  }, [edit, selected])

  // ---- Keys --------------------------------------------------------------

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!keysEnabled || groupDialog || isEditable(event.target)) return
      const ctrl = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if (event.key === ' ') {
        // Space is the pan modifier here; it never opens the viewer on a canvas.
        event.preventDefault()
        if (!spaceDown.current) {
          spaceDown.current = true
          setPanReady(true)
        }
      } else if (ctrl && key === 'g') {
        event.preventDefault()
        void (event.shiftKey ? ungroupSelection() : groupSelection())
      } else if (ctrl && key === 'n') {
        event.preventDefault()
        const { width, height } = viewport()
        startNote(pointer.current ?? toCanvas(view.current, { x: width / 2, y: height / 2 }))
      } else if (event.key === 'Delete' && selected.size > 0) {
        event.preventDefault()
        void deleteSelection()
      } else if (ctrl && key === 'd') {
        event.preventDefault()
        duplicateSelection()
      } else if (ctrl && key === 'c') {
        if (copySelection()) event.preventDefault()
      } else if (ctrl && key === 'a') {
        event.preventDefault()
        setSelected(new Set(topLevel(stateRef.current)))
        setEntered(null)
      } else if (event.key === 'Escape') {
        setSelected(new Set())
        setEntered(null)
      } else if (!ctrl && key === 'f') {
        event.preventDefault()
        fitAll()
      } else if (!ctrl && event.key === ']' && selected.size > 0) {
        restackSelected('front')
      } else if (!ctrl && event.key === '[' && selected.size > 0) {
        restackSelected('back')
      }
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.key === ' ') {
        spaceDown.current = false
        setPanReady(false)
      }
    }
    function onBlur() {
      spaceDown.current = false
      setPanReady(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [
    copySelection,
    deleteSelection,
    duplicateSelection,
    fitAll,
    groupDialog,
    groupSelection,
    keysEnabled,
    restackSelected,
    selected,
    startNote,
    ungroupSelection,
    viewport,
  ])

  useEffect(() => {
    const el = stage.current
    if (!el) return
    function onWheel(event: WheelEvent) {
      event.preventDefault()
      if (!el) return
      const delta = event.deltaMode === 1 ? event.deltaY * LINE_HEIGHT_PX : event.deltaY
      const rect = el.getBoundingClientRect()
      view.current = zoomAround(
        view.current,
        view.current.scale * Math.exp(-delta * WHEEL_SENSITIVITY),
        {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        },
      )
      apply()
      saveView(boardId, view.current)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [apply, boardId])

  // ---- Pointer -----------------------------------------------------------

  function localPoint(event: { clientX: number; clientY: number }): Point {
    const rect = stage.current?.getBoundingClientRect()
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  }

  function keyAt(target: Element | null): ObjectKey | null {
    const el = target?.closest<HTMLElement>('[data-key]')
    const key = el?.dataset['key']
    return key && parseKey(key) ? (key as ObjectKey) : null
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    const target = event.target as Element
    if (
      target.closest('.canvas-note.editing, .group-title-input, .canvas-toolbar, .object-toolbar')
    )
      return
    const panning = event.button === 1 || (event.button === 0 && spaceDown.current)
    if (!panning && event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    stage.current?.focus({ preventScroll: true })
    const current = stateRef.current

    if (panning) {
      gesture.current = {
        kind: 'pan',
        x: event.clientX,
        y: event.clientY,
        view: { ...view.current },
      }
      return
    }
    const handle = target.closest<HTMLElement>('[data-handle]')
    const ownerKey = keyAt(handle)
    if (handle && ownerKey) {
      const owner = parseKey(ownerKey)
      if (owner?.kind === 'i') {
        const item = current.items.find((entry) => entry.id === owner.id)
        if (item) {
          gesture.current = {
            kind: 'scale',
            item,
            corner: handle.dataset['handle'] as Corner,
            start: current,
            preview: null,
          }
          return
        }
      }
      if (owner?.kind === 'n') {
        const note = current.notes.find((entry) => entry.id === owner.id)
        if (note) {
          gesture.current = { kind: 'width', note, start: current, preview: null }
          return
        }
      }
    }

    const hit = keyAt(target)
    if (hit) {
      const chosen = clickTarget(hit, event.altKey)
      const chosenGroup = parseKey(chosen)?.kind === 'g' ? null : groupOf(chosen, current)
      if (event.altKey && chosenGroup !== null) setEntered(chosenGroup)
      else if (entered !== null && chosenGroup !== entered) setEntered(null)
      const toggle = event.ctrlKey || event.metaKey || event.shiftKey
      let next: Set<ObjectKey>
      if (toggle) {
        next = new Set(selected)
        if (next.has(chosen)) next.delete(chosen)
        else next.add(chosen)
      } else {
        next = selected.has(chosen) ? new Set(selected) : new Set([chosen])
      }
      setSelected(next)
      const { moving, loose } = movingSet(next)
      // Alt+drag on an image drags copies of the selected images and leaves them in place.
      let copyOf: Set<number> | null = null
      if (event.altKey && !toggle && parseKey(chosen)?.kind === 'i') {
        copyOf = new Set()
        for (const key of next) {
          const parsed = parseKey(key)
          if (parsed?.kind === 'i') copyOf.add(parsed.id)
        }
      }
      gesture.current = {
        kind: 'move',
        x: event.clientX,
        y: event.clientY,
        start: current,
        moving,
        loose,
        moved: false,
        preview: null,
        copyOf,
      }
      return
    }
    setEntered(null)
    const additive = event.ctrlKey || event.metaKey || event.shiftKey
    gesture.current = {
      kind: 'box',
      x: event.clientX,
      y: event.clientY,
      additive,
      base: selected,
      moved: false,
    }
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    pointer.current = toCanvas(view.current, localPoint(event))
    const current = gesture.current
    if (!current) return
    const { scale } = view.current
    if (current.kind === 'pan') {
      view.current = {
        ...current.view,
        x: current.view.x + event.clientX - current.x,
        y: current.view.y + event.clientY - current.y,
      }
      apply()
    } else if (current.kind === 'move') {
      const dx = event.clientX - current.x
      const dy = event.clientY - current.y
      if (!current.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      if (!current.moved && current.copyOf) {
        // The drag becomes a copy: draw the copies over the originals and move those.
        const { state: withCopies, copies } = withDragCopies(current.start, current.copyOf)
        const keys = new Set(copies.map((copy) => itemKey(copy.id)))
        current.start = withCopies
        current.moving = keys
        current.loose = keys
        setState(withCopies)
        setSelected(keys)
      }
      current.moved = true
      current.preview = moveObjects(current.start, current.moving, dx / scale, dy / scale)
      paintPreview(current.preview)
    } else if (current.kind === 'scale') {
      const next = scaleFromCorner(
        current.item,
        current.corner,
        toCanvas(view.current, localPoint(event)),
      )
      current.preview = {
        ...current.start,
        items: current.start.items.map((item) =>
          item.id === current.item.id ? { ...item, ...next } : item,
        ),
      }
      paintPreview(current.preview)
    } else if (current.kind === 'width') {
      const at = notePosition(current.note, itemsById(current.start.items))
      if (!at) return
      const width = Math.max(MIN_NOTE_WIDTH, toCanvas(view.current, localPoint(event)).x - at.x)
      current.preview = {
        ...current.start,
        notes: current.start.notes.map((note) =>
          note.id === current.note.id ? { ...note, width } : note,
        ),
      }
      paintPreview(current.preview)
    } else {
      const dx = event.clientX - current.x
      const dy = event.clientY - current.y
      if (!current.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      current.moved = true
      const rect = stage.current?.getBoundingClientRect()
      const screenBox = {
        x: Math.min(current.x, event.clientX) - (rect?.left ?? 0),
        y: Math.min(current.y, event.clientY) - (rect?.top ?? 0),
        width: Math.abs(dx),
        height: Math.abs(dy),
      }
      setBox(screenBox)
      const corner = toCanvas(view.current, { x: screenBox.x, y: screenBox.y })
      const area = {
        x: corner.x,
        y: corner.y,
        width: screenBox.width / scale,
        height: screenBox.height / scale,
      }
      const snapshot = stateRef.current
      const hits = new Set<ObjectKey>()
      for (const item of snapshot.items) {
        if (intersects(itemBox(item), area)) hits.add(clickTarget(itemKey(item.id), false))
      }
      for (const note of snapshot.notes) {
        const noteArea = noteBox(note, itemsById(snapshot.items), sizesRef.current)
        if (noteArea && intersects(noteArea, area)) hits.add(clickTarget(noteKey(note.id), false))
      }
      setSelected(new Set(current.additive ? [...current.base, ...hits] : hits))
    }
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const current = gesture.current
    gesture.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!current) return
    if (current.kind === 'pan') {
      saveView(boardId, view.current)
    } else if (current.kind === 'move' && current.moved && current.preview && current.copyOf) {
      const preview = current.preview
      const copies = preview.items.flatMap((item) =>
        item.id < 0 ? [{ ...item, key: `copy${-2 - item.id}` }] : [],
      )
      void saveCopies(copies, preview)
    } else if (current.kind === 'move' && current.moved && current.preview) {
      void finishMove(current.start, current.preview, current.moving, current.loose, event.shiftKey)
    } else if (current.kind === 'scale' && current.preview) {
      const item = current.preview.items.find((entry) => entry.id === current.item.id)
      if (item)
        void edit(
          [{ op: 'putItems', items: [itemInput(item)] }],
          'Resized an image',
          current.preview,
        )
    } else if (current.kind === 'width' && current.preview) {
      const note = current.preview.notes.find((entry) => entry.id === current.note.id)
      if (note) void edit([{ op: 'putNotes', notes: [note] }], 'Resized a note', current.preview)
    } else if (current.kind === 'box') {
      setBox(null)
      if (!current.moved && !current.additive) setSelected(new Set())
    }
  }

  /** Saves a drag: positions, plus joining or leaving groups and Shift-attaching notes. */
  async function finishMove(
    start: CanvasState,
    preview: CanvasState,
    moving: ReadonlySet<ObjectKey>,
    loose: ReadonlySet<ObjectKey>,
    shift: boolean,
  ) {
    let next = preview
    const sizes = sizesRef.current
    const others = withoutObjects(next, loose)
    let message = `Moved ${plural(moving.size, 'object')}`
    for (const key of loose) {
      const parsed = parseKey(key)
      if (!parsed) continue
      const area = objectBox(key, next, sizes)
      if (!area) continue
      if (parsed.kind === 'n') {
        const note = next.notes.find((entry) => entry.id === parsed.id)
        if (!note) continue
        if (shift) {
          // Shift-drop on an image attaches the note to it.
          const target = attachTarget(area, next)
          if (target && target.id !== note.attachedItemId) {
            const offset = attachOffset(area, target)
            next = {
              ...next,
              notes: next.notes.map((entry) =>
                entry.id === note.id
                  ? { ...entry, ...offset, attachedItemId: target.id, groupId: null }
                  : entry,
              ),
            }
            message = 'Attached note to image'
            continue
          }
        }
        if (note.attachedItemId !== null) continue
      }
      const currentGroup = groupOf(key, next)
      let groupId = currentGroup
      if (currentGroup !== null) {
        // Dragged clear of the rest of its group: it leaves.
        const rest = groupBounds(currentGroup, others, sizes)
        if (rest && !contains(rest, center(area))) groupId = null
      }
      if (groupId === null) groupId = groupAtPoint(center(area), others, sizes, loose)
      if (groupId !== currentGroup) {
        message = groupId === null ? 'Took out of group' : 'Added to group'
        next =
          parsed.kind === 'i'
            ? {
                ...next,
                items: next.items.map((item) =>
                  item.id === parsed.id ? { ...item, groupId } : item,
                ),
              }
            : {
                ...next,
                notes: next.notes.map((note) =>
                  note.id === parsed.id ? { ...note, groupId } : note,
                ),
              }
      }
    }
    const changedItems = next.items.filter((item) => {
      const before = start.items.find((entry) => entry.id === item.id)
      return (
        !before || before.x !== item.x || before.y !== item.y || before.groupId !== item.groupId
      )
    })
    const changedNotes = next.notes.filter((note) => {
      const before = start.notes.find((entry) => entry.id === note.id)
      return JSON.stringify(before) !== JSON.stringify(note)
    })
    const ops: CanvasOp[] = []
    if (changedItems.length > 0) ops.push({ op: 'putItems', items: changedItems.map(itemInput) })
    if (changedNotes.length > 0) ops.push({ op: 'putNotes', notes: changedNotes })
    await edit(ops, message, next)
  }

  function onDoubleClick(event: MouseEvent<HTMLDivElement>) {
    // The stage captures the pointer on press, so look up what is under the cursor.
    const hitEl = document.elementFromPoint(event.clientX, event.clientY)
    if (
      hitEl?.closest('.canvas-note.editing, .group-title-input, .canvas-toolbar, .object-toolbar')
    )
      return
    const titleEl = hitEl?.closest<HTMLElement>('[data-role="group-title"]')
    const hit = keyAt(hitEl)
    const parsed = hit ? parseKey(hit) : null
    if (titleEl && parsed?.kind === 'g') {
      setEditingTitle(parsed.id)
      return
    }
    if (!hit || !parsed) {
      startNote(toCanvas(view.current, localPoint(event)))
      return
    }
    if (parsed.kind === 'g') {
      setEntered(parsed.id) // the next click picks a single child
      return
    }
    if (parsed.kind === 'n') {
      setSelected(new Set([hit]))
      setEditingNote(parsed.id)
      return
    }
    const group = groupOf(hit, stateRef.current)
    const lockedOutside =
      group !== null && groups.get(group)?.locked && !(selected.size === 1 && selected.has(hit))
    if (lockedOutside) {
      // First double-click on a locked group's image picks that image; the next one views it.
      setEntered(group)
      setSelected(new Set([hit]))
      return
    }
    // The viewer steps through each image once, even when it is placed several times.
    const seen = new Set<number>()
    const orderForViewer = readingOrder(stateRef.current.items).filter((item) => {
      if (seen.has(item.referenceId)) return false
      seen.add(item.referenceId)
      return true
    })
    const clicked = itemMap.get(parsed.id)
    const index = orderForViewer.findIndex((item) => item.referenceId === clicked?.referenceId)
    if (index < 0) return
    callbacks.current.onOpenViewer(
      orderForViewer.map((item) => ({
        id: item.referenceId,
        title: item.title,
        thumbHash: item.thumbHash,
        thumbWidth: item.thumbWidth,
        thumbHeight: item.thumbHeight,
        imageHash: item.imageHash,
        imageWidth: item.imageWidth,
        imageHeight: item.imageHeight,
        tags: [],
      })),
      index,
    )
  }

  /** Right-click on an image: a selected one copies the selected images, another only itself. */
  function onContextMenu(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault()
    const hit = keyAt(document.elementFromPoint(event.clientX, event.clientY))
    const parsed = hit ? parseKey(hit) : null
    if (!hit || parsed?.kind !== 'i') return
    const current = stateRef.current
    const keys = selected.has(hit) ? selected : new Set<ObjectKey>([hit])
    if (!selected.has(hit)) setSelected(keys)
    const items = current.items.filter((item) => keys.has(itemKey(item.id)))
    setMenu({ ids: referencesInReadingOrder(items), x: event.clientX, y: event.clientY })
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes(LIBRARY_DRAG_TYPE)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  async function onDrop(event: DragEvent<HTMLDivElement>) {
    const raw = event.dataTransfer.getData(LIBRARY_DRAG_TYPE)
    if (!raw) return
    event.preventDefault()
    event.stopPropagation()
    let ids: number[]
    try {
      ids = (JSON.parse(raw) as unknown[]).filter(
        (value): value is number =>
          typeof value === 'number' && Number.isInteger(value) && value > 0,
      )
    } catch {
      return
    }
    if (ids.length === 0) return
    try {
      // Each dropped image gets a new placement, also when it is on the board already.
      const { itemIds } = await call('boards:addRefs', {
        boardId,
        ids,
        at: toCanvas(view.current, localPoint(event)),
      })
      setSelected(new Set(itemIds.map(itemKey)))
      reload()
    } catch (error) {
      reportError(error)
    }
  }

  // ---- Render ------------------------------------------------------------

  const single = selected.size === 1 ? [...selected][0] : undefined
  const selectedNotes = state.notes.filter((note) => selected.has(noteKey(note.id)))
  const selectedGroups = state.groups.filter((group) => selected.has(groupKey(group.id)))
  const keys: Array<ObjectKey | 'draft'> = [...order, ...(draft ? (['draft'] as const) : [])]
  const hasContent = state.items.length + state.notes.length > 0

  function renderNote(note: BoardNote, key: string) {
    const at = notePosition(note, itemMap)
    if (!at) return null
    const isSelected = key !== 'draft' && selected.has(key as ObjectKey)
    const editing = editingNote === note.id
    return (
      <div
        key={key}
        ref={(el) => {
          if (el) elements.current.set(key, el)
          else elements.current.delete(key)
        }}
        className={
          'canvas-note' +
          (note.background ? ' with-background' : '') +
          (note.width === null ? ' auto-width' : '') +
          (isSelected ? ' selected' : '') +
          (editing ? ' editing' : '')
        }
        data-key={key === 'draft' ? undefined : key}
        data-testid="canvas-note"
        data-note-id={note.id}
        role="note"
        aria-label={note.text.split('\n')[0] || 'Note'}
        style={{
          left: at.x,
          top: at.y,
          width: note.width ?? undefined,
          fontSize: NOTE_FONT[note.fontSize],
          color: PALETTE_HEX[note.color],
        }}
      >
        {editing ? (
          <NoteEditor text={note.text} onDone={(text) => void finishNote(text)} />
        ) : (
          note.text
        )}
        {isSelected && single === key && !editing && (
          <span className="canvas-handle note-width" data-handle="e" aria-label="Note width" />
        )}
      </div>
    )
  }

  return (
    <div
      ref={stage}
      className={'canvas-stage' + (panReady ? ' pan-ready' : '')}
      data-testid="canvas"
      data-zoom={zoomLabel}
      tabIndex={-1}
      aria-label="Board canvas"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onDragOver={onDragOver}
      onDrop={(event) => void onDrop(event)}
      onAuxClick={(event) => event.preventDefault()}
    >
      <div ref={world} className="canvas-world">
        {keys.map((key) => {
          if (key === 'draft') return draft ? renderNote(draft, 'draft') : null
          const parsed = parseKey(key)
          if (!parsed) return null
          if (parsed.kind === 'g') {
            const group = groups.get(parsed.id)
            const frameBox = group ? groupBounds(group.id, state, noteSizes) : null
            if (!group || !frameBox) return null
            const hex = PALETTE_HEX[group.color]
            return (
              <div
                key={key}
                ref={(el) => {
                  if (el) elements.current.set(key, el)
                  else elements.current.delete(key)
                }}
                className={
                  'canvas-group' +
                  (selected.has(key) ? ' selected' : '') +
                  (entered === group.id ? ' entered' : '')
                }
                data-key={key}
                data-testid="canvas-group"
                data-group-id={group.id}
                data-locked={group.locked}
                role="group"
                aria-label={group.title}
                style={{
                  left: frameBox.x,
                  top: frameBox.y,
                  width: frameBox.width,
                  height: frameBox.height,
                  borderColor: `${hex}88`,
                  background: `${hex}26`,
                  color: hex,
                }}
              >
                {editingTitle === group.id ? (
                  <input
                    className="group-title-input"
                    defaultValue={group.title}
                    aria-label="Group title"
                    autoFocus
                    maxLength={100}
                    onBlur={(event) => renameGroup(group.id, event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                      if (event.key === 'Escape') setEditingTitle(null)
                    }}
                  />
                ) : (
                  <span className="group-title" data-role="group-title" data-testid="group-title">
                    {group.locked ? '🔒 ' : ''}
                    {group.title}
                  </span>
                )}
              </div>
            )
          }
          if (parsed.kind === 'n') {
            const note = state.notes.find((entry) => entry.id === parsed.id)
            return note ? renderNote(note, key) : null
          }
          const item = itemMap.get(parsed.id)
          if (!item) return null
          const isSelected = selected.has(key)
          return (
            <div
              key={key}
              ref={(el) => {
                if (el) elements.current.set(key, el)
                else elements.current.delete(key)
              }}
              className={
                'canvas-item' +
                (isSelected ? ' selected' : '') +
                (item.groupId !== null ? ' grouped' : '')
              }
              data-key={key}
              data-testid="canvas-item"
              data-ref-id={item.referenceId}
              data-item-id={item.id}
              role="img"
              aria-label={item.title}
              aria-selected={isSelected}
              style={{
                left: item.x,
                top: item.y,
                width: item.imageWidth * item.scale,
                height: item.imageHeight * item.scale,
              }}
            >
              <img
                ref={(el) => {
                  if (el) images.current.set(item.id, el)
                  else images.current.delete(item.id)
                }}
                src={assetUrl(item.thumbHash)}
                alt=""
                draggable={false}
                decoding="async"
              />
              {isSelected &&
                single === key &&
                CORNERS.map((corner) => (
                  <span key={corner} className={`canvas-handle ${corner}`} data-handle={corner} />
                ))}
            </div>
          )
        })}
      </div>

      {box && (
        <div
          className="canvas-box"
          style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
        />
      )}

      {!hasContent && !draft && (
        <div className="canvas-empty">
          <p>
            Drag images from the Library panel, drop files from Explorer, or paste with Ctrl+V.
            Double-click or press Ctrl+N for a note.
          </p>
        </div>
      )}

      <div className="canvas-toolbar" onPointerDown={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="btn ghost"
          onClick={fitAll}
          title="Fit all (F)"
          disabled={!hasContent}
        >
          Fit all
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={() => void groupSelection()}
          title="Group (Ctrl+G)"
          disabled={selected.size === 0}
        >
          Group
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={() => void ungroupSelection()}
          title="Ungroup (Ctrl+Shift+G)"
          disabled={
            ![...selected].some(
              (key) => parseKey(key)?.kind === 'g' || groupOf(key, state) !== null,
            )
          }
        >
          Ungroup
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            const { width, height } = viewport()
            startNote(toCanvas(view.current, { x: width / 2, y: height / 2 }))
          }}
          title="New note (Ctrl+N, or double-click empty canvas)"
        >
          Note
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={() => restackSelected('front')}
          title="Bring to front (])"
          disabled={selected.size === 0}
        >
          Front
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={() => restackSelected('back')}
          title="Send to back ([)"
          disabled={selected.size === 0}
        >
          Back
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={() => void deleteSelection()}
          title="Delete (images stay in the Library)"
          disabled={selected.size === 0}
        >
          Delete
        </button>
      </div>

      {(selectedNotes.length > 0 || selectedGroups.length > 0) && (
        <ObjectToolbar
          notes={selectedNotes}
          groups={selectedGroups}
          onNoteStyle={styleNotes}
          onGroupStyle={styleGroups}
          onAttachToggle={toggleAttach}
          onRename={() => selectedGroups[0] && setEditingTitle(selectedGroups[0].id)}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label="Image actions"
          items={copyMenuItems(menu.ids.length, () => onCopy(menu.ids))}
          onClose={() => setMenu(null)}
        />
      )}

      {groupDialog && (
        <div className="modal-backdrop" onPointerDown={(event) => event.stopPropagation()}>
          <div
            className="modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="group-delete-title"
          >
            <h2 id="group-delete-title" className="modal-title">
              Delete {groupDialog.length === 1 ? 'group' : `${groupDialog.length} groups`}?
            </h2>
            <p className="modal-message">
              Keep the images and notes inside, or remove them from the board too?
            </p>
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => setGroupDialog(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn danger-outline"
                onClick={() => void deleteSelection('remove')}
              >
                Remove contents too
              </button>
              <button
                type="button"
                className="btn primary"
                autoFocus
                onClick={() => void deleteSelection('keep')}
              >
                Keep contents
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="canvas-hud mono">
        <span data-testid="canvas-zoom">{zoomLabel}</span>
        <span data-testid="canvas-selection">
          {selected.size > 0 ? `${selected.size} selected` : `${state.items.length} images`}
        </span>
        <span className="canvas-keys">
          Space+drag pan · Wheel zoom · F fit · Ctrl+G group · Ctrl+N note · Ctrl+D duplicate ·
          Alt+drag copy · Ctrl+C copy image · Alt+click inside group · ] [ order · Del
        </span>
      </div>
    </div>
  )
}

/** In-place note text editing; Escape or clicking elsewhere finishes. */
function NoteEditor({ text, onDone }: { text: string; onDone: (text: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const done = useRef(false)
  // The editor starts from the note's text once; later renders must not reset what is typed.
  const initial = useRef(text)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.textContent = initial.current
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
  }, [])
  function finish() {
    if (done.current) return
    done.current = true
    onDone((ref.current?.innerText ?? '').replace(/\n$/, ''))
  }
  return (
    <div
      ref={ref}
      className="note-editor"
      contentEditable="plaintext-only"
      role="textbox"
      aria-label="Note text"
      aria-multiline="true"
      onBlur={finish}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.currentTarget.blur()
        }
      }}
    />
  )
}
