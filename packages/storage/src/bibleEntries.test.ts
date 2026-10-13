import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BibleService, type VaultWatcher } from '@loam/core'
import { SqliteBibleIndex } from './bibleIndex.ts'
import { openDatabase } from './database.ts'
import { FolderStarterKits } from './starterKits.ts'
import { NodeVaultFiles } from './vaultFiles.ts'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const migrationsDir = join(repo, 'migrations')
const kitsDir = join(repo, 'starter-kits')

const quietWatcher: VaultWatcher = {
  watch: async () => async () => undefined,
}

let dir: string
let db: ReturnType<typeof openDatabase>['db']
let ids: number
let clockMs: number
let service: BibleService

function makeService() {
  return new BibleService({
    files: new NodeVaultFiles(),
    index: new SqliteBibleIndex(db),
    watcher: quietWatcher,
    kits: new FolderStarterKits(kitsDir),
    clock: { now: () => new Date(clockMs), monotonicMs: () => performance.now() },
    newId: () => `id${String(++ids).padStart(10, '0')}`,
    onChanged: () => undefined,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'loam-bible5b-'))
  db = openDatabase({ filePath: join(dir, 'app.db'), migrationsDir }).db
  ids = 0
  clockMs = Date.parse('2026-10-13T09:00:00.000Z')
  service = makeService()
})

afterEach(async () => {
  await service.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const root = () => join(dir, 'Game', 'bible')
const read = (rel: string) => readFileSync(join(root(), ...rel.split('/')), 'utf8')
const write = (rel: string, text: string) => {
  mkdirSync(join(root(), ...rel.split('/').slice(0, -1)), { recursive: true })
  writeFileSync(join(root(), ...rel.split('/')), text)
}
const sha = (rel: string) =>
  createHash('sha256')
    .update(readFileSync(join(root(), ...rel.split('/'))))
    .digest('hex')

async function newVault(kit = 'atmospheric-horror') {
  mkdirSync(join(dir, 'Game'), { recursive: true })
  return (await service.create(join(dir, 'Game'), kit, 'Dream')).vault.id
}

function titles(vaultId: number, section: string) {
  return service
    .view(vaultId)
    .sections.find((candidate) => candidate.id === section)
    ?.entries.map((entry) => entry.title)
}

describe('new entries', () => {
  it("get their section's fields, empty, from the kit", async () => {
    const id = await newVault()
    const { entry } = await service.createEntry(id, 'creatures', 'Orbed Piercer', null)
    expect(read(entry.path)).toContain('\nthreat:\nhabitat:\n---\n')
    expect(
      entry.properties.map((property) => [property.key, property.type, property.value]),
    ).toEqual([
      ['threat', 'select', null],
      ['habitat', 'entry', null],
    ])
    const config = JSON.parse(read('bible.json')) as {
      sections: Array<{ id: string; fields?: unknown[] }>
    }
    expect(config.sections.find((section) => section.id === 'creatures')?.fields).toHaveLength(2)
    expect(config.sections.find((section) => section.id === 'pillars')?.fields).toBeUndefined()
  })

  it('first pillar: short title, Pillar template, the answer under the first heading', async () => {
    const id = await newVault()
    const answer = 'Wonder of the world, but the player feels awe and despair.'
    const { entry } = await service.createEntry(id, 'pillars', 'Awe and despair', null, answer)
    expect(entry.title).toBe('Awe and despair')
    expect(entry.body).toBe(
      `## What players should feel\n\n${answer}\n\n## What this looks like in play\n\n## What this rules out\n`,
    )
    expect(service.pillars(id)).toEqual([
      {
        path: 'pillars/awe-and-despair.md',
        title: 'Awe and despair',
        feeling: answer,
        inPlay: '',
        rulesOut: '',
        decisions: 0,
        ideas: 0,
      },
    ])
  })

  it('opening an existing vault never rewrites its entries', async () => {
    const id = await newVault()
    write('pillars/old.md', '---\ntitle: Old\n---\nNo template, no fields.\n')
    write('creatures/hand.md', 'no front matter at all\n')
    await service.close()
    const before = [sha('pillars/old.md'), sha('creatures/hand.md')]
    service = makeService()
    await service.open(root())
    service.getEntry(id, 'creatures/hand.md')
    service.pillars(id)
    expect([sha('pillars/old.md'), sha('creatures/hand.md')]).toEqual(before)
  })
})

describe('properties', () => {
  it('every field type round-trips through setProperties and through hand edits', async () => {
    const id = await newVault('blank')
    await service.setSectionFields(id, 'ideas', [
      { key: null, label: 'Note', type: 'text' },
      { key: null, label: 'Cost', type: 'number' },
      { key: null, label: 'Size', type: 'select', options: ['small', 'big'] },
      { key: null, label: 'Mood', type: 'multi-select', options: ['eerie', 'calm'] },
      { key: null, label: 'Serves', type: 'entry', section: 'pillars' },
      { key: null, label: 'Related', type: 'entries' },
      { key: null, label: 'Since', type: 'date' },
      { key: null, label: 'Approved', type: 'checkbox' },
    ])
    const pillar = (await service.createEntry(id, 'pillars', 'Awe', '')).entry
    const created = (await service.createEntry(id, 'ideas', 'Rope', 'Body stays.\n')).entry
    const values = {
      note: 'Swing: like "Spider-Man"',
      cost: 3.5,
      size: 'big',
      mood: ['eerie'],
      serves: pillar.id,
      related: [pillar.id],
      since: '2026-10-13',
      approved: true,
    }
    const saved = await service.setProperties(
      id,
      created.path,
      [
        ...Object.entries(values).map(([key, value]) => ({ key, value })),
        { key: 'tags', value: ['tone', 'tone ', 'climb'] },
      ],
      created.version,
    )
    if (saved.status !== 'saved') throw new Error('conflict')
    // Ideas also has its built-in status and pillars (Slice 5c); compare the declared fields.
    const declared = saved.entry.properties.filter((p) => !p.builtIn)
    expect(Object.fromEntries(declared.map((p) => [p.key, p.value]))).toEqual(values)
    expect(saved.entry.properties.every((p) => p.warning === null)).toBe(true)
    expect(saved.entry.tags).toEqual(['tone', 'climb'])
    expect(saved.entry.body).toBe('Body stays.\n')
    expect(saved.entry.properties.find((p) => p.key === 'serves')?.refs[0]?.title).toBe('Awe')

    // Edited by hand in another editor: block lists, a title instead of an id, quotes.
    const text = read(created.path)
      .replace(/^mood: .*$/m, 'mood:\n  - calm\n  - eerie')
      .replace(/^serves: .*$/m, 'serves: "[[Awe]]"')
      .replace(/^cost: .*$/m, "cost: '7'")
    write(created.path, text)
    const reread = service.getEntry(id, created.path)
    expect(Object.fromEntries(reread.properties.map((p) => [p.key, p.value]))).toMatchObject({
      mood: ['calm', 'eerie'],
      serves: '[[Awe]]',
      cost: 7,
    })
    expect(reread.properties.every((p) => p.warning === null)).toBe(true)
  })

  it('shows invalid hand-typed values with a warning and keeps them in the file', async () => {
    const id = await newVault()
    const { entry } = await service.createEntry(id, 'creatures', 'Thing', '')
    write(entry.path, read(entry.path).replace('threat:\n', 'threat: apocalyptic\n'))
    const reread = service.getEntry(id, entry.path)
    expect(reread.properties.find((p) => p.key === 'threat')).toMatchObject({
      value: 'apocalyptic',
      warning: '"apocalyptic" is not one of the choices',
    })
    // Changing another property leaves the odd value alone.
    const habitat = (await service.createEntry(id, 'world', 'The Ashfall', '')).entry
    const saved = await service.setProperties(
      id,
      entry.path,
      [{ key: 'habitat', value: habitat.id }],
      reread.version,
    )
    expect(saved.status).toBe('saved')
    expect(read(entry.path)).toContain('threat: apocalyptic\n')
    await expect(
      service.setProperties(
        id,
        entry.path,
        [{ key: 'threat', value: 'apocalyptic' }],
        service.getEntry(id, entry.path).version,
      ),
    ).rejects.toThrow(/not one of the choices/)
  })

  it('a property save refuses a file changed on disk', async () => {
    const id = await newVault()
    const { entry } = await service.createEntry(id, 'creatures', 'Thing', '')
    write(entry.path, read(entry.path) + 'theirs\n')
    const result = await service.setProperties(
      id,
      entry.path,
      [{ key: 'threat', value: 'deadly' }],
      entry.version,
    )
    expect(result.status).toBe('conflict')
  })

  it('removing a field definition leaves its values in the files', async () => {
    const id = await newVault()
    const { entry } = await service.createEntry(id, 'creatures', 'Thing', '')
    await service.setProperties(id, entry.path, [{ key: 'threat', value: 'deadly' }], entry.version)
    const before = read(entry.path)
    const view = await service.setSectionFields(id, 'creatures', [
      { key: 'habitat', label: 'Lives in', type: 'entry', section: 'world' },
    ])
    expect(
      view.sections.find((s) => s.id === 'creatures')?.fields.map((f) => [f.key, f.label]),
    ).toEqual([['habitat', 'Lives in']])
    expect(read(entry.path)).toBe(before)
    expect(service.getEntry(id, entry.path).properties.map((p) => p.key)).toEqual(['habitat'])
    // Adding it back shows the value again.
    await service.setSectionFields(id, 'creatures', [
      { key: 'threat', label: 'Threat', type: 'select', options: ['harmless', 'deadly'] },
      { key: 'habitat', label: 'Lives in', type: 'entry', section: 'world' },
    ])
    expect(service.getEntry(id, entry.path).properties[0]?.value).toBe('deadly')
    await expect(
      service.setSectionFields(id, 'creatures', [{ key: 'title', label: 'x', type: 'text' }]),
    ).rejects.toThrow()
    await expect(
      service.setSectionFields(id, 'creatures', [
        { key: null, label: 'Kind', type: 'select', options: [] },
      ]),
    ).rejects.toThrow(/at least one choice/)
  })

  it('renaming or reordering sections keeps their fields', async () => {
    const id = await newVault()
    const sections = service
      .view(id)
      .sections.map(({ id: sectionId, name }) => ({ id: sectionId as string | null, name }))
    await service.setSections(
      id,
      [...sections].reverse().map((s) => (s.id === 'creatures' ? { ...s, name: 'Monsters' } : s)),
    )
    const config = JSON.parse(read('bible.json')) as {
      sections: Array<{ id: string; name: string; fields?: unknown[] }>
    }
    expect(config.sections.find((s) => s.id === 'creatures')).toMatchObject({ name: 'Monsters' })
    expect(config.sections.find((s) => s.id === 'creatures')?.fields).toHaveLength(2)
  })

  it('collects vault tags for autocomplete', async () => {
    const id = await newVault()
    const a = (await service.createEntry(id, 'world', 'A', '')).entry
    const b = (await service.createEntry(id, 'world', 'B', '')).entry
    await service.setProperties(
      id,
      a.path,
      [{ key: 'tags', value: ['zone 1', 'curse'] }],
      a.version,
    )
    await service.setProperties(id, b.path, [{ key: 'tags', value: ['curse'] }], b.version)
    expect(service.vaultTags(id)).toEqual(['curse', 'zone 1'])
  })
})

describe('entry actions', () => {
  it('duplicates with a new id, the same body and fields, as "<title> copy"', async () => {
    const id = await newVault()
    const { entry } = await service.createEntry(id, 'creatures', 'Orbed Piercer', 'Fast.\n')
    await service.setProperties(id, entry.path, [{ key: 'threat', value: 'deadly' }], entry.version)
    write(entry.path, read(entry.path).replace('---\nFast', 'custom: kept\n---\nFast'))
    const copy = (await service.duplicateEntry(id, entry.path)).entry
    expect(copy).toMatchObject({
      title: 'Orbed Piercer copy',
      path: 'creatures/orbed-piercer-copy.md',
      body: 'Fast.\n',
    })
    expect(copy.id).not.toBe(entry.id)
    expect(copy.properties[0]?.value).toBe('deadly')
    expect(read(copy.path)).toContain('custom: kept\n')
    expect((await service.duplicateEntry(id, entry.path)).entry.title).toBe('Orbed Piercer copy 2')
  })

  it('moves an entry to another section; links and entry fields still resolve', async () => {
    const id = await newVault()
    const ashfall = (await service.createEntry(id, 'creatures', 'The Ashfall', 'A pit.\n')).entry
    const thing = (
      await service.createEntry(id, 'creatures', 'Thing', 'Lives in [[The Ashfall]].\n')
    ).entry
    // Habitat only accepts World entries, so it cannot point at the Ashfall yet.
    await expect(
      service.setProperties(id, thing.path, [{ key: 'habitat', value: ashfall.id }], thing.version),
    ).rejects.toThrow(/no such entry/)
    const moved = await service.moveEntry(id, ashfall.path, 'world')
    expect(moved.path).toBe('world/the-ashfall.md')
    expect(existsSync(join(root(), 'creatures', 'the-ashfall.md'))).toBe(false)
    expect(titles(id, 'world')).toEqual(['The Ashfall'])
    const after = service.getEntry(id, moved.path)
    expect(after.id).toBe(ashfall.id)
    expect(after.backlinks.map((link) => link.title)).toEqual(['Thing'])
    // An entry field can now point at it (habitat is limited to World).
    const current = service.getEntry(id, thing.path)
    const saved = await service.setProperties(
      id,
      thing.path,
      [{ key: 'habitat', value: ashfall.id }],
      current.version,
    )
    if (saved.status !== 'saved') throw new Error('conflict')
    expect(saved.entry.properties.find((p) => p.key === 'habitat')?.refs[0]?.path).toBe(
      'world/the-ashfall.md',
    )
  })

  it('reorders by changing only the moved entry, or renumbers when there is no room', async () => {
    const id = await newVault('blank')
    for (const title of ['A', 'B', 'C', 'D']) await service.createEntry(id, 'ideas', title, '')
    const paths = () =>
      service
        .view(id)
        .sections.find((s) => s.id === 'ideas')!
        .entries.map((e) => e.path)
    const hashes = () => paths().map((path) => sha(path))
    const before = Object.fromEntries(paths().map((path) => [path, sha(path)]))
    // Move D between A and B: only D's file changes (order 1.5).
    await service.reorderEntries(
      id,
      'ideas',
      ['ideas/a.md', 'ideas/d.md', 'ideas/b.md', 'ideas/c.md'],
      'ideas/d.md',
    )
    expect(titles(id, 'ideas')).toEqual(['A', 'D', 'B', 'C'])
    expect(read('ideas/d.md')).toContain('order: 1.5\n')
    for (const path of ['ideas/a.md', 'ideas/b.md', 'ideas/c.md'])
      expect(sha(path)).toBe(before[path])
    // To the top and to the bottom.
    await service.reorderEntries(
      id,
      'ideas',
      ['ideas/c.md', 'ideas/a.md', 'ideas/d.md', 'ideas/b.md'],
      'ideas/c.md',
    )
    expect(titles(id, 'ideas')).toEqual(['C', 'A', 'D', 'B'])
    await service.reorderEntries(
      id,
      'ideas',
      ['ideas/a.md', 'ideas/d.md', 'ideas/b.md', 'ideas/c.md'],
      'ideas/c.md',
    )
    expect(titles(id, 'ideas')).toEqual(['A', 'D', 'B', 'C'])
    // Entries without an order are numbered 1, 2, 3...
    write('ideas/e.md', '---\ntitle: E\n---\n')
    await service.close()
    service = makeService()
    await service.open(root())
    expect(titles(id, 'ideas')).toEqual(['A', 'D', 'B', 'C', 'E'])
    await service.reorderEntries(
      id,
      'ideas',
      ['ideas/e.md', 'ideas/a.md', 'ideas/d.md', 'ideas/b.md', 'ideas/c.md'],
      'ideas/e.md',
    )
    expect(titles(id, 'ideas')).toEqual(['E', 'A', 'D', 'B', 'C'])
    expect(hashes()).toHaveLength(5)
    await expect(service.reorderEntries(id, 'ideas', ['ideas/a.md'], 'ideas/a.md')).rejects.toThrow(
      /changed meanwhile/,
    )
  })
})

describe('the trash', () => {
  it('lists entries and sections with where they came from and when; restores both', async () => {
    const id = await newVault()
    const thing = (await service.createEntry(id, 'creatures', 'Thing', 'x\n')).entry
    await service.setProperties(id, thing.path, [{ key: 'threat', value: 'deadly' }], thing.version)
    await service.createEntry(id, 'atmosphere', 'Fog', '')
    clockMs += 60_000
    await service.deleteEntry(id, thing.path)
    clockMs += 60_000
    await service.removeSection(id, 'atmosphere')
    // Something deleted by hand, with no record.
    write('.trash/world/by-hand.md', '---\ntitle: By hand\n---\n')

    const trash = service.listTrash(id)
    expect(trash).toEqual([
      {
        trashPath: '.trash/_sections/atmosphere',
        kind: 'section',
        name: 'Atmosphere',
        from: 'atmosphere',
        sectionName: null,
        deletedAt: '2026-10-13T09:02:00.000Z',
        entryCount: 1,
      },
      {
        trashPath: '.trash/creatures/thing.md',
        kind: 'entry',
        name: 'Thing',
        from: 'creatures/thing.md',
        sectionName: 'Creatures',
        deletedAt: '2026-10-13T09:01:00.000Z',
        entryCount: 0,
      },
      {
        trashPath: '.trash/world/by-hand.md',
        kind: 'entry',
        name: 'By hand',
        from: 'world/by-hand.md',
        sectionName: 'World',
        deletedAt: null,
        entryCount: 0,
      },
    ])

    const entry = await service.restoreFromTrash(id, '.trash/creatures/thing.md')
    expect(entry.path).toBe('creatures/thing.md')
    expect(service.getEntry(id, 'creatures/thing.md').properties[0]?.value).toBe('deadly')
    await service.restoreFromTrash(id, '.trash/_sections/atmosphere')
    const config = JSON.parse(read('bible.json')) as {
      sections: Array<{ id: string; fields?: unknown[] }>
    }
    expect(config.sections.map((s) => s.id)).toEqual([
      'pillars',
      'atmosphere',
      'world',
      'creatures',
      'story',
      'decisions',
      'ideas',
    ])
    expect(config.sections.find((s) => s.id === 'atmosphere')?.fields).toHaveLength(1)
    expect(titles(id, 'atmosphere')).toEqual(['Fog'])
    expect(service.listTrash(id).map((item) => item.trashPath)).toEqual(['.trash/world/by-hand.md'])
  })

  it('deletes permanently, a file or a whole section folder', async () => {
    const id = await newVault()
    const a = (await service.createEntry(id, 'world', 'A', '')).entry
    await service.deleteEntry(id, a.path)
    await service.createEntry(id, 'story', 'Beat', '')
    await service.removeSection(id, 'story')
    let left = await service.purgeFromTrash(id, '.trash/world/a.md')
    expect(existsSync(join(root(), '.trash', 'world', 'a.md'))).toBe(false)
    left = await service.purgeFromTrash(id, '.trash/_sections/story')
    expect(existsSync(join(root(), '.trash', '_sections', 'story'))).toBe(false)
    expect(left).toEqual([])
    const log = JSON.parse(read('.trash/index.json')) as { items: unknown[] }
    expect(log.items).toEqual([])
    await expect(service.purgeFromTrash(id, '.trash/../bible.json')).rejects.toThrow(
      /no longer in .trash/,
    )
  })

  it('finds sections removed by the first version of the app, which sit directly in .trash', async () => {
    const id = await newVault()
    write('.trash/music/theme.md', '---\ntitle: Theme\n---\n')
    const trash = service.listTrash(id)
    expect(trash).toMatchObject([
      { trashPath: '.trash/music', kind: 'section', name: 'music', entryCount: 1 },
    ])
    await service.restoreFromTrash(id, '.trash/music')
    expect(titles(id, 'music')).toEqual(['Theme'])
    expect(readdirSync(join(root(), '.trash'))).not.toContain('music')
  })

  it('Undo still restores an entry and a section, and clears their records', async () => {
    const id = await newVault()
    const a = (await service.createEntry(id, 'world', 'A', '')).entry
    const deleted = await service.deleteEntry(id, a.path)
    await service.restoreEntry(id, deleted.trashPath, a.path)
    const removed = await service.removeSection(id, 'creatures')
    await service.restoreSection(id, removed.trashPath, removed.section, removed.position)
    const config = JSON.parse(read('bible.json')) as {
      sections: Array<{ id: string; fields?: unknown[] }>
    }
    expect(config.sections.find((s) => s.id === 'creatures')?.fields).toHaveLength(2)
    expect(service.listTrash(id)).toEqual([])
  })
})
