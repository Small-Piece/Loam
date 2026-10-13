import { createHash } from 'node:crypto'
import {
  cpSync,
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
import { BibleService, type LibraryAssets, type VaultWatcher } from '@loam/core'
import { SqliteBibleIndex } from './bibleIndex.ts'
import { openDatabase } from './database.ts'
import { FolderStarterKits } from './starterKits.ts'
import { NodeVaultFiles } from './vaultFiles.ts'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const migrationsDir = join(repo, 'migrations')
const kitsDir = join(repo, 'starter-kits')
const quietWatcher: VaultWatcher = { watch: async () => async () => undefined }

// Smallest valid PNG headers, different bytes for "thumbnail" and "original".
const png = (marker: number) =>
  Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, marker])
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const THUMB = png(1)
const ORIGINAL = png(2)

const library: LibraryAssets = {
  describe: (ids) =>
    ids.map((id) => ({
      id,
      title: `Reference ${id}`,
      imageHash: sha(ORIGINAL),
      imageMime: 'image/png',
      thumbHash: sha(THUMB),
    })),
  read: async (hash) => (hash === sha(THUMB) ? THUMB : ORIGINAL),
}

let dir: string
let db: ReturnType<typeof openDatabase>['db']
let ids: number
let nowMs: number
let service: BibleService

function makeService(options: { withLibrary?: boolean; database?: typeof db } = {}) {
  return new BibleService({
    files: new NodeVaultFiles(),
    index: new SqliteBibleIndex(options.database ?? db),
    watcher: quietWatcher,
    kits: new FolderStarterKits(kitsDir),
    clock: { now: () => new Date(nowMs), monotonicMs: () => performance.now() },
    newId: () => `id${String(++ids).padStart(10, '0')}`,
    onChanged: () => undefined,
    ...(options.withLibrary === false ? {} : { library }),
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'loam-bible5c-'))
  db = openDatabase({ filePath: join(dir, 'app.db'), migrationsDir }).db
  ids = 0
  nowMs = Date.parse('2026-10-13T09:00:00.000Z')
  service = makeService()
})

afterEach(async () => {
  await service.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const root = () => join(dir, 'Game', 'bible')
const read = (rel: string, base = root()) => readFileSync(join(base, ...rel.split('/')), 'utf8')
const write = (rel: string, text: string, base = root()) => {
  mkdirSync(join(base, ...rel.split('/').slice(0, -1)), { recursive: true })
  writeFileSync(join(base, ...rel.split('/')), text)
}
// The front matter, with its last line's line break.
const front = (rel: string) => `${read(rel).split('\n---\n')[0] ?? ''}\n`

async function newVault(kit = 'atmospheric-horror') {
  mkdirSync(join(dir, 'Game'), { recursive: true })
  return (await service.create(join(dir, 'Game'), kit, 'Dream')).vault.id
}

async function pillar(id: number, title: string) {
  return (await service.createEntry(id, 'pillars', title, '')).entry
}

describe('decisions and ideas', () => {
  it('new decisions and ideas get their built-in fields with defaults', async () => {
    const id = await newVault()
    const decision = (await service.createEntry(id, 'decisions', 'Go deeper', null)).entry
    expect(front(decision.path)).toContain(
      '\ndate: 2026-10-13\nstatus: decided\npillars: []\nalternatives: []',
    )
    expect(decision.body).toContain('## Decision')
    expect(decision.noPillar).toBe(true)
    const idea = (await service.createEntry(id, 'ideas', 'Rope', null)).entry
    expect(front(idea.path)).toContain('\nstatus: parked\npillars: []')
    const world = (await service.createEntry(id, 'world', 'Oakmere', '')).entry
    expect(world.noPillar).toBeNull()
  })

  it("dates a new decision with the user's local day, not the UTC one", async () => {
    const zone = process.env['TZ']
    process.env['TZ'] = 'Asia/Seoul'
    try {
      // 2026-10-13 00:30 in UTC+9 is still 2026-10-12 in UTC.
      nowMs = Date.parse('2026-10-13T00:30:00+09:00')
      const id = await newVault()
      const decision = (await service.createEntry(id, 'decisions', 'Go deeper', null)).entry
      expect(front(decision.path)).toMatch(/^date: 2026-10-13$/m)
    } finally {
      if (zone === undefined) delete process.env['TZ']
      else process.env['TZ'] = zone
    }
  })

  it('pillar links are ids in front matter and survive hand edits', async () => {
    const id = await newVault()
    const awe = await pillar(id, 'Awe')
    const dread = await pillar(id, 'Dread')
    const decision = (await service.createEntry(id, 'decisions', 'Go deeper', '')).entry
    const saved = await service.setProperties(
      id,
      decision.path,
      [
        { key: 'pillars', value: [awe.id] },
        { key: 'status', value: 'revisited' },
        { key: 'alternatives', value: ['Stay on the surface', 'Climb'] },
      ],
      decision.version,
    )
    if (saved.status !== 'saved') throw new Error('conflict')
    expect(front(decision.path)).toContain(`\npillars: [${awe.id}]\n`)
    expect(saved.entry.noPillar).toBe(false)
    expect(service.getEntry(id, awe.path).servedBy?.decisions).toEqual([
      { path: decision.path, title: 'Go deeper' },
    ])

    // Edited by hand: a block list with a title and an id; a hand-written idea.
    write(
      decision.path,
      read(decision.path).replace(
        `pillars: [${awe.id}]`,
        `pillars:\n  - "[[Dread]]"\n  - ${awe.id}`,
      ),
    )
    write(
      'ideas/hand.md',
      `---\nid: hand0000001\ntitle: Hand idea\nstatus: dropped\npillars: [${dread.id}]\n---\nBy hand.\n`,
    )
    await service.close()
    service = makeService()
    await service.open(root())
    expect(service.pillars(id).map((card) => [card.title, card.decisions, card.ideas])).toEqual([
      ['Awe', 1, 0],
      ['Dread', 1, 1],
    ])
    expect(service.timeline(id)).toEqual([
      {
        path: decision.path,
        title: 'Go deeper',
        date: '2026-10-13',
        status: 'revisited',
        pillars: [
          { path: dread.path, title: 'Dread' },
          { path: awe.path, title: 'Awe' },
        ],
        noPillar: false,
      },
    ])
    expect(service.ideas(id)).toMatchObject([
      { title: 'Hand idea', status: 'dropped', noPillar: false },
    ])
  })

  it('the timeline is newest first and the review lists everything with no pillar', async () => {
    const id = await newVault()
    const awe = await pillar(id, 'Awe')
    for (const [title, date] of [
      ['Old call', '2026-01-05'],
      ['New call', '2026-10-01'],
      ['Middle call', '2026-05-20'],
    ] as const) {
      const entry = (await service.createEntry(id, 'decisions', title, '')).entry
      write(entry.path, read(entry.path).replace('date: 2026-10-13', `date: ${date}`))
    }
    const served = (await service.createEntry(id, 'ideas', 'Served idea', '')).entry
    await service.setProperties(
      id,
      served.path,
      [{ key: 'pillars', value: [awe.id] }],
      served.version,
    )
    await service.createEntry(id, 'ideas', 'Loose idea', '')
    await service.close()
    service = makeService()
    await service.open(root())
    expect(service.timeline(id).map((item) => [item.title, item.date])).toEqual([
      ['New call', '2026-10-01'],
      ['Middle call', '2026-05-20'],
      ['Old call', '2026-01-05'],
    ])
    expect(service.review(id).map((item) => [item.section, item.title])).toEqual([
      ['decisions', 'Old call'],
      ['decisions', 'New call'],
      ['decisions', 'Middle call'],
      ['ideas', 'Loose idea'],
    ])
    const view = service.view(id)
    const flags = view.sections
      .find((s) => s.id === 'ideas')
      ?.entries.map((e) => [e.title, e.noPillar])
    expect(flags).toEqual([
      ['Served idea', false],
      ['Loose idea', true],
    ])
  })
})

describe('promote', () => {
  it('creates the target, links both ways, sets promoted; undo restores both in one step', async () => {
    const id = await newVault()
    const awe = await pillar(id, 'Awe')
    const idea = (await service.createEntry(id, 'ideas', 'Rope swing', 'Swing across gaps.\n'))
      .entry
    await service.setProperties(id, idea.path, [{ key: 'pillars', value: [awe.id] }], idea.version)
    const before = read(idea.path)

    const promoted = await service.promoteIdea(id, idea.path, 'decisions', 'Use rope swings')
    expect(promoted.entry.path).toBe('decisions/use-rope-swings.md')
    expect(front(promoted.entry.path)).toContain(`\npromoted_from: ${idea.id}`)
    expect(front(promoted.entry.path)).toContain(`\npillars: [${awe.id}]`)
    expect(front(promoted.entry.path)).toContain('\nstatus: decided')
    expect(front(idea.path)).toContain('\nstatus: promoted\n')
    expect(front(idea.path)).toContain(`\npromoted_to: ${promoted.entry.id}\n`)
    expect(read(idea.path).endsWith('Swing across gaps.\n')).toBe(true)
    expect(promoted.entry.promotedFrom).toEqual({ path: idea.path, title: 'Rope swing' })
    expect(service.getEntry(id, idea.path).promotedTo).toEqual({
      path: promoted.entry.path,
      title: 'Use rope swings',
    })
    expect(service.ideas(id)[0]).toMatchObject({
      status: 'promoted',
      promotedTo: { title: 'Use rope swings' },
    })

    await service.undoPromote(id, promoted.undo)
    expect(read(idea.path)).toBe(before)
    expect(existsSync(join(root(), 'decisions', 'use-rope-swings.md'))).toBe(false)
    expect(service.timeline(id)).toEqual([])
    await expect(service.undoPromote(id, promoted.undo)).rejects.toThrow(/Nothing to undo/)
  })

  it('promotes into a regular section too, and refuses undo once a file changed', async () => {
    const id = await newVault()
    const idea = (await service.createEntry(id, 'ideas', 'Glow moss', '')).entry
    const promoted = await service.promoteIdea(id, idea.path, 'world', 'Glow moss caves')
    expect(promoted.entry.path).toBe('world/glow-moss-caves.md')
    expect(front(promoted.entry.path)).not.toContain('pillars:')
    write(promoted.entry.path, read(promoted.entry.path) + 'Written after.\n')
    await expect(service.undoPromote(id, promoted.undo)).rejects.toThrow(/changed since/)
    await expect(service.promoteIdea(id, promoted.entry.path, 'decisions', 'X')).rejects.toThrow(
      /Only ideas/,
    )
  })
})

describe('references', () => {
  it('copies the thumbnail into _assets, lists it in front matter and returns a relative link', async () => {
    const id = await newVault()
    const entry = (await service.createEntry(id, 'creatures', 'Hermit', 'Body.\n')).entry
    const { result, images } = await service.addReferences(id, entry.path, [7], entry.version)
    if (result.status !== 'saved') throw new Error('conflict')
    const asset = `_assets/${sha(THUMB)}.png`
    expect(readFileSync(join(root(), ...asset.split('/')))).toEqual(Buffer.from(THUMB))
    expect(front(entry.path)).toContain(`\nreferences: [${asset}]`)
    expect(images).toEqual([{ alt: 'Reference 7', link: `../${asset}` }])
    expect(result.entry.references).toEqual([asset])
    expect(service.assetUses([sha(THUMB)])).toMatchObject([{ path: entry.path, title: 'Hermit' }])
    // Adding it again lists it once.
    await service.addReferences(id, entry.path, [7], result.entry.version)
    expect(front(entry.path).match(/_assets\//g)).toHaveLength(1)

    // The vault setting copies originals instead.
    const settled = await service.setSettings(id, { copyOriginals: true })
    expect(settled.settings.copyOriginals).toBe(true)
    expect(JSON.parse(read('bible.json')).assets).toEqual({ copy: 'original' })
    const other = (await service.createEntry(id, 'world', 'Oakmere', '')).entry
    await service.addReferences(id, other.path, [7], other.version)
    expect(existsSync(join(root(), '_assets', `${sha(ORIGINAL)}.png`))).toBe(true)
  })

  it('a cloned vault shows the same references and pillar views with no Library', async () => {
    const id = await newVault()
    const awe = await pillar(id, 'Awe')
    const decision = (await service.createEntry(id, 'decisions', 'Go deeper', '')).entry
    await service.setProperties(
      id,
      decision.path,
      [{ key: 'pillars', value: [awe.id] }],
      decision.version,
    )
    const entry = (await service.createEntry(id, 'creatures', 'Hermit', '')).entry
    await service.addReferences(id, entry.path, [7], entry.version)
    const cards = service.pillars(id)
    const refs = service.getEntry(id, entry.path).references
    await service.close()

    // A teammate's clone: another folder, another app database, no Library.
    const clone = join(dir, 'Teammate', 'bible')
    cpSync(root(), clone, { recursive: true })
    const otherDb = openDatabase({ filePath: join(dir, 'teammate.db'), migrationsDir }).db
    const teammate = makeService({ withLibrary: false, database: otherDb })
    try {
      const view = await teammate.open(clone)
      expect(teammate.pillars(view.vault.id)).toEqual(cards)
      expect(teammate.getEntry(view.vault.id, entry.path).references).toEqual(refs)
      const asset = refs[0] ?? ''
      expect(teammate.vaultFile(asset)).toBe(join(clone, ...asset.split('/')))
      await expect(teammate.addReferences(view.vault.id, entry.path, [7], 'x')).rejects.toThrow(
        /Library is not available/,
      )
    } finally {
      await teammate.close()
      otherDb.close()
    }
  })

  it('serves only image files inside the open vault', async () => {
    await newVault()
    write('_assets/ok.png', 'x')
    write('world/map.webp', 'x')
    write('.trash/hidden.png', 'x')
    write('notes.txt', 'x')
    expect(service.vaultFile('_assets/ok.png')).toBe(join(root(), '_assets', 'ok.png'))
    expect(service.vaultFile('world/map.webp')).not.toBeNull()
    for (const bad of [
      '../app.db',
      '_assets/../../app.db',
      '.trash/hidden.png',
      'notes.txt',
      '_assets/missing.png',
      '/etc/x.png',
    ]) {
      expect(service.vaultFile(bad)).toBeNull()
    }
  })
})

describe('staleness', () => {
  it('marks an old entry once a decision linking to it changes; editing it clears the mark', async () => {
    const id = await newVault()
    write(
      'world/ashfall.md',
      '---\nid: ashfall000001\ntitle: Ashfall\nupdated: 2026-06-01T00:00:00.000Z\n---\nOld text.\n',
    )
    write(
      'world/oakmere.md',
      '---\nid: oakm0000001\ntitle: Oakmere\nupdated: 2026-06-01T00:00:00.000Z\n---\nNot linked.\n',
    )
    write(
      'decisions/descend.md',
      '---\nid: desc0000001\ntitle: Descend\nupdated: 2026-09-01T00:00:00.000Z\n---\nWe go into [[Ashfall]].\n',
    )
    await service.close()
    service = makeService()
    await service.open(root())
    const flags = () =>
      Object.fromEntries(
        service
          .view(id)
          .sections.flatMap((s) => s.entries)
          .map((e) => [e.title, e.stale]),
      )
    expect(flags()).toMatchObject({ Ashfall: true, Oakmere: false, Descend: false })
    expect(service.getEntry(id, 'world/ashfall.md').stale).toBe(true)

    const ashfall = service.getEntry(id, 'world/ashfall.md')
    await service.saveEntry(id, ashfall.path, 'Rewritten.\n', ashfall.version, false)
    expect(flags()).toMatchObject({ Ashfall: false })
  })
})

describe('kit updates', () => {
  /** A vault as the Slice 5a build created it: no fields in bible.json. */
  function slice5aVault() {
    const config = {
      format: 1,
      title: 'Mossgrove',
      kit: 'atmospheric-horror',
      sections: [
        { id: 'pillars', name: 'Pillars' },
        { id: 'atmosphere', name: 'Atmosphere' },
        { id: 'world', name: 'World' },
        { id: 'creatures', name: 'Creatures' },
        { id: 'decisions', name: 'Decisions' },
        { id: 'ideas', name: 'Ideas' },
      ],
    }
    write('bible.json', `${JSON.stringify(config, null, 2)}\n`)
    write(
      'creatures/hermit.md',
      '---\nid: herm0000001\ntitle: Hermit\n---\n## What it is\nSmall.\n',
    )
    write('world/ashfall.md', '---\nid: ashfall000001\ntitle: Ashfall\n---\n')
    write('README.md', '# Mossgrove\n')
  }
  const hashes = () =>
    Object.fromEntries(
      ['creatures/hermit.md', 'world/ashfall.md', 'README.md'].map((rel) => [rel, sha(read(rel))]),
    )

  it('offers the kit fields and the missing section; applying writes only bible.json', async () => {
    slice5aVault()
    const before = hashes()
    const listing = readdirSync(root()).sort()
    const view = await service.open(root())
    expect(view.kitUpdate?.sections.map((s) => s.id)).toEqual(['story'])
    expect(view.kitUpdate?.fields.map((f) => `${f.section}.${f.field.key}`)).toEqual([
      'atmosphere.mood',
      'world.depth',
      'world.mood',
      'creatures.threat',
      'creatures.habitat',
    ])
    const applied = await service.applyKitUpdate(view.vault.id, {
      sections: [],
      fields: view.kitUpdate?.fields.map((f) => ({ section: f.section, key: f.field.key })) ?? [],
    })
    expect(applied.kitUpdate).toBeNull()
    const config = JSON.parse(read('bible.json')) as {
      sections: Array<{ id: string; fields?: Array<{ key: string }> }>
    }
    expect(config.sections.map((s) => s.id)).toEqual([
      'pillars',
      'atmosphere',
      'world',
      'creatures',
      'decisions',
      'ideas',
    ])
    expect(config.sections.find((s) => s.id === 'creatures')?.fields?.map((f) => f.key)).toEqual([
      'threat',
      'habitat',
    ])
    expect(hashes()).toEqual(before)
    // Nothing but bible.json changed: the same files and folders, entry files byte-identical.
    expect(readdirSync(root()).sort()).toEqual(listing)
    expect(
      service
        .getEntry(applied.vault.id, 'creatures/hermit.md')
        .properties.map((p) => [p.key, p.value]),
    ).toEqual([
      ['threat', null],
      ['habitat', null],
    ])
    // Reopening: the notice stays away (only "story" was left out, by choice).
    await service.close()
    service = makeService()
    expect((await service.open(root())).kitUpdate).toBeNull()
  })

  it('dismissing hides the notice until the kit changes; Blank and unknown kits never show it', async () => {
    slice5aVault()
    const view = await service.open(root())
    expect(service.dismissKitUpdate(view.vault.id).kitUpdate).toBeNull()
    await service.close()
    service = makeService()
    expect((await service.open(root())).kitUpdate).toBeNull()
    // A changed kit fingerprint brings it back.
    db.prepare('UPDATE bible_vaults SET kit_seen = ?').run('00000000')
    await service.close()
    service = makeService()
    expect((await service.open(root())).kitUpdate).not.toBeNull()

    for (const kit of ['blank', 'no-such-kit']) {
      write('bible.json', JSON.stringify({ format: 1, title: 'X', kit, sections: [] }))
      await service.close()
      db.prepare('UPDATE bible_vaults SET kit_seen = NULL').run()
      service = makeService()
      expect((await service.open(root())).kitUpdate).toBeNull()
    }
  })
})

describe('missing links and moves', () => {
  it('offers the target template only while the body is still the source template', async () => {
    const id = await newVault()
    const untouched = (await service.createEntry(id, 'creatures', '6th floor', null)).entry
    const written = (await service.createEntry(id, 'creatures', 'Hermit', null)).entry
    await service.saveEntry(id, written.path, `${written.body}More.\n`, written.version, false)
    const moved = await service.moveEntry(id, untouched.path, 'world')
    expect(moved.templateSwap).toBe(true)
    const stays = await service.moveEntry(id, written.path, 'world')
    expect(stays.templateSwap).toBe(false)

    const current = service.getEntry(id, moved.path)
    const swapped = await service.swapTemplate(id, moved.path, 'creatures', current.version)
    if (swapped.status !== 'saved') throw new Error('conflict')
    expect(swapped.entry.body).toBe(read('world/6th-floor.md').split('\n---\n')[1])
    expect(swapped.entry.body).toContain('## Overview')
    // Front-matter keys from Creatures stay (never removed).
    expect(front(moved.path)).toContain('\nthreat:\nhabitat:')
    await expect(
      service.swapTemplate(id, stays.path, 'creatures', service.getEntry(id, stays.path).version),
    ).rejects.toThrow(/written meanwhile/)
  })
})
