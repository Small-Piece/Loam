import type { EntryViewData, IdeaCardData, TimelineItemData } from '@loam/protocol'
import { PlusIcon } from '../icons.tsx'

type Summary = EntryViewData['backlinks'][number]

function Pillars({ pillars, noPillar }: { pillars: readonly Summary[]; noPillar: boolean }) {
  if (noPillar) return <span className="no-pillar">Serves no pillar</span>
  return (
    <span className="timeline-pillars">
      {pillars.map((pillar) => (
        <span key={pillar.path} className="chip">
          {pillar.title}
        </span>
      ))}
    </span>
  )
}

/** Every decision, newest first. */
export function TimelinePage({
  items,
  onOpen,
  onAdd,
}: {
  items: readonly TimelineItemData[]
  onOpen: (path: string) => void
  onAdd: () => void
}) {
  return (
    <section className="pillars-page" aria-label="Decision log">
      <header className="pillars-head">
        <div>
          <div className="s-eyebrow">Decisions</div>
          <h1 className="board-title">Decision log</h1>
          <p className="bible-muted">What was decided and why, newest first.</p>
        </div>
        <button type="button" className="btn" onClick={onAdd}>
          <PlusIcon size={12} /> New decision
        </button>
      </header>
      {items.length === 0 ? (
        <p className="bible-muted">No decisions yet.</p>
      ) : (
        <ol className="timeline">
          {items.map((item) => (
            <li key={item.path} className="timeline-item" data-path={item.path}>
              <span className="timeline-date mono">{item.date ?? 'no date'}</span>
              <div className="timeline-body">
                <button type="button" className="pillar-title" onClick={() => onOpen(item.path)}>
                  {item.title}
                </button>
                <div className="timeline-meta">
                  {item.status && (
                    <span className={`status-chip status-${item.status}`}>{item.status}</span>
                  )}
                  <Pillars pillars={item.pillars} noPillar={item.noPillar} />
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

const COLUMNS = [
  { status: 'parked', label: 'Parked' },
  { status: 'promoted', label: 'Promoted' },
  { status: 'dropped', label: 'Dropped' },
] as const

/** The idea parking lot: three columns by status. */
export function IdeasBoard({
  cards,
  onOpen,
  onAdd,
  onPromote,
  onStatus,
}: {
  cards: readonly IdeaCardData[]
  onOpen: (path: string) => void
  onAdd: () => void
  onPromote: (card: IdeaCardData) => void
  onStatus: (card: IdeaCardData, status: 'parked' | 'dropped') => void
}) {
  return (
    <section className="pillars-page" aria-label="Idea board">
      <header className="pillars-head">
        <div>
          <div className="s-eyebrow">Ideas</div>
          <h1 className="board-title">Idea parking lot</h1>
          <p className="bible-muted">Park ideas here; promote the ones that earn it.</p>
        </div>
        <button type="button" className="btn" onClick={onAdd}>
          <PlusIcon size={12} /> New idea
        </button>
      </header>
      <div className="idea-columns">
        {COLUMNS.map((column) => {
          const inColumn = cards.filter((card) => card.status === column.status)
          return (
            <section
              key={column.status}
              className="idea-column"
              aria-label={column.label}
              data-status={column.status}
            >
              <h2 className="s-eyebrow">
                {column.label} <span className="board-count">{inColumn.length}</span>
              </h2>
              {inColumn.map((card) => (
                <article key={card.path} className="idea-card" data-path={card.path}>
                  <button type="button" className="pillar-title" onClick={() => onOpen(card.path)}>
                    {card.title}
                  </button>
                  <Pillars pillars={card.pillars} noPillar={card.noPillar} />
                  {card.promotedTo && (
                    <button
                      type="button"
                      className="bible-link-button"
                      onClick={() => onOpen(card.promotedTo?.path ?? card.path)}
                    >
                      → {card.promotedTo.title}
                    </button>
                  )}
                  <div className="idea-actions">
                    {card.status !== 'promoted' && (
                      <button
                        type="button"
                        className="btn"
                        aria-label={`Promote ${card.title}`}
                        onClick={() => onPromote(card)}
                      >
                        Promote…
                      </button>
                    )}
                    {card.status === 'parked' && (
                      <button
                        type="button"
                        className="btn ghost"
                        aria-label={`Drop ${card.title}`}
                        onClick={() => onStatus(card, 'dropped')}
                      >
                        Drop
                      </button>
                    )}
                    {card.status === 'dropped' && (
                      <button
                        type="button"
                        className="btn ghost"
                        aria-label={`Park ${card.title}`}
                        onClick={() => onStatus(card, 'parked')}
                      >
                        Park again
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </section>
          )
        })}
      </div>
    </section>
  )
}

/** Decisions and ideas that name no pillar. */
export function ReviewPage({
  items,
  sectionName,
  onOpen,
}: {
  items: ReadonlyArray<Summary & { section: string }>
  sectionName: (id: string) => string
  onOpen: (path: string) => void
}) {
  return (
    <section className="pillars-page" aria-label="Review">
      <header className="pillars-head">
        <div>
          <div className="s-eyebrow">Review</div>
          <h1 className="board-title">Serves no pillar</h1>
          <p className="bible-muted">
            Decisions and ideas that name no pillar. Tick one, or ask whether the pillars are
            missing something.
          </p>
        </div>
      </header>
      {items.length === 0 ? (
        <p className="bible-muted">Every decision and idea serves a pillar.</p>
      ) : (
        <ul className="review-list" data-testid="review-list">
          {items.map((item) => (
            <li key={item.path}>
              <span className="trash-kind">{sectionName(item.section)}</span>{' '}
              <button type="button" className="bible-link-button" onClick={() => onOpen(item.path)}>
                {item.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
