import { useState, type DragEvent } from 'react'
import type { PillarCardData } from '@loam/protocol'
import { PlusIcon } from '../icons.tsx'
import { EntryMenu, type EntryAction } from './EntryMenu.tsx'

/** More pillars than this get a gentle note; nothing is blocked. */
export const PILLAR_SOFT_LIMIT = 5

const DRAG_TYPE = 'application/x-um-pillar'

interface Props {
  cards: readonly PillarCardData[]
  sections: ReadonlyArray<{ id: string; name: string }>
  onOpen: (path: string) => void
  onAdd: () => void
  onReorder: (paths: string[], moved: string) => void
  onAction: (path: string, title: string, action: EntryAction) => void
  onRename: (path: string, title: string) => Promise<boolean>
}

function Part({ label, text }: { label: string; text: string }) {
  if (!text) return null
  return (
    <div className="pillar-part">
      <div className="s-eyebrow">{label}</div>
      <p>{text}</p>
    </div>
  )
}

/** The Pillars section as cards: what every decision is checked against. */
export function PillarsPage({
  cards,
  sections,
  onOpen,
  onAdd,
  onReorder,
  onAction,
  onRename,
}: Props) {
  const [menu, setMenu] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  function commitRename(path: string, title: string) {
    setRenaming(null)
    const next = draft.trim()
    if (next !== '' && next !== title) void onRename(path, next)
  }
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)

  function drop(event: DragEvent<HTMLElement>, index: number) {
    event.preventDefault()
    const moved = event.dataTransfer.getData(DRAG_TYPE)
    setDragging(null)
    setDropAt(null)
    if (!moved) return
    const paths = cards.map((card) => card.path).filter((path) => path !== moved)
    const from = cards.findIndex((card) => card.path === moved)
    const to = index > from ? index - 1 : index
    paths.splice(to, 0, moved)
    if (paths.join('\n') !== cards.map((card) => card.path).join('\n')) onReorder(paths, moved)
  }

  return (
    <section className="pillars-page" aria-label="Pillars">
      <header className="pillars-head">
        <div>
          <div className="s-eyebrow">Pillars</div>
          <h1 className="board-title">What every decision is checked against</h1>
        </div>
        <button type="button" className="btn" onClick={onAdd}>
          <PlusIcon size={12} /> Add pillar
        </button>
      </header>
      {cards.length > PILLAR_SOFT_LIMIT && (
        <p className="pillars-note" role="note" data-testid="pillar-note">
          You have {cards.length} pillars. Most games stay clearer with {PILLAR_SOFT_LIMIT} or
          fewer; consider merging the ones that overlap.
        </p>
      )}
      {cards.length === 0 ? (
        <p className="bible-muted">No pillars yet. Add one: a feeling players should have.</p>
      ) : (
        <ol className="pillar-cards">
          {cards.map((card, index) => (
            <li
              key={card.path}
              className={
                'pillar-card' +
                (dragging === card.path ? ' dragging' : '') +
                (dropAt === index ? ' drop-before' : '') +
                (dropAt === cards.length && index === cards.length - 1 ? ' drop-after' : '')
              }
              data-path={card.path}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(DRAG_TYPE, card.path)
                event.dataTransfer.effectAllowed = 'move'
                setDragging(card.path)
              }}
              onDragEnd={() => {
                setDragging(null)
                setDropAt(null)
              }}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
                event.preventDefault()
                const box = event.currentTarget.getBoundingClientRect()
                setDropAt(event.clientY < box.top + box.height / 2 ? index : index + 1)
              }}
              onDrop={(event) => drop(event, dropAt ?? index)}
            >
              <div className="pillar-card-head">
                <span className="pillar-number">{index + 1}</span>
                {renaming === card.path ? (
                  <input
                    className="bible-input pillar-title-input"
                    aria-label="Pillar name"
                    autoFocus
                    value={draft}
                    onFocus={(event) => event.currentTarget.select()}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => commitRename(card.path, card.title)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                      if (event.key === 'Escape') setRenaming(null)
                    }}
                  />
                ) : (
                  <button type="button" className="pillar-title" onClick={() => onOpen(card.path)}>
                    {card.title}
                  </button>
                )}
                <button
                  type="button"
                  className="bible-icon-button"
                  aria-label={`Actions for ${card.title}`}
                  aria-expanded={menu === card.path}
                  onClick={() => setMenu(menu === card.path ? null : card.path)}
                >
                  ⋯
                </button>
                {menu === card.path && (
                  <EntryMenu
                    title={card.title}
                    sections={sections}
                    currentSection="pillars"
                    canMoveUp={index > 0}
                    canMoveDown={index < cards.length - 1}
                    onClose={() => setMenu(null)}
                    onAction={(action) => {
                      if (action.kind === 'rename') {
                        setDraft(card.title)
                        setRenaming(card.path)
                      } else {
                        onAction(card.path, card.title, action)
                      }
                    }}
                  />
                )}
              </div>
              <div className="pillar-counts" data-testid="pillar-counts">
                {card.decisions} {card.decisions === 1 ? 'decision' : 'decisions'} · {card.ideas}{' '}
                {card.ideas === 1 ? 'idea' : 'ideas'}
              </div>
              <Part label="The feeling" text={card.feeling} />
              <Part label="Looks like in play" text={card.inPlay} />
              <Part label="Rules out" text={card.rulesOut} />
              {!card.feeling && !card.inPlay && !card.rulesOut && (
                <p className="bible-muted">Empty. Open it to describe the feeling.</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
