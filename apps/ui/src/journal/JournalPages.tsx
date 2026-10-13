import { useMemo, useState, type MouseEvent } from 'react'
import type { ResourceItemData, ResponseOf, TodayViewData } from '@loam/protocol'
import { RecapPanel } from '../ai/RecapPanel.tsx'
import { PlusIcon } from '../icons.tsx'
import { renderMarkdown, titleKey } from '../bible/markdown.ts'
import { MONTHS, WEEKDAYS, dayKey, dayName, monthGrid, shade, shiftMonth } from './calendar.ts'

type Entries = ReadonlyArray<{ path: string; title: string }>

interface LinkHandlers {
  onOpen: (path: string) => void
  onCreateLinked: (title: string) => void
  onExternal: (url: string) => void
}

/** Follows a click on a rendered link: an entry, a missing entry, or a web page. */
function followLink(event: MouseEvent<HTMLElement>, handlers: LinkHandlers) {
  const link = (event.target as HTMLElement).closest('a')
  if (!link) return
  event.preventDefault()
  const target = link.dataset['path']
  const create = link.dataset['create']
  const external = link.dataset['external']
  if (target) handlers.onOpen(target)
  else if (create) handlers.onCreateLinked(create)
  else if (external) handlers.onExternal(external)
}

/** Today: today's sessions, a button for a new one, and where the last session said to go next. */
export function TodayPage({
  vaultId,
  today,
  entries,
  onNewSession,
  onRecapSaved,
  ...handlers
}: {
  vaultId: number
  today: TodayViewData | null
  entries: Entries
  onNewSession: () => void
  onRecapSaved: (saved: ResponseOf<'journal:saveRecap'>) => void
} & LinkHandlers) {
  const targets = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of entries) {
      if (!map.has(titleKey(item.title))) map.set(titleKey(item.title), item.path)
    }
    return map
  }, [entries])
  const previous = today?.previous ?? null
  const nextTime = previous?.nextTime ?? null
  const html = useMemo(
    () =>
      nextTime === null || previous === null
        ? ''
        : renderMarkdown(
            nextTime,
            (title) => targets.get(titleKey(title)) ?? null,
            previous.path,
            'journal',
          ),
    [nextTime, previous, targets],
  )

  return (
    <section className="pillars-page journal-page" aria-label="Today">
      <header className="pillars-head">
        <div>
          <div className="s-eyebrow">Today</div>
          <h1 className="board-title">{today ? dayName(today.today) : 'Today'}</h1>
        </div>
        <button type="button" className="btn primary" onClick={onNewSession}>
          <PlusIcon size={12} /> New session
        </button>
      </header>

      {today && today.sessions.length > 0 ? (
        <ul className="journal-list" aria-label="Today's sessions">
          {today.sessions.map((session) => (
            <li key={session.path}>
              <button
                type="button"
                className="bible-link-button"
                onClick={() => handlers.onOpen(session.path)}
              >
                {session.title}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="bible-muted">No session today yet.</p>
      )}

      <RecapPanel
        vaultId={vaultId}
        scope={{ kind: 'week' }}
        label="Recap this week"
        onSaved={onRecapSaved}
      />

      <section className="next-time" aria-label="Where you left off">
        <div className="s-eyebrow">Where you left off</div>
        {previous === null ? (
          <p className="bible-muted">This is where your previous session&apos;s next step shows.</p>
        ) : (
          <>
            <p className="bible-muted">
              From{' '}
              <button
                type="button"
                className="bible-link-button"
                onClick={() => handlers.onOpen(previous.path)}
              >
                {previous.title}
              </button>
              {previous.date ? ` · ${dayName(previous.date)}` : ''}
            </p>
            {nextTime === null ? (
              <p className="bible-muted">That session has no &ldquo;Next time&rdquo; notes.</p>
            ) : (
              <div
                className="markdown next-time-text"
                data-testid="next-time"
                onClick={(event) => followLink(event, handlers)}
                // Rendered by marked with raw HTML escaped and link targets checked (markdown.ts).
                dangerouslySetInnerHTML={{ __html: html }}
              />
            )}
          </>
        )}
      </section>
    </section>
  )
}

/** Sessions per day of a year, for the month view and the year view. */
export type CalendarDays = ReadonlyArray<{ date: string; sessions: Entries }>

function DayCell({
  day,
  count,
  selected,
  isToday,
  compact,
  onPick,
}: {
  day: string
  count: number
  selected: boolean
  isToday: boolean
  compact: boolean
  onPick: (day: string) => void
}) {
  const label = `${dayName(day)}${count > 0 ? `: ${count} ${count === 1 ? 'session' : 'sessions'}` : ''}`
  return (
    <button
      type="button"
      className={
        'cal-day' +
        (compact ? ' compact' : '') +
        (selected ? ' selected' : '') +
        (isToday ? ' today' : '')
      }
      data-shade={shade(count)}
      data-day={day}
      aria-label={label}
      aria-pressed={selected}
      title={label}
      onClick={() => onPick(day)}
    >
      {compact ? null : Number(day.slice(8))}
    </button>
  )
}

/** A month and a year of days with sessions; a day lists its sessions. */
export function CalendarPage({
  year,
  today,
  days,
  onYear,
  onOpen,
}: {
  year: number
  today: string
  days: CalendarDays
  onYear: (year: number) => void
  onOpen: (path: string) => void
}) {
  const [mode, setMode] = useState<'month' | 'year'>('month')
  const [month, setMonth] = useState(() =>
    Number(today.slice(0, 4)) === year ? Number(today.slice(5, 7)) - 1 : 0,
  )
  const [picked, setPicked] = useState<string | null>(null)
  const byDay = useMemo(() => new Map(days.map((day) => [day.date, day.sessions])), [days])
  const count = (day: string) => byDay.get(day)?.length ?? 0

  function moveMonth(by: number) {
    const next = shiftMonth(year, month, by)
    setMonth(next.month)
    if (next.year !== year) onYear(next.year)
  }

  const cell = (day: string | null, index: number, compact: boolean) =>
    day === null ? (
      <span key={`blank-${index}`} className={'cal-day blank' + (compact ? ' compact' : '')} />
    ) : (
      <DayCell
        key={day}
        day={day}
        count={count(day)}
        selected={picked === day}
        isToday={day === today}
        compact={compact}
        onPick={setPicked}
      />
    )

  const pickedSessions = picked === null ? [] : (byDay.get(picked) ?? [])
  return (
    <section className="pillars-page journal-page" aria-label="Calendar">
      <header className="pillars-head">
        <div>
          <div className="s-eyebrow">Calendar</div>
          <h1 className="board-title">
            {mode === 'month' ? `${MONTHS[month]} ${year}` : String(year)}
          </h1>
        </div>
        <div className="calendar-controls">
          <button
            type="button"
            className="btn ghost"
            aria-label={mode === 'month' ? 'Previous month' : 'Previous year'}
            onClick={() => (mode === 'month' ? moveMonth(-1) : onYear(year - 1))}
          >
            ‹
          </button>
          <button
            type="button"
            className="btn ghost"
            aria-label={mode === 'month' ? 'Next month' : 'Next year'}
            onClick={() => (mode === 'month' ? moveMonth(1) : onYear(year + 1))}
          >
            ›
          </button>
          <div className="segmented" role="group" aria-label="Calendar view">
            {(['month', 'year'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={'segment' + (mode === option ? ' active' : '')}
                aria-pressed={mode === option}
                onClick={() => setMode(option)}
              >
                {option === 'month' ? 'Month' : 'Year'}
              </button>
            ))}
          </div>
        </div>
      </header>

      {mode === 'month' ? (
        <div className="cal-month" role="grid" aria-label={`${MONTHS[month]} ${year}`}>
          {WEEKDAYS.map((name) => (
            <span key={name} className="cal-weekday" role="columnheader">
              {name}
            </span>
          ))}
          {monthGrid(year, month)
            .flat()
            .map((day, index) => cell(day, index, false))}
        </div>
      ) : (
        <div className="cal-year" aria-label={`Year ${year}`} data-testid="year-view">
          {MONTHS.map((name, index) => (
            <div key={name} className="cal-year-month">
              <button
                type="button"
                className="cal-year-name"
                onClick={() => {
                  setMonth(index)
                  setMode('month')
                }}
              >
                {name.slice(0, 3)}
              </button>
              <div className="cal-mini">
                {monthGrid(year, index)
                  .flat()
                  .map((day, cellIndex) => cell(day, cellIndex, true))}
              </div>
            </div>
          ))}
        </div>
      )}

      {picked !== null && (
        <section className="cal-picked" aria-label={`Sessions on ${dayName(picked)}`}>
          <div className="s-eyebrow">{dayName(picked)}</div>
          {pickedSessions.length === 0 ? (
            <p className="bible-muted">No sessions on this day.</p>
          ) : (
            <ul className="journal-list">
              {pickedSessions.map((session) => (
                <li key={session.path}>
                  <button
                    type="button"
                    className="bible-link-button"
                    onClick={() => onOpen(session.path)}
                  >
                    {session.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  )
}

/** Today, for pages that open on the current month: a YYYY-MM-DD of the local day. */
export function localToday(): string {
  const now = new Date()
  return dayKey(now.getFullYear(), now.getMonth(), now.getDate())
}

const STATUS_GROUPS = [
  { status: 'to watch', label: 'To watch' },
  { status: 'in progress', label: 'In progress' },
  { status: 'done', label: 'Done' },
] as const

/** Resources grouped by status, with their topics; links open after a confirm. */
export function ResourcesPage({
  items,
  onOpen,
  onExternal,
  onAdd,
}: {
  items: readonly ResourceItemData[]
  onOpen: (path: string) => void
  onExternal: (url: string) => void
  onAdd: () => void
}) {
  const known = new Set<string>(STATUS_GROUPS.map((group) => group.status))
  const groups = [
    ...STATUS_GROUPS.map((group) => ({
      ...group,
      items: items.filter((item) => item.status === group.status),
    })),
    {
      status: 'other',
      label: 'No status',
      items: items.filter((item) => item.status === null || !known.has(item.status)),
    },
  ].filter((group) => group.items.length > 0 || group.status !== 'other')

  return (
    <section className="pillars-page journal-page" aria-label="Resources">
      <header className="pillars-head">
        <div>
          <div className="s-eyebrow">Resources</div>
          <h1 className="board-title">Resources</h1>
          <p className="bible-muted">Tutorials, courses, books and talks to learn from.</p>
        </div>
        <button type="button" className="btn" onClick={onAdd}>
          <PlusIcon size={12} /> New resource
        </button>
      </header>
      <div className="resource-groups">
        {groups.map((group) => (
          <section key={group.status} className="resource-group" aria-label={group.label}>
            <h2 className="s-eyebrow">
              {group.label} <span className="board-count">{group.items.length}</span>
            </h2>
            {group.items.length === 0 ? (
              <p className="bible-muted">Nothing here.</p>
            ) : (
              <ul className="resource-list">
                {group.items.map((item) => (
                  <li key={item.path} className="resource-item" data-path={item.path}>
                    <button
                      type="button"
                      className="pillar-title"
                      onClick={() => onOpen(item.path)}
                    >
                      {item.title}
                    </button>
                    {item.rating && <span className="bible-muted">{item.rating}/5</span>}
                    <span className="timeline-pillars">
                      {item.topics.map((topic) => (
                        <button
                          key={topic.path}
                          type="button"
                          className="chip chip-link"
                          onClick={() => onOpen(topic.path)}
                        >
                          {topic.title}
                        </button>
                      ))}
                    </span>
                    {item.url && /^https?:\/\//i.test(item.url) && (
                      <button
                        type="button"
                        className="bible-link-button resource-url"
                        title={item.url}
                        onClick={() => onExternal(item.url ?? '')}
                      >
                        {item.url}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </section>
  )
}
