import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasOp, ReferenceCard, RequestOf, ResponseOf } from '@loam/protocol'
import { call } from '../api.ts'
import { CanvasBoard, type CanvasApi } from '../canvas/CanvasBoard.tsx'
import { LibraryPanel } from '../canvas/LibraryPanel.tsx'
import { ImageIcon, SearchIcon, TrashIcon } from '../icons.tsx'
import { BoardSidebar } from './BoardSidebar.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { DetailPanel } from './DetailPanel.tsx'
import { prepareImages } from './images.ts'
import { MasonryGrid } from './MasonryGrid.tsx'
import { boardIdOf, LIBRARY, type Place } from './place.ts'
import { SelectionBar } from './SelectionBar.tsx'
import { TagFilter } from './TagFilter.tsx'
import { useBoxSelect } from './useBoxSelect.ts'
import { useImageIntake, type IncomingFile, type DropPoint } from './useImageIntake.ts'
import { useSelection } from './useSelection.ts'
import { Viewer } from './Viewer.tsx'

type BoardView = ResponseOf<'refs:listBoard'>
type ImportResult = ResponseOf<'refs:import'>['results'][number]
type StoredResult = Exclude<ImportResult, { status: 'rejected' }>
type Toast = { kind: 'info' | 'error'; text: string; undoable?: boolean }

/** One undoable action. Ctrl+Z reverts the most recent one. */
type UndoEntry =
  | { kind: 'trash'; ids: number[] }
  /** Board and canvas edits: applying these steps (computed by the backend) reverts them. */
  | { kind: 'canvas'; boardId: number; ops: CanvasOp[]; undone: string }

const MAX_PER_IMPORT = 200
const SEARCH_DELAY_MS = 150
const UNDO_LIMIT = 50

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function summarize(results: ImportResult[], unreadable: number): string {
  const count = (status: ImportResult['status']) =>
    results.filter((result) => result.status === status).length
  const parts = [`Imported ${count('created')}`]
  if (count('duplicate') > 0) parts.push(`${count('duplicate')} already in library`)
  if (count('restored') > 0) parts.push(`${count('restored')} restored from Trash`)
  const skipped = count('rejected') + unreadable
  if (skipped > 0) parts.push(`${skipped} skipped (not an image)`)
  return parts.join(' · ')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Keys typed into a text field belong to the field, not to the board. */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.matches('input, textarea, select')
}

export function ReferenceBoard() {
  const [place, setPlace] = useState<Place>(LIBRARY)
  const [tags, setTags] = useState<string[]>([])
  const [text, setText] = useState('')
  const searchText = useDebounced(text, SEARCH_DELAY_MS)
  const [view, setView] = useState<BoardView | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [viewer, setViewer] = useState<{
    cards: ReferenceCard[]
    index: number
    openedAt: number
    fromCanvas: boolean
  } | null>(null)
  const [confirmEmpty, setConfirmEmpty] = useState(false)
  const [canvasVersion, setCanvasVersion] = useState(0)
  const [onBoard, setOnBoard] = useState<ReadonlySet<number>>(new Set())
  const latestRequest = useRef(0)
  const undoStack = useRef<UndoEntry[]>([])
  const canvasApi = useRef<CanvasApi | null>(null)

  const items = useMemo(() => view?.items ?? [], [view])
  const order = useMemo(() => items.map((item) => item.id), [items])
  const selection = useSelection(order)
  const boardId = boardIdOf(place)
  const inTrash = place.kind === 'trash'
  const currentBoard = view?.boards.find((board) => board.id === boardId) ?? null
  const canvasMode = currentBoard !== null && currentBoard.viewMode === 'canvas'
  const refreshCanvas = useCallback(() => setCanvasVersion((version) => version + 1), [])

  const showError = useCallback((message: string) => setToast({ kind: 'error', text: message }), [])

  /** Loads the board view; only the newest request may update the screen. */
  const reload = useCallback(() => {
    const requestNumber = ++latestRequest.current
    const request: RequestOf<'refs:listBoard'> = { boardId, inTrash, tags, text: searchText }
    call('refs:listBoard', request)
      .then((next) => {
        if (requestNumber === latestRequest.current) setView(next)
      })
      .catch((error: unknown) => showError(messageOf(error)))
  }, [boardId, inTrash, tags, searchText, showError])

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => {
    if (!toast) return
    const delay = toast.kind === 'error' ? 8000 : toast.undoable ? 8000 : 4000
    const timer = setTimeout(() => setToast(null), delay)
    return () => clearTimeout(timer)
  }, [toast])

  function goTo(next: Place) {
    setPlace(next)
    selection.clear()
  }

  const importFiles = useCallback(
    async (files: IncomingFile[], point: DropPoint | null) => {
      setBusy(true)
      // On a canvas, files land where they were dropped, or mid-view when pasted.
      const api = canvasMode ? canvasApi.current : null
      const at = api
        ? ((point ? api.canvasPointAt(point.clientX, point.clientY) : null) ?? api.viewCenter())
        : null
      try {
        const prepared = await prepareImages(files)
        const uploads = prepared.flatMap((entry) => (entry.ok ? [entry.upload] : []))
        const unreadable = prepared.length - uploads.length
        const results: ImportResult[] = []
        for (let start = 0; start < uploads.length; start += MAX_PER_IMPORT) {
          const batch = uploads.slice(start, start + MAX_PER_IMPORT)
          const response = await call('refs:import', { items: batch, boardId, at })
          results.push(...response.results)
        }
        setToast({ kind: 'info', text: summarize(results, unreadable) })
        const first = results.find((result): result is StoredResult => result.status !== 'rejected')
        if (first) selection.set([first.id], false)
        reload()
        refreshCanvas()
      } catch (error) {
        showError(messageOf(error))
      } finally {
        setBusy(false)
      }
    },
    [boardId, canvasMode, refreshCanvas, reload, selection, showError],
  )

  const dragging = useImageIntake((files, point) => void importFiles(files, point))

  function pushUndo(entry: UndoEntry) {
    undoStack.current = [...undoStack.current, entry].slice(-UNDO_LIMIT)
  }

  async function moveSelectionToTrash() {
    const ids = selection.ids
    if (ids.length === 0) return
    try {
      const { ids: moved } = await call('refs:delete', { ids })
      if (moved.length > 0) pushUndo({ kind: 'trash', ids: moved })
      selection.clear()
      setToast({
        kind: 'info',
        text: `Moved ${plural(moved.length, 'reference')} to Trash`,
        undoable: true,
      })
      reload()
    } catch (error) {
      showError(messageOf(error))
    }
  }

  async function removeSelectionFromBoard() {
    if (place.kind !== 'board' || selection.ids.length === 0) return
    const boardName = view?.boards.find((board) => board.id === place.boardId)?.name ?? 'board'
    try {
      const { ids: removed, undo: undoSteps } = await call('boards:removeRefs', {
        boardId: place.boardId,
        ids: selection.ids,
      })
      if (removed.length > 0) {
        pushUndo({
          kind: 'canvas',
          boardId: place.boardId,
          ops: undoSteps,
          undone: `Put ${plural(removed.length, 'reference')} back on ${boardName}`,
        })
      }
      selection.clear()
      setToast({
        kind: 'info',
        text: `Removed ${plural(removed.length, 'reference')} from ${boardName} (still in the Library)`,
        undoable: true,
      })
      reload()
    } catch (error) {
      showError(messageOf(error))
    }
  }

  async function restoreSelection() {
    if (selection.ids.length === 0) return
    try {
      const { ids: restored } = await call('refs:restore', { ids: selection.ids })
      selection.clear()
      setToast({ kind: 'info', text: `Restored ${plural(restored.length, 'reference')}` })
      reload()
    } catch (error) {
      showError(messageOf(error))
    }
  }

  async function undo() {
    const entry = undoStack.current.at(-1)
    if (!entry) {
      setToast({ kind: 'info', text: 'Nothing to undo' })
      return
    }
    undoStack.current = undoStack.current.slice(0, -1)
    try {
      if (entry.kind === 'trash') {
        const { ids } = await call('refs:restore', { ids: entry.ids })
        const lost = entry.ids.length - ids.length
        setToast({
          kind: lost > 0 ? 'error' : 'info',
          text:
            `Restored ${plural(ids.length, 'reference')}` +
            (lost > 0 ? ` · ${lost} were already deleted permanently` : ''),
        })
        if (place.kind !== 'trash') selection.set(ids, false)
      } else {
        if (entry.ops.length > 0) {
          await call('canvas:apply', { boardId: entry.boardId, ops: entry.ops })
        }
        setToast({ kind: 'info', text: entry.undone })
        refreshCanvas()
      }
      reload()
    } catch (error) {
      showError(messageOf(error))
    }
  }

  async function emptyTrash() {
    setConfirmEmpty(false)
    try {
      const result = await call('trash:empty', {})
      // Deleted references can no longer come back.
      undoStack.current = undoStack.current.filter((entry) => entry.kind !== 'trash')
      selection.clear()
      setToast({
        kind: 'info',
        text: `Deleted ${plural(result.deletedReferences, 'reference')} and ${plural(result.deletedFiles, 'file')} permanently`,
      })
      reload()
    } catch (error) {
      showError(messageOf(error))
    }
  }

  async function setViewMode(mode: 'canvas' | 'grid') {
    if (boardId === null) return
    try {
      await call('boards:setViewMode', { boardId, mode })
      selection.clear()
      reload()
    } catch (error) {
      showError(messageOf(error))
    }
  }

  async function createBoard(name: string) {
    try {
      const { board } = await call('boards:create', { name })
      goTo({ kind: 'board', boardId: board.id })
      reload()
    } catch (error) {
      showError(messageOf(error))
    }
  }

  function openViewer(id: number | null, openedAt = performance.now()) {
    const index = id === null ? -1 : order.indexOf(id)
    if (index >= 0) setViewer({ cards: items, index, openedAt, fromCanvas: false })
  }

  /** A canvas edit that Ctrl+Z (or the toast) can revert. */
  const recordCanvasEdit = useCallback(
    (ops: CanvasOp[], message: string) => {
      if (boardId === null || ops.length === 0) return
      undoStack.current = [
        ...undoStack.current,
        { kind: 'canvas' as const, boardId, ops, undone: `Undid: ${message}` },
      ].slice(-UNDO_LIMIT)
      setToast({ kind: 'info', text: message, undoable: true })
      reload()
    },
    [boardId, reload],
  )

  function closeViewer() {
    const fromCanvas = viewer?.fromCanvas ?? false
    const id = viewer ? viewer.cards[viewer.index]?.id : undefined
    setViewer(null)
    // Leave the last viewed image selected, so the grid shows where you were.
    if (id !== undefined && !fromCanvas) {
      selection.set([id], false)
      document.querySelector<HTMLElement>(`[data-ref-id="${id}"]`)?.focus()
    }
  }

  // Board shortcuts. The viewer and dialogs capture their own keys first.
  const shortcuts = useRef<(event: KeyboardEvent) => void>(() => undefined)
  const handleShortcut = (event: KeyboardEvent) => {
    if (viewer || confirmEmpty || isEditable(event.target)) return
    const ctrl = event.ctrlKey || event.metaKey
    if (ctrl && event.key.toLowerCase() === 'z' && !event.shiftKey) {
      event.preventDefault()
      void undo()
    } else if (canvasMode) {
      // The canvas handles its own keys (Space pans there; it never opens the viewer).
      return
    } else if (ctrl && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      selection.selectAll()
    } else if (event.key === 'Delete' && selection.ids.length > 0) {
      event.preventDefault()
      // In a board, Delete only takes cards off the board; in the Library it moves them to Trash.
      if (place.kind === 'board') void removeSelectionFromBoard()
      else if (place.kind === 'library') void moveSelectionToTrash()
    } else if (event.key === ' ' && selection.primary !== null) {
      event.preventDefault()
      openViewer(selection.primary, event.timeStamp)
    } else if (event.key === 'Escape' && selection.ids.length > 0) {
      selection.clear()
    }
  }
  useEffect(() => {
    shortcuts.current = handleShortcut
  })
  useEffect(() => {
    const listener = (event: KeyboardEvent) => shortcuts.current(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  const box = useBoxSelect({
    onSelect: selection.set,
    currentSelection: () => selection.ids,
    onEmptyClick: selection.clear,
  })

  function toggleTag(tag: string) {
    setTags((current) =>
      current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag],
    )
  }

  const boards = view?.boards ?? []
  const title =
    place.kind === 'library'
      ? 'All references'
      : place.kind === 'trash'
        ? 'Trash'
        : (boards.find((b) => b.id === place.boardId)?.name ?? 'Board')
  const filtering = tags.length > 0 || searchText.trim().length > 0
  const detailId = !inTrash && selection.ids.length === 1 ? selection.primary : null
  const trashCount = view?.trashCount ?? 0

  return (
    <div className="board-app">
      <BoardSidebar
        boards={boards}
        totalCount={view?.totalCount ?? 0}
        trashCount={trashCount}
        place={place}
        onSelect={goTo}
        onCreate={createBoard}
      />

      <main className="board-main">
        <header className="board-topbar">
          <div>
            <div className="s-eyebrow">{inTrash ? 'Deleted references' : 'References'}</div>
            <h1 className="board-title">{title}</h1>
            <div className="board-meta mono" data-testid="result-count">
              {plural(items.length, 'reference')}
              {filtering ? ' match' : ''}
            </div>
          </div>
          <div className="board-topbar-actions">
            {currentBoard && (
              <div className="view-toggle" role="group" aria-label="Board view">
                {(['canvas', 'grid'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={currentBoard.viewMode === mode ? 'active' : ''}
                    aria-pressed={currentBoard.viewMode === mode}
                    onClick={() => void setViewMode(mode)}
                  >
                    {mode === 'canvas' ? 'Canvas' : 'Grid'}
                  </button>
                ))}
              </div>
            )}
            {inTrash && (
              <button
                type="button"
                className="btn danger-outline"
                disabled={trashCount === 0}
                onClick={() => setConfirmEmpty(true)}
              >
                <TrashIcon size={12} /> Empty Trash
              </button>
            )}
            {!canvasMode && (
              <label className="search">
                <SearchIcon size={12} />
                <input
                  type="search"
                  aria-label="Search title and note"
                  placeholder="Search title and note…"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
              </label>
            )}
          </div>
        </header>

        {canvasMode && boardId !== null ? (
          <CanvasBoard
            key={boardId}
            boardId={boardId}
            version={canvasVersion}
            apiRef={canvasApi}
            keysEnabled={!viewer && !confirmEmpty}
            onItemsLoaded={(ids) => {
              setOnBoard(new Set(ids))
              // Board counts in the sidebar and header follow the canvas.
              reload()
            }}
            onUndoable={recordCanvasEdit}
            onOpenViewer={(cards, index) =>
              setViewer({ cards, index, openedAt: performance.now(), fromCanvas: true })
            }
            onError={showError}
          />
        ) : (
          <>
            <TagFilter
              tags={view?.tags ?? []}
              selected={tags}
              onToggle={toggleTag}
              onClear={() => setTags([])}
            />

            {selection.ids.length > 0 && (
              <SelectionBar
                place={place}
                count={selection.ids.length}
                onView={() => openViewer(selection.primary)}
                onMoveToTrash={() => void moveSelectionToTrash()}
                onRemoveFromBoard={() => void removeSelectionFromBoard()}
                onRestore={() => void restoreSelection()}
                onClear={selection.clear}
              />
            )}

            <section
              className="board-scroll"
              aria-label="References"
              aria-busy={busy}
              {...box.handlers}
            >
              {view && items.length === 0 && (
                <div className="board-empty-state">
                  {inTrash ? <TrashIcon size={28} /> : <ImageIcon size={28} />}
                  {filtering ? (
                    <p>No references match these filters.</p>
                  ) : inTrash ? (
                    <p>The Trash is empty.</p>
                  ) : (
                    <>
                      <p>Drop images here from Explorer, or paste a screenshot with Ctrl+V.</p>
                      <p className="hint">Images stay on this computer. Nothing is uploaded.</p>
                    </>
                  )}
                </div>
              )}
              <MasonryGrid
                items={items}
                isSelected={selection.has}
                onClickCard={selection.click}
                onOpenCard={(id) => openViewer(id)}
              />
            </section>
          </>
        )}
      </main>

      {/* The right column is always there, so selecting never reflows the grid under the pointer. */}
      {canvasMode ? (
        <LibraryPanel version={canvasVersion} onBoard={onBoard} onError={showError} />
      ) : detailId !== null ? (
        <DetailPanel
          key={detailId}
          id={detailId}
          boards={boards}
          onClose={selection.clear}
          onSaved={reload}
          onError={showError}
        />
      ) : (
        <aside className="detail detail-placeholder" aria-label="Reference detail">
          <p>
            {selection.ids.length > 1
              ? `${plural(selection.ids.length, 'reference')} selected`
              : inTrash
                ? 'Select references to restore them.'
                : 'Select a reference to see and edit its details.'}
          </p>
          <p className="hint">Double-click or press Space to view large.</p>
        </aside>
      )}

      {box.box && (
        <div
          className="box-select"
          aria-hidden="true"
          style={{
            left: box.box.left,
            top: box.box.top,
            width: box.box.width,
            height: box.box.height,
          }}
        />
      )}

      {viewer && (
        <Viewer
          items={viewer.cards}
          index={viewer.index}
          openedAt={viewer.openedAt}
          onIndexChange={(index) => setViewer({ ...viewer, index, openedAt: performance.now() })}
          onClose={closeViewer}
        />
      )}

      {confirmEmpty && (
        <ConfirmDialog
          title="Empty Trash?"
          message={`${plural(trashCount, 'reference')} will be deleted permanently, with any image files no other reference uses. This cannot be undone.`}
          confirmLabel="Empty Trash"
          onConfirm={() => void emptyTrash()}
          onCancel={() => setConfirmEmpty(false)}
        />
      )}

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-card">
            <ImageIcon size={22} />
            Drop to add to {inTrash ? 'the Library' : title}
          </div>
        </div>
      )}
      {busy && <div className="busy-bar" role="progressbar" aria-label="Importing images" />}
      {toast && (
        <div className={'toast ' + toast.kind} role="status" data-testid="toast">
          <span data-testid="toast-text">{toast.text}</span>
          {toast.undoable && (
            <button type="button" className="toast-action" onClick={() => void undo()}>
              Undo <kbd>Ctrl+Z</kbd>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
