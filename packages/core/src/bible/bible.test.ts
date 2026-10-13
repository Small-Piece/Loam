import { describe, expect, it } from 'vitest'
import {
  joinEntryFile,
  parseEntry,
  readFields,
  setFields,
  splitEntryFile,
  yamlList,
  yamlString,
} from './frontMatter.ts'
import { findWikiLinks, linkTargets, rewriteLinks } from './links.ts'
import { slugify, titleKey, uniqueName } from './slug.ts'
import { parseVaultConfig, serializeVaultConfig, VaultError } from './vaultConfig.ts'

describe('slugify', () => {
  it('lower-cases and dashes titles, keeping letters of any script', () => {
    expect(slugify('Wonder before danger')).toBe('wonder-before-danger')
    expect(slugify("  The Ashfall's Edge!  ")).toBe('the-ashfalls-edge')
    expect(slugify('심연의 가장자리')).toBe('심연의-가장자리')
    expect(slugify('Café: déjà vu')).toBe('café-déjà-vu')
  })

  it('never makes a name Windows refuses', () => {
    expect(slugify('CON')).toBe('con-entry')
    expect(slugify('a<b>c:d"e/f\\g|h?i*j')).toBe('a-b-c-d-e-f-g-h-i-j')
    expect(slugify('???')).toBe('untitled')
    expect(Array.from(slugify('x'.repeat(300)))).toHaveLength(80)
  })

  it('numbers taken names', () => {
    const taken = new Set(['a.md', 'a-2.md'])
    expect(uniqueName('a', '.md', (name) => taken.has(name))).toBe('a-3.md')
    expect(uniqueName('b', '.md', (name) => taken.has(name))).toBe('b.md')
  })

  it('matches titles ignoring case and spacing', () => {
    expect(titleKey('  The   Ashfall ')).toBe('the ashfall')
  })
})

describe('entry files', () => {
  const file = [
    '---',
    'id: k3v9q2m8x1ad',
    'title: Wonder before danger',
    '# a comment the app must keep',
    'mood:',
    '  primary: awe',
    '  secondary: [dread, curiosity]',
    'tags:',
    '  - tone',
    '  - zone-1',
    'order: 2',
    'created: 2026-10-13T09:00:00.000Z',
    'updated: 2026-10-13T09:00:00.000Z',
    'pillar_weight: 0.8',
    '---',
    '# Wonder',
    '',
    'See [[The Ashfall]].',
    '',
  ].join('\n')

  it('splits and joins back to the exact bytes', () => {
    const parts = splitEntryFile(file)
    expect(parts.body).toBe('# Wonder\n\nSee [[The Ashfall]].\n')
    expect(joinEntryFile(parts)).toBe(file)
    const crlf = file.replaceAll('\n', '\r\n')
    expect(splitEntryFile(crlf).eol).toBe('\r\n')
    expect(joinEntryFile(splitEntryFile(crlf))).toBe(crlf)
  })

  it('treats a file without front matter, or with an unclosed fence, as all body', () => {
    expect(splitEntryFile('# Just text\n')).toMatchObject({ head: '', body: '# Just text\n' })
    expect(splitEntryFile('---\ntitle: x\nno end\n')).toMatchObject({ head: '' })
  })

  it('reads the known fields and leaves dates as text', () => {
    const entry = parseEntry(file, 'fallback')
    expect(entry).toMatchObject({
      id: 'k3v9q2m8x1ad',
      title: 'Wonder before danger',
      tags: ['tone', 'zone-1'],
      order: 2,
      created: '2026-10-13T09:00:00.000Z',
      links: ['the ashfall'],
    })
    expect(parseEntry('no front matter', 'From name').title).toBe('From name')
    expect(readFields('not: [valid')).toEqual({})
  })

  it('changes known keys in place and keeps every other line byte for byte', () => {
    const parts = splitEntryFile(file)
    const changed = setFields(
      parts.frontMatter,
      [
        ['title', yamlString('Awe first')],
        ['tags', yamlList(['tone'])],
        ['updated', '2026-10-14T10:00:00.000Z'],
      ],
      parts.eol,
    )
    expect(changed).toBe(
      [
        'id: k3v9q2m8x1ad',
        'title: Awe first',
        '# a comment the app must keep',
        'mood:',
        '  primary: awe',
        '  secondary: [dread, curiosity]',
        'tags: [tone]',
        'order: 2',
        'created: 2026-10-13T09:00:00.000Z',
        'updated: 2026-10-14T10:00:00.000Z',
        'pillar_weight: 0.8',
        '',
      ].join('\n'),
    )
  })

  it('adds missing keys at the end, with the file line ending', () => {
    expect(setFields('title: a\r\n', [['id', 'x1']], '\r\n')).toBe('title: a\r\nid: x1\r\n')
    expect(setFields('', [['id', 'x1']], '\n')).toBe('id: x1\n')
  })

  it('quotes strings only when a plain scalar would read back differently', () => {
    expect(yamlString('Wonder before danger')).toBe('Wonder before danger')
    expect(yamlString('true')).toBe('"true"')
    expect(yamlString('12')).toBe('"12"')
    expect(yamlString('a: b')).toBe('"a: b"')
    expect(yamlString('심연')).toBe('심연')
    for (const value of ['true', '12', 'a: b', "it's", '- x', '"q"', 'x #y', '']) {
      expect(readFields(`v: ${yamlString(value)}\n`)['v']).toBe(value)
    }
  })
})

describe('wiki links', () => {
  it('finds links with headings and shown text, skipping code', () => {
    const text = [
      'See [[The Ashfall]] and [[Zone 2#Forest|the forest]].',
      'Inline `[[Not a link]]` code.',
      '```',
      '[[Also not]]',
      '```',
      '[[ Spaced  Title ]]',
    ].join('\n')
    expect(findWikiLinks(text).map((link) => [link.target, link.heading, link.alias])).toEqual([
      ['The Ashfall', null, null],
      ['Zone 2', 'Forest', 'the forest'],
      ['Spaced  Title', null, null],
    ])
    expect(linkTargets(text)).toEqual(['the ashfall', 'zone 2', 'spaced title'])
  })

  it('rewrites links to a renamed title, keeping heading and shown text', () => {
    const text =
      'A [[the ashfall]], B [[The Ashfall#Edge|edge]], C [[Ashfallal]], D `[[The Ashfall]]`.'
    const result = rewriteLinks(text, 'The Ashfall', 'The Pit')
    expect(result).toEqual({
      text: 'A [[The Pit]], B [[The Pit#Edge|edge]], C [[Ashfallal]], D `[[The Ashfall]]`.',
      count: 2,
    })
  })
})

describe('bible.json', () => {
  it('keeps unknown keys and drops bad sections', () => {
    const config = parseVaultConfig(
      JSON.stringify({
        format: 1,
        title: 'Ashfall',
        kit: 'blank',
        sections: [
          { id: 'pillars', name: 'Pillars' },
          { id: '../x', name: 'Bad' },
          { id: '.trash', name: 'Trash' },
          { id: 'pillars', name: 'Again' },
        ],
        theme: { accent: 'teal' },
      }),
    )
    expect(config.sections).toEqual([{ id: 'pillars', name: 'Pillars', fields: [], extra: {} }])
    expect(JSON.parse(serializeVaultConfig(config))).toEqual({
      format: 1,
      title: 'Ashfall',
      kit: 'blank',
      sections: [{ id: 'pillars', name: 'Pillars' }],
      theme: { accent: 'teal' },
    })
  })

  it('refuses a newer format it cannot read', () => {
    expect(() => parseVaultConfig('{"format": 99, "sections": []}')).toThrow(VaultError)
    expect(() => parseVaultConfig('nope')).toThrow(VaultError)
  })
})
