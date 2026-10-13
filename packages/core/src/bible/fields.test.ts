import { describe, expect, it } from 'vitest'
import {
  cleanTags,
  fieldKeyFromLabel,
  formatFieldInput,
  isValidDate,
  parseFieldDefs,
  readFieldValue,
  serializeFieldDef,
  type EntryRef,
  type FieldDef,
} from './fields.ts'
import { readFields, setFields } from './frontMatter.ts'
import { fillFirstHeading, pillarParts } from './pillars.ts'
import { parseTrashLog, serializeTrashLog, withoutTrashSuffix } from './trash.ts'

const entries: EntryRef[] = [
  { id: 'world0000001', path: 'world/the-ashfall.md', title: 'The Ashfall', section: 'world' },
  { id: 'story0000001', path: 'story/descent.md', title: 'Descent', section: 'story' },
]
const resolve = (key: string) =>
  entries.find((entry) => entry.id === key || entry.title.toLowerCase() === key.toLowerCase()) ??
  null
const exists = (id: string, section: string | undefined) =>
  entries.some((entry) => entry.id === id && (!section || entry.section === section))

const defs: FieldDef[] = [
  { key: 'note', label: 'Note', type: 'text' },
  { key: 'depth', label: 'Depth', type: 'number' },
  { key: 'threat', label: 'Threat', type: 'select', options: ['low', 'high'] },
  { key: 'mood', label: 'Mood', type: 'multi-select', options: ['eerie', 'calm'] },
  { key: 'habitat', label: 'Habitat', type: 'entry', section: 'world' },
  { key: 'appears', label: 'Appears in', type: 'entries' },
  { key: 'seen', label: 'First seen', type: 'date' },
  { key: 'boss', label: 'Boss', type: 'checkbox' },
]
const field = (key: string) => defs.find((def) => def.key === key) as FieldDef

describe('field definitions', () => {
  it('reads valid definitions, skips bad ones and keeps keys unique', () => {
    expect(
      parseFieldDefs([
        { key: 'threat', label: 'Threat', type: 'select', options: ['low', 'low', ' high ', 3] },
        { key: 'habitat', label: 'Habitat', type: 'entry', section: 'world' },
        { key: 'threat', label: 'Again', type: 'text' },
        { key: 'title', label: 'Reserved', type: 'text' },
        { key: 'Bad Key', label: 'x', type: 'text' },
        { key: 'kind', label: 'x', type: 'formula' },
        'nonsense',
      ]),
    ).toEqual([
      { key: 'threat', label: 'Threat', type: 'select', options: ['low', 'high'] },
      { key: 'habitat', label: 'Habitat', type: 'entry', section: 'world' },
    ])
  })

  it('writes only the keys a type uses', () => {
    expect(serializeFieldDef({ key: 'note', label: 'Note', type: 'text', options: ['x'] })).toEqual(
      {
        key: 'note',
        label: 'Note',
        type: 'text',
      },
    )
  })

  it('makes front-matter keys from labels', () => {
    expect(fieldKeyFromLabel('First appears', new Set())).toBe('first_appears')
    expect(fieldKeyFromLabel('Threat', new Set(['threat']))).toBe('threat_2')
    expect(fieldKeyFromLabel('Threat', new Set(['threat', 'threat_2']))).toBe('threat_3')
    expect(fieldKeyFromLabel('Tags', new Set())).toBe('tags_2')
    expect(fieldKeyFromLabel('2nd act', new Set())).toMatch(/^field_2nd_act$/)
  })
})

describe('reading values', () => {
  const read = (key: string, raw: unknown) => readFieldValue(field(key), raw, resolve)

  it('reads every type', () => {
    expect(read('note', 'Lurks below').value).toBe('Lurks below')
    expect(read('depth', 1200).value).toBe(1200)
    expect(read('threat', 'high')).toMatchObject({ value: 'high', warning: null })
    expect(read('mood', ['eerie', 'calm']).value).toEqual(['eerie', 'calm'])
    expect(read('habitat', 'world0000001').refs).toEqual([
      { value: 'world0000001', path: 'world/the-ashfall.md', title: 'The Ashfall' },
    ])
    expect(read('appears', ['story0000001']).refs[0]?.title).toBe('Descent')
    expect(read('seen', '2026-10-13').value).toBe('2026-10-13')
    expect(read('boss', true).value).toBe(true)
  })

  it('reads values typed by hand in another editor', () => {
    expect(read('note', 42).value).toBe('42')
    expect(read('depth', '30').value).toBe(30)
    expect(read('mood', 'eerie').value).toEqual(['eerie'])
    expect(read('habitat', '[[The Ashfall]]')).toMatchObject({ warning: null })
    expect(read('habitat', 'the ashfall').refs[0]?.path).toBe('world/the-ashfall.md')
  })

  it('warns about values that do not fit, without dropping them', () => {
    expect(read('depth', 'deep')).toMatchObject({
      value: null,
      warning: 'Expected a number',
      raw: 'deep',
    })
    expect(read('threat', 'extreme')).toMatchObject({
      value: 'extreme',
      warning: '"extreme" is not one of the choices',
    })
    expect(read('mood', ['eerie', 'loud']).warning).toBe('Not among the choices: loud')
    expect(read('habitat', 'Nowhere').warning).toBe('no entry "Nowhere"')
    expect(read('habitat', 'story0000001').warning).toBe('"Descent" is not in world')
    expect(read('seen', '2026-02-30')).toMatchObject({ value: null, raw: '2026-02-30' })
    expect(read('boss', 'yes')).toMatchObject({ warning: 'Expected true or false', raw: 'yes' })
    expect(read('note', { a: 1 })).toMatchObject({ warning: 'Expected text', raw: '{"a":1}' })
  })

  it('treats missing and empty values as empty, with no warning', () => {
    expect(read('depth', undefined)).toMatchObject({ value: null, warning: null })
    expect(read('mood', null)).toMatchObject({ value: [], warning: null })
    expect(read('note', '')).toMatchObject({ value: null, warning: null })
  })
})

describe('writing values', () => {
  const write = (key: string, value: Parameters<typeof formatFieldInput>[1]) =>
    formatFieldInput(field(key), value, exists)

  it('formats each type as YAML that reads back the same', () => {
    const cases: Array<[string, Parameters<typeof formatFieldInput>[1]]> = [
      ['note', 'It: watches, "always"'],
      ['depth', -350.5],
      ['threat', 'high'],
      ['mood', ['eerie', 'calm']],
      ['habitat', 'world0000001'],
      ['appears', ['story0000001', 'world0000001']],
      ['seen', '2026-10-13'],
      ['boss', true],
    ]
    for (const [key, value] of cases) {
      const yaml = write(key, value)
      const back = readFields(setFields('', [[key, yaml]], '\n'))[key]
      expect(readFieldValue(field(key), back, resolve).value).toEqual(value)
    }
  })

  it('writes empty values plainly', () => {
    expect(write('note', null)).toBe('')
    expect(write('mood', [])).toBe('[]')
    expect(write('boss', null)).toBe('false')
    expect(setFields('note: x\n', [['note', '']], '\n')).toBe('note:\n')
  })

  it('refuses values that do not fit', () => {
    expect(() => write('threat', 'extreme')).toThrow(/Threat: not one of the choices/)
    expect(() => write('depth', 'deep')).toThrow(/expected a number/)
    expect(() => write('habitat', 'story0000001')).toThrow(/no such entry/)
    expect(() => write('seen', '13/10/2026')).toThrow(/date/)
    expect(() => write('boss', 'yes')).toThrow(/true or false/)
  })

  it('validates dates and cleans tags', () => {
    expect(isValidDate('2028-02-29')).toBe(true)
    expect(isValidDate('2026-02-29')).toBe(false)
    expect(cleanTags([' tone ', 'Tone', '', 'zone  1'])).toEqual(['tone', 'zone 1'])
  })
})

describe('pillars', () => {
  const template =
    '## What players should feel\n\n## What this looks like in play\n\n## What this rules out\n'

  it('puts the first-run answer under the first heading', () => {
    expect(fillFirstHeading(template, 'Awe at a beautiful, deadly world.')).toBe(
      '## What players should feel\n\nAwe at a beautiful, deadly world.\n\n## What this looks like in play\n\n## What this rules out\n',
    )
    expect(fillFirstHeading('', 'Just this.')).toBe('Just this.\n')
  })

  it('reads the card parts by heading, or the whole text without headings', () => {
    const body = fillFirstHeading(template, 'Awe.').replace(
      '## What this rules out\n',
      '## What this rules out\n\nJump scares.\n',
    )
    expect(pillarParts(body)).toEqual({ feeling: 'Awe.', inPlay: '', rulesOut: 'Jump scares.' })
    expect(pillarParts('Wonder of the world but the player feels awe\n')).toEqual({
      feeling: 'Wonder of the world but the player feels awe',
      inPlay: '',
      rulesOut: '',
    })
  })
})

describe('trash log', () => {
  it('round-trips records and reads a damaged log as empty', () => {
    const records = [
      {
        trashPath: '.trash/_sections/creatures',
        kind: 'section' as const,
        from: 'creatures',
        name: 'Creatures',
        deletedAt: '2026-10-13T09:00:00.000Z',
        section: {
          id: 'creatures',
          name: 'Creatures',
          fields: [{ key: 'threat', label: 'Threat', type: 'select' as const, options: ['low'] }],
          extra: { color: 'red' },
        },
        position: 3,
      },
    ]
    expect(parseTrashLog(serializeTrashLog(records))).toEqual(records)
    expect(parseTrashLog('{oops')).toEqual([])
    expect(parseTrashLog(null)).toEqual([])
    expect(withoutTrashSuffix('rope~1760000000000.md')).toBe('rope.md')
    expect(withoutTrashSuffix('ideas~1760000000000')).toBe('ideas')
  })
})
