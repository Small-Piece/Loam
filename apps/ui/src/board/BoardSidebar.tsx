import { useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from 'react'
import type { BoardSummary } from '@loam/protocol'
import { AiProgress } from '../ai/AiProgress.tsx'
import { FolderIcon, GridIcon, PlusIcon, TrashIcon } from '../icons.tsx'
import { BoardMenu } from './BoardMenu.tsx'
import { moveBoardBefore, moveBoardStep } from './boardOrder.ts'
import { LIBRARY, samePlace, TRASH, type Place } from './place.ts'

/** Drag data type for a board moved within the sidebar (references use their own). */
const BOARD_DRAG = 'application/x-loam-board'

interface Props {
  boards: BoardSummary[]
  totalCount: number
  trashCount: number
  place: Place
  onSelect: (place: Place) => void
  onCreate: (name: string) => Promise<void>
  /** Puts the boards in this order: every board id, once. */
  onReorder: (ids: number[]) => void
}

export function BoardSidebar({
  boards,
  totalCount,
  trashCount,
  place,
  onSelect,
  onCreate,
  onReorder,
}: Props) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [menuFor, setMenuFor] = useState<number | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  /** Where a dragged board would land: in front of this board, or at the end (null). */
  const [dropBefore, setDropBefore] = useState<number | null | undefined>(undefined)
  const buttons = useRef(new Map<number, HTMLButtonElement>())
  const ids = boards.map((board) => board.id)

  function reorder(next: number[] | null, focusId: number) {
    if (!next) return
    onReorder(next)
    // Keep the keyboard focus on the board that moved.
    requestAnimationFrame(() => buttons.current.get(focusId)?.focus())
  }

  function onBoardKey(event: KeyboardEvent<HTMLButtonElement>, boardId: number) {
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      reorder(moveBoardStep(ids, boardId, event.key === 'ArrowUp' ? -1 : 1), boardId)
    } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault()
      setMenuFor(boardId)
    }
  }

  function onDragOverBoard(event: DragEvent<HTMLElement>, boardId: number) {
    if (!event.dataTransfer.types.includes(BOARD_DRAG)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    const box = event.currentTarget.getBoundingClientRect()
    const at = ids.indexOf(boardId)
    setDropBefore(event.clientY < box.top + box.height / 2 ? boardId : (ids[at + 1] ?? null))
  }

  function onDragOverList(event: DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes(BOARD_DRAG)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropBefore(null)
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes(BOARD_DRAG)) return
    event.preventDefault()
    event.stopPropagation()
    const moved = Number(event.dataTransfer.getData(BOARD_DRAG))
    const before = dropBefore
    setDragging(null)
    setDropBefore(undefined)
    if (before !== undefined) reorder(moveBoardBefore(ids, moved, before), moved)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const clean = name.trim()
    if (clean.length > 0) await onCreate(clean)
    setName('')
    setAdding(false)
  }

  const itemClass = (target: Place) => 'board-item' + (samePlace(place, target) ? ' active' : '')

  return (
    <nav className="board-sidebar" aria-label="Boards">
      <div className="s-eyebrow">Library</div>
      <button type="button" className={itemClass(LIBRARY)} onClick={() => onSelect(LIBRARY)}>
        <GridIcon />
        <span className="board-name">All references</span>
        <span className="board-count mono">{totalCount}</span>
      </button>

      <div className="s-eyebrow board-heading">Boards</div>
      <div
        className={'board-list' + (dropBefore === null ? ' drop-end' : '')}
        role="list"
        aria-label="Boards in order"
        onDragOver={onDragOverList}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDropBefore(undefined)
          }
        }}
        onDrop={onDrop}
      >
        {boards.map((board, at) => {
          const target: Place = { kind: 'board', boardId: board.id }
          return (
            <div
              key={board.id}
              role="listitem"
              className={
                'board-row' +
                (dragging === board.id ? ' dragging' : '') +
                (dropBefore === board.id ? ' drop-before' : '')
              }
              data-testid="board-row"
              onDragOver={(event) => onDragOverBoard(event, board.id)}
              onDrop={onDrop}
            >
              <button
                type="button"
                className={itemClass(target)}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Shift+F10"
                ref={(node) => {
                  if (node) buttons.current.set(board.id, node)
                  else buttons.current.delete(board.id)
                }}
                draggable
                onClick={() => onSelect(target)}
                onKeyDown={(event) => onBoardKey(event, board.id)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setMenuFor(board.id)
                }}
                onDragStart={(event) => {
                  event.dataTransfer.setData(BOARD_DRAG, String(board.id))
                  event.dataTransfer.effectAllowed = 'move'
                  setDragging(board.id)
                }}
                onDragEnd={() => {
                  setDragging(null)
                  setDropBefore(undefined)
                }}
              >
                <FolderIcon />
                <span className="board-name">{board.name}</span>
                <span className="board-count mono">{board.count}</span>
              </button>
              {menuFor === board.id && (
                <BoardMenu
                  name={board.name}
                  canMoveUp={at > 0}
                  canMoveDown={at < boards.length - 1}
                  onMove={(step) => reorder(moveBoardStep(ids, board.id, step), board.id)}
                  onClose={() => {
                    setMenuFor(null)
                    buttons.current.get(board.id)?.focus()
                  }}
                />
              )}
            </div>
          )
        })}
      </div>
      {boards.length === 0 && !adding && <p className="board-empty">No boards yet.</p>}

      {adding ? (
        <form onSubmit={(event) => void submit(event)}>
          <input
            className="text-input"
            aria-label="New board name"
            placeholder="Board name"
            autoFocus
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => {
              if (name.trim() === '') setAdding(false)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setName('')
                setAdding(false)
              }
            }}
          />
        </form>
      ) : (
        <button type="button" className="board-add" onClick={() => setAdding(true)}>
          <PlusIcon size={12} /> New board
        </button>
      )}

      <div className="board-sidebar-end">
        <AiProgress />
        <button type="button" className={itemClass(TRASH)} onClick={() => onSelect(TRASH)}>
          <TrashIcon />
          <span className="board-name">Trash</span>
          <span className="board-count mono" data-testid="trash-count">
            {trashCount}
          </span>
        </button>
      </div>
    </nav>
  )
}
