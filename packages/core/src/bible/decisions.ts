import { refKey, type FieldDef } from './fields.ts'

/** Section ids the decision tools work on. Every starter kit has them. */
export const PILLARS = 'pillars'
export const DECISIONS = 'decisions'
export const IDEAS = 'ideas'

/** Front-matter keys the decision tools use. Values that point at entries hold ids. */
export const PILLARS_KEY = 'pillars'
export const STATUS_KEY = 'status'
export const DATE_KEY = 'date'
export const PROMOTED_TO = 'promoted_to'
export const PROMOTED_FROM = 'promoted_from'

export const DECISION_STATUSES = ['decided', 'revisited', 'reversed'] as const
export const IDEA_STATUSES = ['parked', 'promoted', 'dropped'] as const

/** An entry not updated for this long may be out of date when decisions linked to it changed since. */
export const STALE_AFTER_DAYS = 60

const pillarsField: FieldDef = {
  key: PILLARS_KEY,
  label: 'Pillars',
  type: 'entries',
  section: PILLARS,
  builtIn: true,
}

/**
 * The fields a section of a known kind always has, whatever bible.json says:
 * decisions and ideas. They are not stored in bible.json and cannot be removed.
 */
export const KIND_FIELDS: Readonly<Record<string, readonly FieldDef[]>> = {
  [DECISIONS]: [
    { key: DATE_KEY, label: 'Date', type: 'date', builtIn: true },
    {
      key: STATUS_KEY,
      label: 'Status',
      type: 'select',
      options: [...DECISION_STATUSES],
      builtIn: true,
    },
    pillarsField,
    { key: 'alternatives', label: 'Alternatives', type: 'list', builtIn: true },
  ],
  [IDEAS]: [
    {
      key: STATUS_KEY,
      label: 'Status',
      type: 'select',
      options: [...IDEA_STATUSES],
      builtIn: true,
    },
    pillarsField,
  ],
}

/** A section's fields: its kind's built-in fields first, then the ones bible.json declares. */
export function sectionFields(sectionId: string, declared: readonly FieldDef[]): FieldDef[] {
  const kind = KIND_FIELDS[sectionId] ?? []
  const taken = new Set(kind.map((field) => field.key))
  return [...kind, ...declared.filter((field) => !taken.has(field.key))]
}

/** Values a new entry of a kind starts with (YAML), beyond its fields' empty values. */
export function kindDefaults(sectionId: string, today: string): Record<string, string> {
  if (sectionId === DECISIONS) return { [DATE_KEY]: today, [STATUS_KEY]: 'decided' }
  if (sectionId === IDEAS) return { [STATUS_KEY]: 'parked' }
  return {}
}

/** Every entry an entry's fields point at, as stored (an id, or a title typed by hand). */
export function fieldRefs(
  fields: readonly FieldDef[],
  values: Record<string, unknown>,
): Array<{ key: string; target: string }> {
  const refs: Array<{ key: string; target: string }> = []
  for (const field of fields) {
    if (field.type !== 'entry' && field.type !== 'entries') continue
    const raw = values[field.key]
    const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]
    for (const item of list) {
      if (typeof item === 'string' && item.trim() !== '') {
        refs.push({ key: field.key, target: refKey(item) })
      }
    }
  }
  for (const key of [PROMOTED_TO, PROMOTED_FROM]) {
    const raw = values[key]
    if (typeof raw === 'string' && raw.trim() !== '') refs.push({ key, target: refKey(raw) })
  }
  return refs
}

/** True when a decision or idea names no pillar: shown as "serves no pillar". */
export function servesNoPillar(values: Record<string, unknown>): boolean {
  const raw = values[PILLARS_KEY]
  if (Array.isArray(raw)) return !raw.some((item) => typeof item === 'string' && item.trim() !== '')
  return typeof raw !== 'string' || raw.trim() === ''
}

/**
 * "May be out of date": not updated for 60 days, while a decision that links
 * to it (by [[link]] or a field) was updated after it.
 */
export function isStale(
  updated: string | null,
  linkedDecisionUpdates: readonly (string | null)[],
  now: Date,
): boolean {
  if (updated === null) return false
  const time = Date.parse(updated)
  if (Number.isNaN(time)) return false
  if (now.getTime() - time < STALE_AFTER_DAYS * 24 * 60 * 60 * 1000) return false
  return linkedDecisionUpdates.some((other) => other !== null && Date.parse(other) > time)
}

/** Newest decision first: by its date, then by when it was created. */
export function byDecisionDate(
  a: { date: string | null; created: string | null; title: string },
  b: { date: string | null; created: string | null; title: string },
): number {
  return (
    (b.date ?? '').localeCompare(a.date ?? '') ||
    (b.created ?? '').localeCompare(a.created ?? '') ||
    a.title.localeCompare(b.title)
  )
}
