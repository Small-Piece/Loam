/**
 * The study journal: a vault made from the Journal kit. These are the rules
 * on top of the vault machinery: what a session's day is, which session came
 * before today, the "Next time" notes, and sessions per calendar day.
 */

export const JOURNAL_KIT = 'journal'
export const SESSIONS = 'sessions'
export const TOPICS = 'topics'
export const RESOURCES = 'resources'
export const TOPICS_KEY = 'topics'
export const MINUTES_KEY = 'minutes'
export const URL_KEY = 'url'
export const RATING_KEY = 'rating'
export const RESOURCE_STATUSES = ['to watch', 'in progress', 'done'] as const
/** Front matter of a recap saved from an AI draft. */
export const AI_GENERATED_KEY = 'ai_generated'
export const SOURCE_SESSIONS_KEY = 'source_sessions'
/** "This week" for a recap: today and the six days before it. */
export const RECAP_WEEK_DAYS = 7

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const LEADING_DAY = /^(\d{4}-\d{2}-\d{2})(?:\s|$)/

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** The calendar day of a moment where the user is (the machine's time zone), as YYYY-MM-DD. */
export function localDate(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/** True for a real calendar day written YYYY-MM-DD. */
export function isDay(text: string): boolean {
  const match = DAY.exec(text)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

/**
 * Front-matter values (YAML) a new journal entry starts with: a session is
 * dated today, a topic is active and started today, a resource is to watch.
 */
export function journalDefaults(sectionId: string, today: string): Record<string, string> {
  if (sectionId === SESSIONS) return { date: today }
  if (sectionId === TOPICS) return { status: 'active', started: today }
  if (sectionId === RESOURCES) return { status: 'to watch' }
  return {}
}

/**
 * A session's day: its date field, else a date the title starts with, else
 * the local day it was created on. Null when none of these is a day.
 */
export function sessionDay(
  fields: Record<string, unknown>,
  title: string,
  created: string | null,
): string | null {
  const raw = fields['date']
  const field = raw instanceof Date ? localDate(raw) : typeof raw === 'string' ? raw.trim() : ''
  if (isDay(field)) return field
  const fromTitle = LEADING_DAY.exec(title.trim())?.[1]
  if (fromTitle && isDay(fromTitle)) return fromTitle
  if (created) {
    const at = new Date(created)
    if (!Number.isNaN(at.getTime())) return localDate(at)
  }
  return null
}

export interface DatedSession {
  path: string
  title: string
  /** The session's day, YYYY-MM-DD; null when it has none. */
  date: string | null
  created: string | null
}

/** Oldest first: by day, then by when it was created, then by title. */
function chronological(a: DatedSession, b: DatedSession): number {
  return (
    (a.date ?? '').localeCompare(b.date ?? '') ||
    (a.created ?? '').localeCompare(b.created ?? '') ||
    a.title.localeCompare(b.title)
  )
}

/**
 * Today's sessions (oldest first) and the previous session: the latest one
 * on a day before today, whose "Next time" is where today starts.
 */
export function todayAndPrevious(
  sessions: readonly DatedSession[],
  today: string,
): { today: DatedSession[]; previous: DatedSession | null } {
  const sorted = [...sessions].sort(chronological)
  const todays = sorted.filter((session) => session.date === today)
  const earlier = sorted.filter((session) => session.date !== null && session.date < today)
  return { today: todays, previous: earlier.at(-1) ?? null }
}

/**
 * The text under a heading (any level, matched without case), up to the next
 * heading of the same or a higher level. Null when there is no such heading
 * or it is empty. Headings inside code fences do not count.
 */
export function sectionText(body: string, heading: string): string | null {
  const wanted = heading.trim().toLowerCase()
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  let level = 0
  let fenced = false
  const taken: string[] = []
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const match = fenced ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (level === 0) {
      if (match && (match[2] ?? '').trim().toLowerCase() === wanted) level = match[1]?.length ?? 0
      continue
    }
    if (match && (match[1]?.length ?? 7) <= level) break
    taken.push(line)
  }
  const text = taken.join('\n').trim()
  return text === '' ? null : text
}

/** The text under a "Next time" heading; see sectionText. */
export function nextTimeSection(body: string): string | null {
  return sectionText(body, 'Next time')
}

/** The Session template's headings: what a recap is built from, and nothing else. */
export const RECAP_HEADINGS = [
  'What I practised',
  'What I learned',
  'What was hard',
  'Next time',
] as const

/**
 * A session's own words for a recap: only the text under the template's
 * headings, each kept under its heading. Null when all of them are empty.
 */
export function recapText(body: string): string | null {
  const parts: string[] = []
  for (const heading of RECAP_HEADINGS) {
    const text = sectionText(body, heading)
    if (text !== null) parts.push(`### ${heading}\n${text}`)
  }
  return parts.length === 0 ? null : parts.join('\n\n')
}

export interface CalendarDay {
  date: string
  sessions: Array<{ path: string; title: string }>
}

/** Days of one year that have sessions, in order, each with its sessions oldest first. */
export function calendarDays(sessions: readonly DatedSession[], year: number): CalendarDay[] {
  const prefix = `${year}-`
  const byDay = new Map<string, DatedSession[]>()
  for (const session of [...sessions].sort(chronological)) {
    if (session.date === null || !session.date.startsWith(prefix)) continue
    const list = byDay.get(session.date) ?? []
    list.push(session)
    byDay.set(session.date, list)
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => ({
      date,
      sessions: list.map(({ path, title }) => ({ path, title })),
    }))
}

/** A new session's title: today's date, or "<date> 2", "<date> 3"... when that is taken. */
export function sessionTitle(today: string, taken: (title: string) => boolean): string {
  for (let count = 1; ; count++) {
    const candidate = count === 1 ? today : `${today} ${count}`
    if (!taken(candidate)) return candidate
  }
}
