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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BibleService, VaultError, type VaultWatcher } from '@loam/core'
import { SqliteBibleIndex } from './bibleIndex.ts'
import { openDatabase } from './database.ts'
import { FolderStarterKits } from './starterKits.ts'
import { ChokidarVaultWatcher } from './vaultWatcher.ts'
import { NodeVaultFiles, TEMP_FILE } from './vaultFiles.ts'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const migrationsDir = join(repo, 'migrations')
const kitsDir = join(repo, 'starter-kits')

/** A watcher the test fires by hand. */
class ManualWatcher implements VaultWatcher {
  listener: ((paths: string[]) => void) | null = null
  async watch(_root: string, onChange: (paths: string[]) => void) {
    this.listener = onChange
    return async () => {
      this.listener = null
    }
  }
  fire(...paths: string[]) {
    this.listener?.(paths)
  }
}

let dir: string
let db: ReturnType<typeof openDatabase>['db']
let watcher: ManualWatcher
let changes: Array<{ vaultId: number; paths: string[] }>
let ids: number
let service: BibleService

function makeService(watch: VaultWatcher = watcher) {
  return new BibleService({
    files: new NodeVaultFiles(),
    index: new SqliteBibleIndex(db),
    watcher: watch,
    kits: new FolderStarterKits(kitsDir),
    clock: {
      now: () => new Date('2026-10-13T09:00:00.000Z'),
      monotonicMs: () => performance.now(),
    },
    newId: () => `id${String(++ids).padStart(4, '0')}`,
    onChanged: (event) => changes.push(event),
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'loam-bible-'))
  db = openDatabase({ filePath: join(dir, 'app.db'), migrationsDir }).db
  watcher = new ManualWatcher()
  changes = []
  ids = 0
  service = makeService()
})

afterEach(async () => {
  await service.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const game = () => join(dir, 'MyGame')
const vaultRoot = () => join(game(), 'bible')
const read = (rel: string) => readFileSync(join(vaultRoot(), ...rel.split('/')), 'utf8')
const write = (rel: string, text: string) => {
  mkdirSync(join(vaultRoot(), ...rel.split('/').slice(0, -1)), { recursive: true })
  writeFileSync(join(vaultRoot(), ...rel.split('/')), text)
}
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

async function newVault(kit = 'narrative-adventure') {
  mkdirSync(game(), { recursive: true })
  return service.create(game(), kit, 'Ashfall')
}

describe('creating a vault', () => {
  it('lays out bible.json, README.md and one folder per section for every kit', async () => {
    const kits = service.kits()
    expect(kits.map((kit) => kit.id)).toEqual([
      'blank',
      'narrative-adventure',
      'action-roguelike',
      'cozy-sim',
      'atmospheric-horror',
    ])
    for (const kit of kits) {
      const folder = join(dir, kit.id)
      mkdirSync(folder)
      const view = await service.create(folder, kit.id, `${kit.name} game`)
      const root = join(folder, 'bible')
      expect(view.vault.path).toBe(root)
      const config = JSON.parse(readFileSync(join(root, 'bible.json'), 'utf8'))
      expect(config).toEqual({
        format: 1,
        title: `${kit.name} game`,
        kit: kit.id,
        // Sections carry the kit's fields (Slice 5b) when it has any.
        sections: kit.sections.map(({ id, name, fields }) =>
          fields.length > 0 ? { id, name, fields } : { id, name },
        ),
      })
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('[[Title]]')
      for (const section of kit.sections) expect(existsSync(join(root, section.id))).toBe(true)
      for (const required of ['pillars', 'decisions', 'ideas']) {
        expect(kit.sections.map((section) => section.id)).toContain(required)
      }
      expect(readdirSync(root).sort()).toEqual(
        ['README.md', 'bible.json', ...kit.sections.map((section) => section.id)].sort(),
      )
    }
  })

  it('refuses a folder that already holds a bible or other files', async () => {
    await newVault()
    await expect(service.create(game(), 'blank', 'Again')).rejects.toThrow(/already has a bible/)
    mkdirSync(join(dir, 'Other', 'bible'), { recursive: true })
    writeFileSync(join(dir, 'Other', 'bible', 'notes.txt'), 'mine')
    await expect(service.create(join(dir, 'Other'), 'blank', 'X')).rejects.toThrow(/not empty/)
  })
})

describe('entries', () => {
  it('creates an entry from the section template with full front matter', async () => {
    const view = await newVault()
    const { entry } = await service.createEntry(view.vault.id, 'characters', 'Rowan', null)
    expect(entry.path).toBe('characters/rowan.md')
    expect(read('characters/rowan.md')).toBe(
      [
        '---',
        'id: id0001',
        'title: Rowan',
        'tags: []',
        'order: 1',
        'created: 2026-10-13T09:00:00.000Z',
        'updated: 2026-10-13T09:00:00.000Z',
        // The section's fields, empty (Slice 5b).
        'role:',
        'first_appears:',
        '---',
        readFileSync(join(kitsDir, 'narrative-adventure', 'templates', 'characters.md'), 'utf8'),
      ].join('\n'),
    )
    await service.createEntry(view.vault.id, 'characters', 'Reg', '')
    expect(
      service.view(view.vault.id).sections.find((s) => s.id === 'characters')?.entries,
    ).toEqual([
      { path: 'characters/rowan.md', title: 'Rowan', id: 'id0001', stale: false, noPillar: false },
      { path: 'characters/reg.md', title: 'Reg', id: 'id0002', stale: false, noPillar: false },
    ])
    await expect(service.createEntry(view.vault.id, 'world', 'rowan', '')).rejects.toThrow(
      /already exists/,
    )
  })

  it('saves the body only, keeping unknown front matter byte for byte', async () => {
    const view = await newVault()
    const original = [
      '---',
      'id: keep1',
      'title: Wonder',
      '# my comment',
      'mood: {primary: awe}',
      'updated: 2026-01-01T00:00:00.000Z',
      'custom: [a, b]',
      '---',
      'Old body',
      '',
    ].join('\r\n')
    write('pillars/wonder.md', original)
    watcher.fire('pillars/wonder.md')
    const entry = service.getEntry(view.vault.id, 'pillars/wonder.md')
    const saved = await service.saveEntry(
      view.vault.id,
      entry.path,
      'New body\r\n',
      entry.version,
      false,
    )
    expect(saved.status).toBe('saved')
    expect(read('pillars/wonder.md')).toBe(
      original
        .replace('Old body\r\n', 'New body\r\n')
        .replace('2026-01-01T00:00:00.000Z', '2026-10-13T09:00:00.000Z'),
    )
    // Saving the same body again writes nothing.
    const before = read('pillars/wonder.md')
    if (saved.status !== 'saved') throw new Error('not saved')
    await service.saveEntry(view.vault.id, entry.path, 'New body\r\n', saved.entry.version, false)
    expect(read('pillars/wonder.md')).toBe(before)
  })

  it('refuses to overwrite a file that changed on disk, unless forced', async () => {
    const view = await newVault()
    const { entry } = await service.createEntry(view.vault.id, 'pillars', 'Wonder', 'mine v1\n')
    const theirs = read(entry.path).replace('mine v1', 'theirs')
    write(entry.path, theirs)
    const result = await service.saveEntry(
      view.vault.id,
      entry.path,
      'mine v2\n',
      entry.version,
      false,
    )
    expect(result.status).toBe('conflict')
    if (result.status !== 'conflict') throw new Error('no conflict')
    expect(result.theirs.body).toBe('theirs\n')
    expect(read(entry.path)).toBe(theirs)
    const forced = await service.saveEntry(
      view.vault.id,
      entry.path,
      'mine v2\n',
      entry.version,
      true,
    )
    expect(forced.status).toBe('saved')
    expect(read(entry.path)).toContain('mine v2')
  })

  it('renaming rewrites every link to the entry and keeps backlinks right', async () => {
    const view = await newVault()
    const id = view.vault.id
    await service.createEntry(id, 'world', 'The Ashfall', 'A pit. See [[The Ashfall#Layers]].\n')
    await service.createEntry(id, 'characters', 'Rowan', 'Wants to reach [[the ashfall]].\n')
    await service.createEntry(
      id,
      'story',
      'Descent',
      'Into [[The Ashfall|the hole]], not `[[The Ashfall]]`.\n',
    )
    await service.createEntry(id, 'story', 'Unrelated', 'Nothing here.\n')
    expect(service.getEntry(id, 'world/the-ashfall.md').backlinks.map((b) => b.title)).toEqual([
      'Descent',
      'Rowan',
    ])

    const renamed = await service.renameEntry(id, 'world/the-ashfall.md', 'The Deep Quarry')
    expect(renamed.entry.path).toBe('world/the-deep-quarry.md')
    expect(renamed.rewritten).toBe(3)
    expect(existsSync(join(vaultRoot(), 'world', 'the-ashfall.md'))).toBe(false)
    expect(read('world/the-deep-quarry.md')).toContain('title: The Deep Quarry')
    expect(read('world/the-deep-quarry.md')).toContain('id: id0001')
    expect(read('world/the-deep-quarry.md')).toContain('See [[The Deep Quarry#Layers]].')
    expect(read('characters/rowan.md')).toContain('Wants to reach [[The Deep Quarry]].')
    expect(read('story/descent.md')).toContain(
      'Into [[The Deep Quarry|the hole]], not `[[The Ashfall]]`.',
    )
    expect(renamed.entry.backlinks.map((b) => b.title)).toEqual(['Descent', 'Rowan'])
    expect(service.view(id).lastEntry).toBe('world/the-deep-quarry.md')
    await expect(service.renameEntry(id, 'story/unrelated.md', 'rowan')).rejects.toThrow(
      /already exists/,
    )
  })

  it('deletes into .trash and restores, also when the name was taken meanwhile', async () => {
    const view = await newVault()
    const id = view.vault.id
    await service.createEntry(id, 'ideas', 'Rope physics', 'x\n')
    const deleted = await service.deleteEntry(id, 'ideas/rope-physics.md')
    expect(deleted.trashPath).toBe('.trash/ideas/rope-physics.md')
    expect(existsSync(join(vaultRoot(), '.trash', 'ideas', 'rope-physics.md'))).toBe(true)
    expect(deleted.vault.sections.find((s) => s.id === 'ideas')?.entries).toEqual([])
    expect(service.search(id, 'rope').hits).toEqual([])

    const back = await service.restoreEntry(id, deleted.trashPath, 'ideas/rope-physics.md')
    expect(back.path).toBe('ideas/rope-physics.md')
    expect(service.search(id, 'rope').hits.map((hit) => hit.path)).toEqual([
      'ideas/rope-physics.md',
    ])

    const again = await service.deleteEntry(id, 'ideas/rope-physics.md')
    write('ideas/rope-physics.md', '---\ntitle: Someone else\n---\n')
    watcher.fire('ideas/rope-physics.md')
    const second = await service.deleteEntry(id, 'ideas/rope-physics.md')
    expect(second.trashPath).toMatch(/^\.trash\/ideas\/rope-physics~\d+\.md$/)
    const restored = await service.restoreEntry(id, again.trashPath, 'ideas/rope-physics.md')
    expect(restored.path).toBe('ideas/rope-physics.md')
    await expect(service.restoreEntry(id, '../../evil.md', 'ideas/x.md')).rejects.toThrow(
      VaultError,
    )
  })

  it('rejects paths outside the vault', async () => {
    const view = await newVault()
    for (const path of [
      '../x.md',
      'pillars/../../x.md',
      'nope/x.md',
      'pillars/sub/x.md',
      'pillars/.x.md',
    ]) {
      expect(() => service.getEntry(view.vault.id, path)).toThrow(VaultError)
    }
  })
})

describe('the index', () => {
  async function richVault() {
    const view = await newVault()
    const id = view.vault.id
    await service.createEntry(id, 'pillars', 'Wonder before danger', 'Awe first. [[The Ashfall]]\n')
    await service.createEntry(id, 'world', 'The Ashfall', 'A vertical world of layers.\n')
    await service.createEntry(
      id,
      'characters',
      'Rowan',
      'Cave diver apprentice. [[The Ashfall]] [[Missing]]\n',
    )
    write('world/hand-made.md', 'No front matter, links to [[Rowan]].\n')
    return id
  }

  function snapshot(id: number) {
    return {
      view: service.view(id),
      search: ['ashfall', 'raider', 'front', 'layers'].map((text) => service.search(id, text).hits),
      backlinks: ['world/the-ashfall.md', 'characters/rowan.md'].map(
        (path) => service.getEntry(id, path).backlinks,
      ),
    }
  }

  it('rebuilds to identical search and link results after the index rows are deleted', async () => {
    const id = await richVault()
    await service.close()
    service = makeService()
    await service.open(vaultRoot())
    const before = snapshot(id)
    expect(before.view.sections.find((s) => s.id === 'world')?.entries.map((e) => e.title)).toEqual(
      ['The Ashfall', 'hand made'],
    )
    expect(before.backlinks[1]).toEqual([{ path: 'world/hand-made.md', title: 'hand made' }])

    await service.close()
    db.exec('DELETE FROM bible_fts; DELETE FROM bible_links; DELETE FROM bible_entries;')
    service = makeService()
    await service.open(vaultRoot())
    expect(snapshot(id)).toEqual(before)
    expect(service.rebuildIndex(id)).toEqual(before.view)
  })

  it('catches up with files changed while the app was closed', async () => {
    const id = await richVault()
    await service.close()
    write('characters/rowan.md', '---\ntitle: Rowan\n---\nNow a wayfinder collector.\n')
    rmSync(join(vaultRoot(), 'world', 'hand-made.md'))
    service = makeService()
    await service.open(vaultRoot())
    expect(service.search(id, 'wayfinder').hits.map((hit) => hit.path)).toEqual([
      'characters/rowan.md',
    ])
    expect(service.search(id, 'raider').hits).toEqual([])
    expect(service.view(id).sections.find((s) => s.id === 'world')?.entries).toHaveLength(1)
  })

  it('updates search and backlinks when the watcher reports an outside edit', async () => {
    const id = await richVault()
    write('world/the-ashfall.md', read('world/the-ashfall.md').replace('layers', 'strata'))
    write('story/new.md', '---\ntitle: New\n---\nGoes to [[The Ashfall]].\n')
    watcher.fire('world/the-ashfall.md', 'story/new.md', 'world/.the-ashfall.md.0123abcd.um-tmp')
    expect(service.search(id, 'strata').hits.map((hit) => hit.path)).toEqual([
      'world/the-ashfall.md',
    ])
    expect(service.getEntry(id, 'world/the-ashfall.md').backlinks.map((b) => b.title)).toEqual([
      'New',
      'Rowan',
      'Wonder before danger',
    ])
    expect(changes.at(-1)?.paths).toContain('story/new.md')
  })

  it('searches 500 entries in under 50 ms', async () => {
    const view = await newVault('blank')
    const id = view.vault.id
    for (let index = 0; index < 500; index++) {
      write(
        `ideas/idea-${index}.md`,
        `---\nid: i${index}\ntitle: Idea ${index}\n---\nA note about ${index % 7 === 0 ? 'lanterns' : 'ropes'} and climbing number ${index}.\n`,
      )
    }
    await service.close()
    service = makeService()
    await service.open(vaultRoot())
    service.search(id, 'warm up')
    const times: number[] = []
    for (const text of ['lanterns', 'climbing', 'idea 42', 'rop']) {
      const result = service.search(id, text)
      expect(result.hits.length).toBeGreaterThan(0)
      times.push(result.ms)
    }
    expect(Math.max(...times)).toBeLessThan(50)
  })
})

describe('files the app does not own', () => {
  it('leaves unknown files and front matter untouched through edits, renames and moves', async () => {
    const view = await newVault()
    const id = view.vault.id
    const unknown = [
      'notes.txt',
      'world/map.png',
      '.obsidian/app.json',
      'world/sub/deep.md',
      'extra-folder/thing.md',
    ]
    for (const rel of unknown) write(rel, `untouched ${rel}\n`)
    const hashes = unknown.map((rel) => sha(join(vaultRoot(), ...rel.split('/'))))
    const readme = sha(join(vaultRoot(), 'README.md'))
    await service.createEntry(id, 'world', 'Zone 1', 'Edge of the Ashfall.\n')
    const created = service.getEntry(id, 'world/zone-1.md')
    await service.saveEntry(id, created.path, 'Edited.\n', created.version, false)
    await service.renameEntry(id, created.path, 'Layer One')
    await service.deleteEntry(id, 'world/layer-one.md')
    await service.setSections(id, [
      ...service.view(id).sections.map(({ id: sectionId, name }) => ({ id: sectionId, name })),
      { id: null, name: 'Music' },
    ])
    expect(unknown.map((rel) => sha(join(vaultRoot(), ...rel.split('/'))))).toEqual(hashes)
    expect(sha(join(vaultRoot(), 'README.md'))).toBe(readme)
    // Files in folders that are not sections are not entries.
    expect(service.search(id, 'untouched').hits).toEqual([])
  })
})

describe('atomic saves', () => {
  it('a failed write leaves the old file and no temporary file behind', async () => {
    const view = await newVault()
    const { entry } = await service.createEntry(view.vault.id, 'pillars', 'Wonder', 'v1\n')
    const before = read(entry.path)
    const files = new NodeVaultFiles()
    const target = join(vaultRoot(), 'pillars', 'wonder.md')
    // Writing onto a folder fails at the rename, after the temporary file was written.
    rmSync(target)
    mkdirSync(target)
    await expect(files.writeTextAtomic(target, 'v2')).rejects.toThrow()
    rmSync(target, { recursive: true })
    writeFileSync(target, before)
    expect(readdirSync(join(vaultRoot(), 'pillars'))).toEqual(['wonder.md'])
    expect(read(entry.path)).toBe(before)
  })

  it('cleans up temporary files a killed save left, and only those', async () => {
    const view = await newVault()
    await service.close()
    write('pillars/.wonder.md.0a1b2c3d.um-tmp', 'half')
    write('pillars/.keep-me', 'mine')
    write('.wonder.md.ffffffff.um-tmp', 'half')
    expect(TEMP_FILE.test('.wonder.md.0a1b2c3d.um-tmp')).toBe(true)
    service = makeService()
    await service.open(vaultRoot())
    expect(readdirSync(join(vaultRoot(), 'pillars'))).toEqual(['.keep-me'])
    expect(existsSync(join(vaultRoot(), '.wonder.md.ffffffff.um-tmp'))).toBe(false)
    expect(view.vault.id).toBe(service.view(view.vault.id).vault.id)
  })
})

describe('starter kits', () => {
  it('reads templates with LF line endings even from a CRLF checkout', () => {
    const kits = join(dir, 'kits')
    mkdirSync(join(kits, 'tiny', 'templates'), { recursive: true })
    writeFileSync(
      join(kits, 'tiny', 'kit.json'),
      JSON.stringify({
        id: 'tiny',
        name: 'Tiny',
        sections: [{ id: 'pillars', name: 'Pillars', template: 'templates/pillars.md' }],
      }),
    )
    writeFileSync(join(kits, 'tiny', 'templates', 'pillars.md'), '## Feel\r\n\r\n## Rules out\r\n')
    expect(new FolderStarterKits(kits).list()[0]?.sections[0]?.template).toBe(
      '## Feel\n\n## Rules out\n',
    )
  })

  it('skips kits whose template points outside the kit folder', () => {
    const kits = join(dir, 'kits')
    mkdirSync(join(kits, 'sneaky'), { recursive: true })
    writeFileSync(join(dir, 'secret.md'), 'secret')
    writeFileSync(
      join(kits, 'sneaky', 'kit.json'),
      JSON.stringify({
        id: 'sneaky',
        name: 'Sneaky',
        sections: [{ id: 'pillars', name: 'Pillars', template: '../../secret.md' }],
      }),
    )
    expect(new FolderStarterKits(kits).list()).toEqual([])
  })
})

describe('sections', () => {
  it('adds, renames, reorders, removes into .trash and restores', async () => {
    const view = await newVault('blank')
    const id = view.vault.id
    await service.createEntry(id, 'ideas', 'Rope', 'x\n')
    let next = await service.setSections(id, [
      { id: 'ideas', name: 'Parking lot' },
      { id: 'pillars', name: 'Pillars' },
      { id: 'decisions', name: 'Decisions' },
      { id: null, name: 'Sound & music' },
    ])
    expect(next.sections.map((s) => [s.id, s.name])).toEqual([
      ['ideas', 'Parking lot'],
      ['pillars', 'Pillars'],
      ['decisions', 'Decisions'],
      ['sound-music', 'Sound & music'],
    ])
    expect(existsSync(join(vaultRoot(), 'sound-music'))).toBe(true)
    await expect(service.setSections(id, [{ id: 'ideas', name: 'x' }])).rejects.toThrow(
      /Every section/,
    )

    const removed = await service.removeSection(id, 'ideas')
    expect(removed.trashPath).toBe('.trash/_sections/ideas')
    expect(existsSync(join(vaultRoot(), '.trash', '_sections', 'ideas', 'rope.md'))).toBe(true)
    expect(removed.vault.sections.map((s) => s.id)).toEqual(['pillars', 'decisions', 'sound-music'])
    expect(service.search(id, 'rope').hits).toEqual([])

    next = await service.restoreSection(id, removed.trashPath, removed.section, removed.position)
    expect(next.sections.map((s) => s.id)).toEqual(['ideas', 'pillars', 'decisions', 'sound-music'])
    expect(next.sections[0]?.entries.map((e) => e.title)).toEqual(['Rope'])
    const config = JSON.parse(read('bible.json'))
    expect(config.sections[0]).toEqual({ id: 'ideas', name: 'Parking lot' })
  })
})

describe('the chokidar watcher', () => {
  it('reports an outside edit within a second and ignores hidden and temporary files', async () => {
    await service.close()
    service = makeService(new ChokidarVaultWatcher())
    const view = await newVault('blank')
    const seen = vi.fn<(paths: string[]) => void>()
    const done = new Promise<void>((resolve) => {
      changes = new Proxy([], {
        get(target, key) {
          if (key === 'push') {
            return (event: { paths: string[] }) => {
              seen(event.paths)
              if (event.paths.includes('pillars/wonder.md')) resolve()
              return 0
            }
          }
          return Reflect.get(target, key)
        },
      })
    })
    const started = performance.now()
    write('.trash/x.md', 'ignored')
    write('pillars/.wonder.md.0a1b2c3d.um-tmp', 'ignored')
    write('pillars/wonder.md', '---\ntitle: Wonder\n---\nfrom another editor\n')
    await done
    expect(performance.now() - started).toBeLessThan(1000)
    expect(seen.mock.calls.flat(2)).not.toContain('.trash/x.md')
    expect(seen.mock.calls.flat(2).some((path) => path.endsWith('.um-tmp'))).toBe(false)
    expect(service.search(view.vault.id, 'editor').hits.map((hit) => hit.path)).toEqual([
      'pillars/wonder.md',
    ])
  })
})
