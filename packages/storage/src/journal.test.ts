import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BibleService,
  addPracticeImages,
  type ImageUpload,
  type ImportOutcome,
  type VaultRole,
  type VaultWatcher,
} from '@loam/core'
import { SqliteBibleIndex } from './bibleIndex.ts'
import { openDatabase } from './database.ts'
import { FolderStarterKits } from './starterKits.ts'
import { NodeVaultFiles } from './vaultFiles.ts'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const migrationsDir = join(repo, 'migrations')
const kitsDir = join(repo, 'starter-kits')
const quietWatcher: VaultWatcher = { watch: async () => async () => undefined }

const png = (marker: number) =>
  Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, marker])
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

let dir: string
let db: ReturnType<typeof openDatabase>['db']
let ids: number
let nowMs: number
let journal: BibleService
let bible: BibleService

function makeService(role: VaultRole, database = db) {
  return new BibleService({
    files: new NodeVaultFiles(),
    index: new SqliteBibleIndex(database),
    watcher: quietWatcher,
    kits: new FolderStarterKits(kitsDir),
    clock: { now: () => new Date(nowMs), monotonicMs: () => performance.now() },
    newId: () => `id${String(++ids).padStart(10, '0')}`,
    onChanged: () => undefined,
    hasher: { sha256: (bytes) => sha(bytes) },
    role,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'loam-journal-'))
  db = openDatabase({ filePath: join(dir, 'app.db'), migrationsDir }).db
  ids = 0
  // Noon local time on 13 October 2026, whatever the machine's time zone.
  nowMs = new Date(2026, 9, 13, 12, 0).getTime()
  journal = makeService('journal')
  bible = makeService('bible')
})

afterEach(async () => {
  await journal.close()
  await bible.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const journalRoot = () => join(dir, 'Loam Journal')
const read = (rel: string) => readFileSync(join(journalRoot(), ...rel.split('/')), 'utf8')
const write = (rel: string, text: string) => {
  const file = join(journalRoot(), ...rel.split('/'))
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
}

/** A session file as a person (or another install) might write it. */
function sessionFile(id: string, title: string, fields: string, body: string): string {
  return `---\nid: ${id}\ntitle: ${title}\ntags: []\ncreated: 2026-10-01T00:00:00.000Z\nupdated: 2026-10-01T00:00:00.000Z\n${fields}---\n${body}`
}

async function createJournal() {
  const view = await journal.create(journalRoot(), 'journal', 'Study journal')
  return view.vault.id
}

describe('the Journal kit', () => {
  it('is offered to the journal only, not as a bible kit', () => {
    expect(journal.kits().map((kit) => kit.id)).toEqual(['journal'])
    expect(bible.kits().map((kit) => kit.id)).not.toContain('journal')
    expect(bible.kits().length).toBeGreaterThan(0)
  })

  it('creates the journal in the chosen folder with its sections, fields and Session template', async () => {
    const view = await journal.create(journalRoot(), 'journal', 'Study journal')
    expect(view.role).toBe('journal')
    expect(existsSync(join(journalRoot(), 'bible'))).toBe(false)
    const config = JSON.parse(read('bible.json')) as {
      kit: string
      sections: Array<{
        id: string
        fields?: Array<{ key: string; type: string; options?: string[] }>
      }>
    }
    expect(config.kit).toBe('journal')
    const keys = (id: string) =>
      config.sections.find((section) => section.id === id)?.fields?.map((field) => field.key)
    expect(config.sections.map((section) => section.id)).toEqual([
      'sessions',
      'topics',
      'resources',
    ])
    expect(keys('sessions')).toEqual(['date', 'topics', 'minutes', 'kind'])
    expect(keys('topics')).toEqual(['status', 'started'])
    expect(keys('resources')).toEqual(['url', 'topics', 'status', 'rating'])
    const kind = config.sections[0]?.fields?.find((field) => field.key === 'kind')
    expect(kind?.options).toEqual(['practice', 'tutorial', 'reading', 'play research', 'other'])
    // The journal keeps original images unless told otherwise.
    expect(view.settings.copyOriginals).toBe(true)

    const created = await journal.newSession(view.vault.id)
    const text = read(created.entry.path)
    expect(created.entry.title).toBe('2026-10-13')
    expect(text).toMatch(/^date: 2026-10-13$/m)
    expect(text).toContain(
      '## What I practised\n\n## What I learned\n\n## What was hard\n\n## Next time\n',
    )
  })

  it('opens an existing journal folder, and keeps journals and bibles apart', async () => {
    await createJournal()
    await journal.close()
    // Another install: a fresh app database.
    const other = openDatabase({ filePath: join(dir, 'other.db'), migrationsDir }).db
    const fresh = makeService('journal', other)
    const view = await fresh.open(journalRoot())
    expect(view.sections.map((section) => section.id)).toEqual(['sessions', 'topics', 'resources'])
    await fresh.close()
    const otherBible = makeService('bible', other)
    await expect(otherBible.open(journalRoot())).rejects.toThrow(/study journal/)
    other.close()

    const game = join(dir, 'Game')
    mkdirSync(game)
    await bible.create(game, 'blank', 'Game')
    await expect(journal.open(join(game, 'bible'))).rejects.toThrow(/game bible, not a journal/)
  })

  it('reopens the journal for Journal and the last bible for Bible', async () => {
    const game = join(dir, 'Game')
    mkdirSync(game)
    await bible.create(game, 'blank', 'Game')
    await createJournal()
    await bible.close()
    await journal.close()
    const nextJournal = makeService('journal')
    const nextBible = makeService('bible')
    expect((await nextJournal.home()).current?.vault.path).toBe(journalRoot())
    expect((await nextBible.home()).current?.vault.path).toBe(join(game, 'bible'))
    expect(nextBible.recent().map((vault) => vault.path)).toEqual([join(game, 'bible')])
    await nextJournal.close()
    await nextBible.close()
  })

  it('never rewrites an existing journal on open', async () => {
    await createJournal()
    write(
      'sessions/old.md',
      sessionFile('old000000001', 'Old', 'date: 2026-09-01\n', '## Next time\nX\n'),
    )
    const before = read('sessions/old.md')
    const config = read('bible.json')
    await journal.close()
    await makeService('journal').open(journalRoot())
    expect(read('sessions/old.md')).toBe(before)
    expect(read('bible.json')).toBe(config)
  })
})

describe('Today', () => {
  it("lists today's sessions and shows the previous session's Next time", async () => {
    const vaultId = await createJournal()
    write(
      'sessions/a.md',
      sessionFile(
        'aaaa00000001',
        '2026-10-10 Hands',
        'date: 2026-10-10\n',
        '## Next time\n\nOld advice.\n',
      ),
    )
    write(
      'sessions/b.md',
      sessionFile(
        'bbbb00000001',
        '2026-10-12 Lighting',
        'date: 2026-10-12\n',
        '## What I learned\nRim light.\n\n## Next time\n\nTry a [[Sphere study]].\n',
      ),
    )
    journal.rebuildIndex(vaultId)
    let today = journal.today(vaultId)
    expect(today.today).toBe('2026-10-13')
    expect(today.sessions).toEqual([])
    expect(today.previous).toEqual({
      path: 'sessions/b.md',
      title: '2026-10-12 Lighting',
      date: '2026-10-12',
      nextTime: 'Try a [[Sphere study]].',
    })

    const first = await journal.newSession(vaultId)
    const second = await journal.newSession(vaultId)
    expect(second.entry.title).toBe('2026-10-13 2')
    today = journal.today(vaultId)
    expect(today.sessions.map((session) => session.path)).toEqual([
      first.entry.path,
      second.entry.path,
    ])
    expect(today.previous?.path).toBe('sessions/b.md')
  })
})

describe('calendar', () => {
  it('groups sessions by day: date field, else a date in the title', async () => {
    const vaultId = await createJournal()
    write('sessions/x.md', sessionFile('xxxx00000001', 'Evening', 'date: 2026-03-04\n', ''))
    write('sessions/y.md', sessionFile('yyyy00000001', '2026-03-04 Morning', '', ''))
    write(
      'sessions/z.md',
      sessionFile('zzzz00000001', '2026-03-09 Gesture', 'date: 2026-03-10\n', ''),
    )
    write('sessions/old.md', sessionFile('oldd00000001', 'Old', 'date: 2025-12-31\n', ''))
    journal.rebuildIndex(vaultId)
    const days = journal.calendar(vaultId, 2026)
    expect(days.map((day) => [day.date, day.sessions.length])).toEqual([
      ['2026-03-04', 2],
      ['2026-03-10', 1],
    ])
    expect(journal.calendar(vaultId, 2025).map((day) => day.date)).toEqual(['2025-12-31'])
  })
})

describe('recap', () => {
  it('builds from this week and from a topic, only the template headings, never earlier AI recaps', async () => {
    const vaultId = await createJournal()
    const day = (offset: number) => {
      const at = new Date(nowMs)
      at.setDate(at.getDate() - offset)
      return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
    }
    write('topics/anatomy.md', sessionFile('anat00000001', 'Anatomy', '', ''))
    const body = '## What I practised\nHands.\n\n## Private\nSecret plans.\n\n## Next time\nFeet.\n'
    write(
      'sessions/a.md',
      sessionFile('aaaa00000001', 'Old', `date: ${day(9)}\ntopics: [anat00000001]\n`, body),
    )
    write('sessions/b.md', sessionFile('bbbb00000001', 'Two days', `date: ${day(2)}\n`, body))
    write(
      'sessions/c.md',
      sessionFile('cccc00000001', 'Today', `date: ${day(0)}\ntopics: [anat00000001]\n`, body),
    )
    write(
      'sessions/d.md',
      sessionFile('dddd00000001', 'Empty', `date: ${day(1)}\n`, '## Next time\n'),
    )
    write(
      'sessions/e.md',
      sessionFile('eeee00000001', 'AI recap', `date: ${day(1)}\nai_generated: true\n`, body),
    )
    journal.rebuildIndex(vaultId)

    const week = journal.recapSources(vaultId, { kind: 'week' })
    expect(week.map((source) => source.id)).toEqual(['bbbb00000001', 'cccc00000001'])
    expect(week[0]?.text).toBe('### What I practised\nHands.\n\n### Next time\nFeet.')
    expect(week.map((source) => source.text).join('\n')).not.toContain('Secret plans')
    const topic = journal.recapSources(vaultId, { kind: 'topic', path: 'topics/anatomy.md' })
    expect(topic.map((source) => source.id)).toEqual(['aaaa00000001', 'cccc00000001'])

    const before = read('sessions/b.md')
    const saved = await journal.saveRecap(vaultId, 'Recap this week', 'Draft text.', [
      'bbbb00000001',
      'cccc00000001',
    ])
    const text = read(saved.entry.path)
    expect(text).toMatch(/^ai_generated: true$/m)
    expect(text).toMatch(/^source_sessions: \[bbbb00000001, cccc00000001\]$/m)
    expect(text).toContain('---\nDraft text.\n')
    expect(read('sessions/b.md')).toBe(before)
    // Saved recaps are not recapped again; a second one gets its own title.
    journal.rebuildIndex(vaultId)
    expect(
      journal.recapSources(vaultId, { kind: 'week' }).map((source) => source.id),
    ).not.toContain(saved.entry.id)
    const again = await journal.saveRecap(vaultId, 'Recap this week', 'More.', [])
    expect(again.entry.title).toBe('Recap this week 2')
  })
})

describe('topic progress and resources', () => {
  it('shows practice images oldest first, sessions newest first, resources and minutes', async () => {
    const vaultId = await createJournal()
    write('topics/anatomy.md', sessionFile('anat00000001', 'Anatomy', 'status: active\n', ''))
    write('topics/color.md', sessionFile('colo00000001', 'Color', 'status: active\n', ''))
    write(
      'sessions/s2.md',
      sessionFile(
        'sess00000002',
        'Hands again',
        'date: 2026-10-12\ntopics: [anat00000001]\nminutes: 30\nreferences: [_assets/bbb.png]\n',
        '',
      ),
    )
    write(
      'sessions/s1.md',
      sessionFile(
        'sess00000001',
        'Hands',
        // A topic typed by hand as a link counts too.
        'date: 2026-10-01\ntopics: ["[[Anatomy]]"]\nminutes: 45\nreferences: [_assets/aaa.png]\n',
        '',
      ),
    )
    write(
      'sessions/s3.md',
      sessionFile('sess00000003', 'Palette', 'date: 2026-10-13\ntopics: [colo00000001]\n', ''),
    )
    write(
      'resources/book.md',
      sessionFile(
        'reso00000001',
        'Figure drawing book',
        'url: https://example.com/book\ntopics: [anat00000001]\nstatus: in progress\nrating: 4\n',
        '',
      ),
    )
    write(
      'resources/talk.md',
      sessionFile('reso00000002', 'Color talk', 'topics: [colo00000001]\n', ''),
    )
    journal.rebuildIndex(vaultId)

    const progress = journal.topicProgress(vaultId, 'topics/anatomy.md')
    expect(progress.images.map((image) => [image.asset, image.session.date])).toEqual([
      ['_assets/aaa.png', '2026-10-01'],
      ['_assets/bbb.png', '2026-10-12'],
    ])
    expect(progress.sessions.map((session) => [session.title, session.minutes])).toEqual([
      ['Hands again', 30],
      ['Hands', 45],
    ])
    expect(progress.minutes).toBe(75)
    expect(progress.resources).toEqual([
      {
        path: 'resources/book.md',
        title: 'Figure drawing book',
        status: 'in progress',
        url: 'https://example.com/book',
        rating: '4',
        topics: [{ path: 'topics/anatomy.md', title: 'Anatomy' }],
      },
    ])
    // No minutes logged: none shown.
    expect(journal.topicProgress(vaultId, 'topics/color.md').minutes).toBeNull()

    expect(journal.resources(vaultId).map((item) => [item.title, item.status])).toEqual([
      // No order in either file: by title.
      ['Color talk', null],
      ['Figure drawing book', 'in progress'],
    ])
  })
})

describe('practice images', () => {
  const upload = (marker: number): ImageUpload => ({
    fileName: `hand-${marker}.png`,
    bytes: png(marker),
    width: 10,
    height: 10,
    thumbnail: { bytes: png(marker + 100), width: 5, height: 5 },
  })

  it('stores originals in _assets, lists them, and tags them in the Library when asked', async () => {
    const vaultId = await createJournal()
    write('topics/anatomy.md', sessionFile('anat00000001', 'Anatomy', '', ''))
    write(
      'sessions/s.md',
      sessionFile('sess00000001', 'Hands', 'date: 2026-10-13\ntopics: [anat00000001]\n', ''),
    )
    journal.rebuildIndex(vaultId)
    const imported: ImageUpload[] = []
    const tags = new Map<number, string[]>([[1, ['old']]])
    const library = {
      importImages: async (uploads: readonly ImageUpload[]): Promise<ImportOutcome[]> => {
        imported.push(...uploads)
        return uploads.map((item, index) => ({
          fileName: item.fileName,
          status: 'created' as const,
          id: index + 1,
        }))
      },
      getDetail: (id: number) => ({ tags: tags.get(id) ?? [] }),
      update: (id: number, patch: { tags: string[] }) => tags.set(id, patch.tags),
    }
    const version = journal.getEntry(vaultId, 'sessions/s.md').version
    const result = await addPracticeImages(journal, library, {
      vaultId,
      path: 'sessions/s.md',
      items: [upload(1), upload(2)],
      alsoLibrary: true,
      baseVersion: version,
    })
    expect(result.result.status).toBe('saved')
    const assets = [`_assets/${sha(png(1))}.png`, `_assets/${sha(png(2))}.png`]
    for (const asset of assets) expect(existsSync(join(journalRoot(), asset))).toBe(true)
    expect(read('sessions/s.md')).toContain(`references: [${assets.join(', ')}]`)
    expect(result.images.map((image) => image.link)).toEqual(assets.map((asset) => `../${asset}`))
    expect(imported).toHaveLength(2)
    expect(result.library).toEqual({ ids: [1, 2], tags: ['practice', 'Anatomy'], rejected: 0 })
    expect(tags.get(1)).toEqual(['old', 'practice', 'Anatomy'])

    const again = await addPracticeImages(journal, library, {
      vaultId,
      path: 'sessions/s.md',
      items: [upload(3)],
      alsoLibrary: false,
      baseVersion: journal.getEntry(vaultId, 'sessions/s.md').version,
    })
    expect(again.library).toBeNull()
    expect(imported).toHaveLength(2)
  })
})

describe('link picker memory', () => {
  it('remembers the section chosen for links created from a section, per vault', async () => {
    const game = join(dir, 'Game')
    mkdirSync(game)
    const view = await bible.create(game, 'atmospheric-horror', 'Game')
    expect(view.linkSections).toEqual({})
    const created = await bible.createLinkedEntry(view.vault.id, 'creatures', 'world', 'Floor 6')
    expect(created.entry.path).toBe('world/floor-6.md')
    expect(created.vault.linkSections).toEqual({ creatures: 'world' })
    await bible.createLinkedEntry(view.vault.id, 'creatures', 'atmosphere', 'Hum')
    expect(bible.view(view.vault.id).linkSections).toEqual({ creatures: 'atmosphere' })
    // Kept across restarts.
    await bible.close()
    const next = makeService('bible')
    const reopened = await next.open(join(game, 'bible'))
    expect(reopened.linkSections).toEqual({ creatures: 'atmosphere' })
    await next.close()
  })
})
