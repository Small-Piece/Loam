import { useState, type FormEvent } from 'react'
import type { BoardSummary } from '@loam/protocol'
import { AiProgress } from '../ai/AiProgress.tsx'
import { FolderIcon, GridIcon, PlusIcon, TrashIcon } from '../icons.tsx'
import { LIBRARY, samePlace, TRASH, type Place } from './place.ts'

interface Props {
  boards: BoardSummary[]
  totalCount: number
  trashCount: number
  place: Place
  onSelect: (place: Place) => void
  onCreate: (name: string) => Promise<void>
}

export function BoardSidebar({ boards, totalCount, trashCount, place, onSelect, onCreate }: Props) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')

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
      {boards.map((board) => {
        const target: Place = { kind: 'board', boardId: board.id }
        return (
          <button
            key={board.id}
            type="button"
            className={itemClass(target)}
            onClick={() => onSelect(target)}
          >
            <FolderIcon />
            <span className="board-name">{board.name}</span>
            <span className="board-count mono">{board.count}</span>
          </button>
        )
      })}
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
