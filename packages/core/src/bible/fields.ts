import { yamlList, yamlString } from './frontMatter.ts'
import { slugify } from './slug.ts'

/** Property types a section can declare for its entries. */
export const FIELD_TYPES = [
  'text',
  'number',
  'select',
  'multi-select',
  'entry',
  'entries',
  'date',
  'checkbox',
  'list',
] as const
export type FieldType = (typeof FIELD_TYPES)[number]

/** One property of a section's entries, as declared in bible.json or a kit.json. */
export interface FieldDef {
  /** Front-matter key the value is stored under. */
  key: string
  label: string
  type: FieldType
  /** Choices for select and multi-select. */
  options?: string[]
  /** For entry and entries: only entries of this section may be picked. */
  section?: string
  /** Set on the fields the app gives a section kind (decisions, ideas); not editable. */
  builtIn?: boolean
}

/** Keys the app manages itself; a field cannot use them. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'id',
  'title',
  'tags',
  'order',
  'created',
  'updated',
])

const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/
const MAX_FIELDS = 50
const MAX_OPTIONS = 100
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

export type FieldValue = string | number | boolean | string[] | null

/** Types whose value is a list (empty: []). */
export function isListType(type: FieldType): boolean {
  return type === 'multi-select' || type === 'entries' || type === 'list'
}

export function isFieldKey(key: string): boolean {
  return FIELD_KEY.test(key) && !RESERVED_KEYS.has(key)
}

function cleanOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const option = item.trim()
    if (option === '' || option.length > 100 || seen.has(option)) continue
    seen.add(option)
    out.push(option)
  }
  return out.slice(0, MAX_OPTIONS)
}

/**
 * Field definitions from bible.json or kit.json. Malformed ones are skipped
 * (the file itself is left as it is); keys are unique.
 */
export function parseFieldDefs(raw: unknown): FieldDef[] {
  if (!Array.isArray(raw)) return []
  const fields: FieldDef[] = []
  const keys = new Set<string>()
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const { key, label, type, options, section } = item as Record<string, unknown>
    if (typeof key !== 'string' || !isFieldKey(key) || keys.has(key)) continue
    if (typeof type !== 'string' || !(FIELD_TYPES as readonly string[]).includes(type)) continue
    const field: FieldDef = {
      key,
      label: typeof label === 'string' && label.trim() ? label.trim() : key,
      type: type as FieldType,
    }
    if (field.type === 'select' || field.type === 'multi-select')
      field.options = cleanOptions(options)
    if (
      (field.type === 'entry' || field.type === 'entries') &&
      typeof section === 'string' &&
      section
    ) {
      field.section = section
    }
    keys.add(key)
    fields.push(field)
    if (fields.length >= MAX_FIELDS) break
  }
  return fields
}

/** The definition as written to bible.json: only the keys its type uses. */
export function serializeFieldDef(field: FieldDef): Record<string, unknown> {
  const out: Record<string, unknown> = { key: field.key, label: field.label, type: field.type }
  if (field.type === 'select' || field.type === 'multi-select') out['options'] = field.options ?? []
  if ((field.type === 'entry' || field.type === 'entries') && field.section)
    out['section'] = field.section
  return out
}

/** A front-matter key for a new field, from its label, that no other field uses. */
export function fieldKeyFromLabel(label: string, taken: ReadonlySet<string>): string {
  let base = slugify(label)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 36)
  if (!/^[a-z]/.test(base)) base = `field_${base}`.replace(/_+$/, '')
  // Keys allow underscores, not dashes: threat, threat_2, threat_3...
  for (let index = 1; ; index++) {
    const candidate = index === 1 ? base : `${base}_${index}`
    if (!taken.has(candidate) && !RESERVED_KEYS.has(candidate)) return candidate
  }
}

export function isValidDate(text: string): boolean {
  const match = DATE.exec(text)
  if (!match) return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.toISOString().slice(0, 10) === text
}

/** An entry a field points at, as the index knows it. */
export interface EntryRef {
  id: string
  path: string
  title: string
  section: string
}

/** One value of an entry or entries field, resolved for display. */
export interface ResolvedRef {
  value: string
  path: string | null
  title: string | null
}

/** A field value read from front matter, with what to show and whether it looks wrong. */
export interface ReadField {
  value: FieldValue
  refs: ResolvedRef[]
  /** Set when the stored value does not fit the field; the value is kept in the file. */
  warning: string | null
  /** The stored value as text, shown next to a warning. */
  raw: string | null
}

function describe(raw: unknown): string {
  return typeof raw === 'string' ? raw : JSON.stringify(raw)
}

/** "[[Title]]" or "Title" typed by hand, or an id. */
export function refKey(value: string): string {
  const link = /^\[\[([^[\]|#]+)(?:[#|][^[\]]*)?\]\]$/.exec(value.trim())
  return (link?.[1] ?? value).trim()
}

/**
 * Reads one field's front-matter value. Values that do not fit the type are
 * reported, never dropped: the file stays as it is until the user changes the field.
 */
export function readFieldValue(
  field: FieldDef,
  raw: unknown,
  resolve: (idOrTitle: string) => EntryRef | null,
): ReadField {
  const ok = (value: FieldValue, refs: ResolvedRef[] = []): ReadField => ({
    value,
    refs,
    warning: null,
    raw: null,
  })
  const bad = (warning: string): ReadField => ({
    value: null,
    refs: [],
    warning,
    raw: describe(raw),
  })
  if (raw === undefined || raw === null || raw === '') {
    return ok(isListType(field.type) ? [] : null)
  }
  const options = field.options ?? []
  switch (field.type) {
    case 'text':
      if (typeof raw === 'string') return ok(raw)
      if (typeof raw === 'number' || typeof raw === 'boolean') return ok(String(raw))
      return bad('Expected text')
    case 'number': {
      const number = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
      return Number.isFinite(number) && raw !== '' ? ok(number) : bad('Expected a number')
    }
    case 'select': {
      if (typeof raw !== 'string' && typeof raw !== 'number') return bad('Expected one choice')
      const value = String(raw)
      const result = ok(value)
      if (!options.includes(value)) result.warning = `"${value}" is not one of the choices`
      return result
    }
    case 'multi-select': {
      const list = Array.isArray(raw) ? raw : [raw]
      if (!list.every((item) => typeof item === 'string' || typeof item === 'number')) {
        return bad('Expected a list of choices')
      }
      const values = list.map(String)
      const result = ok(values)
      const unknown = values.filter((value) => !options.includes(value))
      if (unknown.length > 0) result.warning = `Not among the choices: ${unknown.join(', ')}`
      return result
    }
    case 'entry':
    case 'entries': {
      const list = field.type === 'entries' ? (Array.isArray(raw) ? raw : [raw]) : [raw]
      if (field.type === 'entry' && Array.isArray(raw)) return bad('Expected one entry')
      if (!list.every((item) => typeof item === 'string'))
        return bad('Expected entry ids or titles')
      const refs: ResolvedRef[] = []
      const problems: string[] = []
      for (const item of list as string[]) {
        const target = resolve(refKey(item))
        refs.push({ value: item, path: target?.path ?? null, title: target?.title ?? null })
        if (!target) problems.push(`no entry "${refKey(item)}"`)
        else if (field.section && target.section !== field.section) {
          problems.push(`"${target.title}" is not in ${field.section}`)
        }
      }
      const result = ok(field.type === 'entry' ? (list[0] as string) : (list as string[]), refs)
      if (problems.length > 0) result.warning = problems.join('; ')
      return result
    }
    case 'date': {
      const text = typeof raw === 'string' ? raw : null
      return text !== null && isValidDate(text) ? ok(text) : bad('Expected a date (YYYY-MM-DD)')
    }
    case 'checkbox':
      return typeof raw === 'boolean' ? ok(raw) : bad('Expected true or false')
    case 'list': {
      const list = Array.isArray(raw) ? raw : [raw]
      if (!list.every((item) => typeof item === 'string' || typeof item === 'number')) {
        return bad('Expected a list of short texts')
      }
      return ok(list.map(String))
    }
  }
}

/**
 * Checks a value coming from the Properties panel and turns it into the YAML
 * written after "key:" ('' writes an empty value). Throws a message on a bad value.
 */
export function formatFieldInput(
  field: FieldDef,
  value: FieldValue,
  entryExists: (id: string, section: string | undefined) => boolean,
): string {
  const empty = value === null || value === '' || (Array.isArray(value) && value.length === 0)
  if (empty) {
    if (isListType(field.type)) return '[]'
    return field.type === 'checkbox' ? 'false' : ''
  }
  const options = field.options ?? []
  const fail = (message: string): never => {
    throw new Error(`${field.label}: ${message}`)
  }
  switch (field.type) {
    case 'text':
      if (typeof value !== 'string') fail('expected text')
      if ((value as string).length > 10_000) fail('too long')
      return yamlString(value as string)
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('expected a number')
      return String(value)
    case 'select':
      if (typeof value !== 'string' || !options.includes(value)) fail('not one of the choices')
      return yamlString(value as string)
    case 'multi-select':
      if (!Array.isArray(value) || !value.every((item) => options.includes(item))) {
        fail('not among the choices')
      }
      return yamlList(value as string[])
    case 'entry':
      if (typeof value !== 'string' || !entryExists(value, field.section)) fail('no such entry')
      return yamlString(value as string)
    case 'entries':
      if (!Array.isArray(value) || !value.every((id) => entryExists(id, field.section))) {
        fail('no such entry')
      }
      return yamlList(value as string[])
    case 'date':
      if (typeof value !== 'string' || !isValidDate(value)) fail('expected a date (YYYY-MM-DD)')
      return value as string
    case 'checkbox':
      if (typeof value !== 'boolean') fail('expected true or false')
      return value ? 'true' : 'false'
    case 'list': {
      if (!Array.isArray(value)) fail('expected a list')
      const items = (value as string[]).map((item) => item.trim()).filter((item) => item !== '')
      if (items.length > 50 || items.some((item) => item.length > 200)) fail('too many or too long')
      return yamlList(items)
    }
  }
}

/** The empty value a new entry gets for each of its section's fields. */
export function emptyFieldYaml(field: FieldDef): string {
  if (isListType(field.type)) return '[]'
  return field.type === 'checkbox' ? 'false' : ''
}

/** Tags from the Properties panel: trimmed, unique, at most 30 of up to 100 characters. */
export function cleanTags(tags: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const tag of tags) {
    const clean = tag.trim().replace(/\s+/g, ' ')
    if (clean === '' || clean.length > 100 || seen.has(clean.toLowerCase())) continue
    seen.add(clean.toLowerCase())
    out.push(clean)
  }
  return out.slice(0, 30)
}
