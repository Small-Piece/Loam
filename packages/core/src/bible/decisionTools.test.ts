import { describe, expect, it } from 'vitest'
import { assetFileName, assetLinkFrom, resolveVaultLink } from './assets.ts'
import {
  byDecisionDate,
  fieldRefs,
  isStale,
  kindDefaults,
  sectionFields,
  servesNoPillar,
} from './decisions.ts'
import { formatFieldInput, readFieldValue, type FieldDef } from './fields.ts'
import { applyKitUpdate, kitFingerprint, kitUpdate } from './kitUpdates.ts'
import type { StarterKit, VaultConfig } from './types.ts'

describe('kind fields', () => {
  it('give decisions and ideas their built-in fields before declared ones', () => {
    const declared: FieldDef[] = [
      { key: 'cost', label: 'Cost', type: 'number' },
      { key: 'status', label: 'Mine', type: 'text' },
    ]
    expect(sectionFields('decisions', declared).map((field) => field.key)).toEqual([
      'date',
      'status',
      'pillars',
      'alternatives',
      'cost',
    ])
    expect(sectionFields('ideas', []).map((field) => [field.key, field.builtIn])).toEqual([
      ['status', true],
      ['pillars', true],
    ])
    expect(sectionFields('world', declared)).toEqual(declared)
    expect(kindDefaults('decisions', '2026-10-13')).toEqual({
      date: '2026-10-13',
      status: 'decided',
    })
    expect(kindDefaults('ideas', '2026-10-13')).toEqual({ status: 'parked' })
  })

  it('reads and writes the list type used by alternatives', () => {
    const list: FieldDef = { key: 'alternatives', label: 'Alternatives', type: 'list' }
    expect(readFieldValue(list, ['Stairs', 'Rope'], () => null).value).toEqual(['Stairs', 'Rope'])
    expect(readFieldValue(list, 'Stairs only', () => null).value).toEqual(['Stairs only'])
    expect(formatFieldInput(list, [' Stairs ', '', 'Rope: long'], () => true)).toBe(
      '[Stairs, "Rope: long"]',
    )
    expect(formatFieldInput(list, [], () => true)).toBe('[]')
  })

  it('collects field references and knows when no pillar is named', () => {
    const fields = sectionFields('decisions', [])
    expect(
      fieldRefs(fields, {
        pillars: ['p1', '[[Awe]]', ''],
        promoted_from: 'i9',
        alternatives: ['x'],
      }),
    ).toEqual([
      { key: 'pillars', target: 'p1' },
      { key: 'pillars', target: 'Awe' },
      { key: 'promoted_from', target: 'i9' },
    ])
    expect(servesNoPillar({ pillars: [] })).toBe(true)
    expect(servesNoPillar({})).toBe(true)
    expect(servesNoPillar({ pillars: ['p1'] })).toBe(false)
    expect(servesNoPillar({ pillars: 'p1' })).toBe(false)
  })
})

describe('staleness', () => {
  const now = new Date('2026-12-31T00:00:00.000Z')
  it('marks entries not updated for 60 days when a linked decision changed since', () => {
    expect(isStale('2026-10-01T00:00:00.000Z', ['2026-11-01T00:00:00.000Z'], now)).toBe(true)
    // Updated recently: fine.
    expect(isStale('2026-12-01T00:00:00.000Z', ['2026-12-20T00:00:00.000Z'], now)).toBe(false)
    // Old, but the decisions are older still.
    expect(isStale('2026-10-01T00:00:00.000Z', ['2026-09-01T00:00:00.000Z'], now)).toBe(false)
    expect(isStale('2026-10-01T00:00:00.000Z', [], now)).toBe(false)
    expect(isStale(null, ['2026-11-01T00:00:00.000Z'], now)).toBe(false)
  })

  it('orders decisions newest first', () => {
    const items = [
      { date: '2026-10-01', created: 'b', title: 'Old' },
      { date: null, created: 'z', title: 'Undated' },
      { date: '2026-10-12', created: 'a', title: 'New' },
    ]
    expect([...items].sort(byDecisionDate).map((item) => item.title)).toEqual([
      'New',
      'Old',
      'Undated',
    ])
  })
})

describe('kit updates', () => {
  const kit: StarterKit = {
    id: 'atmospheric-horror',
    name: 'Atmospheric / horror',
    description: '',
    role: 'bible',
    sections: [
      {
        id: 'world',
        name: 'World',
        template: '',
        fields: [{ key: 'depth', label: 'Depth', type: 'number' }],
      },
      {
        id: 'creatures',
        name: 'Creatures',
        template: '',
        fields: [
          { key: 'threat', label: 'Threat', type: 'select', options: ['deadly'] },
          { key: 'habitat', label: 'Habitat', type: 'entry', section: 'world' },
        ],
      },
      { id: 'atmosphere', name: 'Atmosphere', template: '', fields: [] },
    ],
  }
  const config: VaultConfig = {
    format: 1,
    title: 'Dream',
    kit: 'atmospheric-horror',
    sections: [
      {
        id: 'creatures',
        name: 'Monsters',
        fields: [{ key: 'habitat', label: 'Lives in', type: 'text' }],
        extra: { color: 'red' },
      },
      { id: 'world', name: 'World', fields: [], extra: {} },
    ],
    extra: {},
  }

  it('offers only what the vault lacks, by section id and field key', () => {
    expect(kitUpdate(kit, config)).toEqual({
      sections: [{ id: 'atmosphere', name: 'Atmosphere', fields: [] }],
      fields: [
        {
          section: 'world',
          sectionName: 'World',
          field: { key: 'depth', label: 'Depth', type: 'number' },
        },
        {
          section: 'creatures',
          sectionName: 'Monsters',
          field: { key: 'threat', label: 'Threat', type: 'select', options: ['deadly'] },
        },
      ],
    })
  })

  it('adds the chosen parts and never removes, renames or reorders', () => {
    const next = applyKitUpdate(config, kitUpdate(kit, config), {
      sections: [],
      fields: [{ section: 'creatures', key: 'threat' }],
    })
    expect(
      next.sections.map((section) => [section.id, section.name, section.fields.map((f) => f.key)]),
    ).toEqual([
      ['creatures', 'Monsters', ['habitat', 'threat']],
      ['world', 'World', []],
    ])
    expect(next.sections[0]?.extra).toEqual({ color: 'red' })
    expect(next.sections[0]?.fields[0]).toEqual({ key: 'habitat', label: 'Lives in', type: 'text' })
  })

  it('fingerprints change with the kit', () => {
    const changed = {
      ...kit,
      sections: [...kit.sections, { id: 'story', name: 'Story', template: '', fields: [] }],
    }
    expect(kitFingerprint(kit)).toMatch(/^[0-9a-f]{8}$/)
    expect(kitFingerprint(changed)).not.toBe(kitFingerprint(kit))
    expect(kitFingerprint({ ...kit, description: 'other' })).toBe(kitFingerprint(kit))
  })
})

describe('vault assets and links', () => {
  it('names assets by hash and type, and links to them relative to the entry', () => {
    const hash = 'a'.repeat(64)
    expect(assetFileName(hash, 'image/webp')).toBe(`${hash}.webp`)
    expect(assetFileName(hash, 'image/jpeg')).toBe(`${hash}.jpg`)
    expect(assetFileName(hash, 'text/html')).toBeNull()
    expect(assetLinkFrom('creatures/thing.md', `_assets/${hash}.webp`)).toBe(
      `../_assets/${hash}.webp`,
    )
  })

  it('resolves links inside the vault and refuses everything else', () => {
    expect(resolveVaultLink('creatures/thing.md', '../_assets/a.webp')).toBe('_assets/a.webp')
    expect(resolveVaultLink('creatures/thing.md', 'sketch%201.png')).toBe('creatures/sketch 1.png')
    expect(resolveVaultLink('creatures/thing.md', '/_assets/a.webp')).toBe('_assets/a.webp')
    expect(resolveVaultLink('creatures/thing.md', '../../outside.png')).toBeNull()
    expect(resolveVaultLink('creatures/thing.md', 'https://x.test/a.png')).toBeNull()
    expect(resolveVaultLink('creatures/thing.md', '//x.test/a.png')).toBeNull()
    expect(resolveVaultLink('creatures/thing.md', 'file:///C:/a.png')).toBeNull()
    expect(resolveVaultLink('creatures/thing.md', '..\\..\\a.png')).toBeNull()
  })
})
