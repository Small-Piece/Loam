import { parseFieldDefs, serializeFieldDef, type FieldDef } from './fields.ts'

/** Whole sections go here inside .trash; no section id can start with "_". */
export const SECTIONS_TRASH = '_sections'
/** What the app records about each deleted item, inside .trash. */
export const TRASH_LOG = 'index.json'

export interface TrashRecord {
  trashPath: string
  kind: 'entry' | 'section'
  /** Entry path, or section id. */
  from: string
  name: string
  deletedAt: string
  /** For a section: what is needed to put it back as it was. */
  section?: { id: string; name: string; fields: FieldDef[]; extra: Record<string, unknown> }
  position?: number
}

function readRecord(value: unknown): TrashRecord | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const { trashPath, kind, from, name, deletedAt } = raw
  if (typeof trashPath !== 'string' || (kind !== 'entry' && kind !== 'section')) return null
  if (typeof from !== 'string' || typeof name !== 'string' || typeof deletedAt !== 'string') {
    return null
  }
  const record: TrashRecord = { trashPath, kind, from, name, deletedAt }
  const section = raw['section'] as Record<string, unknown> | undefined
  if (section && typeof section['id'] === 'string' && typeof section['name'] === 'string') {
    const extra = section['extra']
    record.section = {
      id: section['id'],
      name: section['name'],
      fields: parseFieldDefs(section['fields']),
      extra:
        extra !== null && typeof extra === 'object' && !Array.isArray(extra)
          ? (extra as Record<string, unknown>)
          : {},
    }
  }
  if (typeof raw['position'] === 'number') record.position = raw['position']
  return record
}

/** The trash log; a missing or damaged one reads as empty, never as an error. */
export function parseTrashLog(text: string | null): TrashRecord[] {
  if (text === null) return []
  try {
    const raw = JSON.parse(text) as { items?: unknown }
    return Array.isArray(raw.items)
      ? raw.items.map(readRecord).filter((item): item is TrashRecord => item !== null)
      : []
  } catch {
    return []
  }
}

export function serializeTrashLog(records: readonly TrashRecord[]): string {
  const items = records.map((record) => ({
    ...record,
    ...(record.section
      ? { section: { ...record.section, fields: record.section.fields.map(serializeFieldDef) } }
      : {}),
  }))
  return `${JSON.stringify({ format: 1, items }, null, 2)}\n`
}

/** The name a trashed file or folder had before a "~<time>" suffix was added. */
export function withoutTrashSuffix(name: string): string {
  return name.replace(/~\d+(?=\.md$|$)/, '')
}
