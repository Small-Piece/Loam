import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { assetUrl, type ResponseOf } from '@loam/protocol'
import { call } from '../api.ts'
import { ContextMenu, copyMenuItems } from '../board/ContextMenu.tsx'
import { copyImages } from '../board/copyImages.ts'
import { SearchIcon } from '../icons.tsx'
import { LIBRARY_DRAG_TYPE } from './CanvasBoard.tsx'
import { clickSelection, draggedIds } from './librarySelection.ts'

type LibraryView = ResponseOf<'refs:listBoard'>

interface Props {
  /** Bump to refresh after imports or edits elsewhere. */
  version: number
  /** References already on the open board, marked in the list. */
  onBoard: ReadonlySet<number>
  onError: (message: string) => void
  /** Short confirmations (what a copy put on the clipboard). */
  onNotice?: (message: string) => void
  /** Where dragged images go; the canvas by default. */
  hint?: string
}

const SEARCH_DELAY_MS = 150

/**
 * The Library beside a canvas: search, filter by tag, and drag thumbnails onto the board.
 * Ctrl+click and Shift+click select several tiles; dragging a selected tile drags them all.
 * Ctrl+C or right-click → Copy image copies the selected tiles' images to the clipboard.
 */
export function LibraryPanel({
  version,
  onBoard,
  onError,
  onNotice,
  hint = 'Drag onto the canvas to place.',
}: Props) {
  const [text, setText] = useState('')
  const [search, setSearch] = useState('')
  const [tag, setTag] = useState('')
  const [view, setView] = useState<LibraryView | null>(null)
  const [chosen, setChosen] = useState<ReadonlySet<number>>(new Set())
  const [menu, setMenu] = useState<{ ids: number[]; x: number; y: number } | null>(null)
  /** The tile a Shift+click range starts from. */
  const anchor = useRef<number | null>(null)
  const latest = useRef(0)
  const reportError = useRef(onError)
  useEffect(() => {
    reportError.current = onError
  })

  useEffect(() => {
    const timer = setTimeout(() => setSearch(text), SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [text])

  // version comes from the board page: it changes after imports and canvas edits.
  useEffect(() => {
    latest.current = Math.max(latest.current + 1, version)
    const request = latest.current
    call('refs:listBoard', { boardId: null, inTrash: false, tags: tag ? [tag] : [], text: search })
      .then((next) => {
        if (request === latest.current) setView(next)
      })
      .catch((error: unknown) => reportError.current(String(error)))
  }, [search, tag, version])

  const items = view?.items ?? []
  const order = items.map((item) => item.id)

  function onTileClick(event: MouseEvent<HTMLElement>, id: number) {
    const next = clickSelection(order, chosen, anchor.current, id, {
      toggle: event.ctrlKey || event.metaKey,
      range: event.shiftKey,
    })
    setChosen(next.selected)
    anchor.current = next.anchor
  }

  function copy(ids: readonly number[]) {
    if (ids.length === 0) return
    copyImages(ids)
      .then((message) => onNotice?.(message))
      .catch((error: unknown) => onError(String(error)))
  }

  function onListKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'c') return
    const ids = order.filter((id) => chosen.has(id))
    if (ids.length === 0) return
    // The canvas beside the panel must not copy its own selection as well.
    event.preventDefault()
    event.stopPropagation()
    copy(ids)
  }

  function onTileMenu(event: MouseEvent<HTMLElement>, id: number) {
    event.preventDefault()
    const ids = draggedIds(order, chosen, id)
    if (!chosen.has(id)) {
      setChosen(new Set([id]))
      anchor.current = id
    }
    setMenu({ ids, x: event.clientX, y: event.clientY })
  }

  function onDragStart(event: DragEvent<HTMLElement>, id: number) {
    const ids = draggedIds(order, chosen, id)
    if (!chosen.has(id)) {
      // Dragging a tile that is not selected drags only it, and selects it.
      setChosen(new Set([id]))
      anchor.current = id
    }
    event.dataTransfer.setData(LIBRARY_DRAG_TYPE, JSON.stringify(ids))
    event.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <aside className="library-panel" aria-label="Library">
      <div className="library-panel-head">
        <div className="s-eyebrow">Library</div>
        <label className="search">
          <SearchIcon size={12} />
          <input
            type="search"
            aria-label="Search the Library"
            placeholder="Search title and note…"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <select
          className="text-input library-tag"
          aria-label="Filter the Library by tag"
          value={tag}
          onChange={(event) => setTag(event.target.value)}
        >
          <option value="">All tags</option>
          {(view?.tags ?? []).map((entry) => (
            <option key={entry.name} value={entry.name}>
              {entry.name} ({entry.count})
            </option>
          ))}
          {tag && !(view?.tags ?? []).some((entry) => entry.name === tag) && (
            <option value={tag}>{tag}</option>
          )}
        </select>
        <p className="library-hint">{hint}</p>
      </div>
      <div
        className="library-grid"
        role="listbox"
        aria-label="Library references"
        aria-multiselectable="true"
        tabIndex={0}
        onKeyDown={onListKeyDown}
      >
        {items.length === 0 && <p className="library-hint">No references match.</p>}
        {items.map((item) => (
          <div
            key={item.id}
            className={
              'library-item' +
              (onBoard.has(item.id) ? ' on-board' : '') +
              (chosen.has(item.id) ? ' selected' : '')
            }
            data-testid="library-item"
            data-ref-id={item.id}
            role="option"
            aria-selected={chosen.has(item.id)}
            draggable
            onClick={(event) => onTileClick(event, item.id)}
            onContextMenu={(event) => onTileMenu(event, item.id)}
            onDragStart={(event) => onDragStart(event, item.id)}
            title={onBoard.has(item.id) ? `${item.title} (on this board)` : item.title}
            aria-label={item.title}
          >
            <img
              src={assetUrl(item.thumbHash)}
              width={item.thumbWidth}
              height={item.thumbHeight}
              alt=""
              loading="lazy"
              draggable={false}
            />
            <span className="library-item-title">{item.title}</span>
          </div>
        ))}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label="Library reference actions"
          items={copyMenuItems(menu.ids.length, () => copy(menu.ids))}
          onClose={() => setMenu(null)}
        />
      )}
    </aside>
  )
}
