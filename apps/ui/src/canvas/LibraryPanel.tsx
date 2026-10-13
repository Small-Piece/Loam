import { useEffect, useRef, useState, type DragEvent } from 'react'
import { assetUrl, type ResponseOf } from '@loam/protocol'
import { call } from '../api.ts'
import { SearchIcon } from '../icons.tsx'
import { LIBRARY_DRAG_TYPE } from './CanvasBoard.tsx'

type LibraryView = ResponseOf<'refs:listBoard'>

interface Props {
  /** Bump to refresh after imports or edits elsewhere. */
  version: number
  /** References already on the open board, marked in the list. */
  onBoard: ReadonlySet<number>
  onError: (message: string) => void
  /** Where dragged images go; the canvas by default. */
  hint?: string
}

const SEARCH_DELAY_MS = 150

/** The Library beside a canvas: search, filter by tag, and drag thumbnails onto the board. */
export function LibraryPanel({
  version,
  onBoard,
  onError,
  hint = 'Drag onto the canvas to place.',
}: Props) {
  const [text, setText] = useState('')
  const [search, setSearch] = useState('')
  const [tag, setTag] = useState('')
  const [view, setView] = useState<LibraryView | null>(null)
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

  function onDragStart(event: DragEvent<HTMLElement>, id: number) {
    event.dataTransfer.setData(LIBRARY_DRAG_TYPE, JSON.stringify([id]))
    event.dataTransfer.effectAllowed = 'copy'
  }

  const items = view?.items ?? []
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
      <div className="library-grid">
        {items.length === 0 && <p className="library-hint">No references match.</p>}
        {items.map((item) => (
          <div
            key={item.id}
            className={'library-item' + (onBoard.has(item.id) ? ' on-board' : '')}
            data-testid="library-item"
            data-ref-id={item.id}
            draggable
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
    </aside>
  )
}
