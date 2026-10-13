import { spawnSync } from 'node:child_process'
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
import { DatabaseSync } from 'node:sqlite'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { assertBuilt, launchApp as launch } from './launch.ts'

// Test vaults live in the system temp folder, never inside the repository.
let root: string
let localAppData: string
let running: ElectronApplication[] = []

test.beforeAll(() => {
  assertBuilt()
})

test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'loam-e2e-bible-'))
  localAppData = join(root, 'appdata')
  mkdirSync(localAppData)
})

test.afterEach(async () => {
  for (const app of running) await app.close().catch(() => undefined)
  running = []
  // A killed app's helper processes can hold files for a moment.
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launch(localAppData)
  running.push(app)
  const page = await app.firstWindow()
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible()
  return { app, page }
}

async function closeAll() {
  for (const app of running) await app.close().catch(() => undefined)
  running = []
}

/** Ends the app the hard way (no clean shutdown), like a crash or power loss, and waits until it is gone. */
async function killApp(app: ElectronApplication) {
  const child = app.process()
  const exited = new Promise((resolve) => child.once('exit', resolve))
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  await exited
  running = running.filter((candidate) => candidate !== app)
}

/** Answers the next system folder pickers with this folder. */
async function pickFolderWill(app: ElectronApplication, folder: string) {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [picked],
    })) as unknown as typeof dialog.showOpenDialog
  }, folder)
}

async function openBible(page: Page) {
  await page.getByRole('button', { name: 'Bible', exact: true }).click()
}

const kitNames = {
  blank: 'Blank',
  'narrative-adventure': 'Narrative adventure',
  'action-roguelike': 'Action / roguelike',
  'cozy-sim': 'Cozy / sim',
  'atmospheric-horror': 'Atmospheric / horror',
} as const

/** Creates a vault in <game>/bible through the start screen. */
async function createVault(
  app: ElectronApplication,
  page: Page,
  game: string,
  kit: keyof typeof kitNames,
  answer: string | null,
) {
  mkdirSync(game, { recursive: true })
  await pickFolderWill(app, game)
  await page.getByRole('button', { name: 'Choose folder…' }).click()
  await expect(page.getByTestId('chosen-folder')).toContainText('bible')
  await page
    .getByRole('radio', { name: new RegExp(`^${kitNames[kit].replace(/[/]/g, '\\/')}`) })
    .check()
  await page.getByRole('button', { name: 'Create bible' }).click()
  const question = page.getByRole('dialog', { name: 'What should players feel?' })
  await expect(question).toBeVisible()
  if (answer === null) {
    await question.getByRole('button', { name: 'Skip' }).click()
  } else {
    await question.getByRole('textbox', { name: 'What should players feel?' }).fill(answer)
    await question.getByRole('button', { name: 'Add first pillar' }).click()
  }
  await expect(question).toHaveCount(0)
}

async function newEntry(page: Page, section: string, title: string) {
  await page.getByRole('button', { name: `New entry in ${section}` }).click()
  await page.getByRole('textbox', { name: 'New entry title' }).fill(title)
  await page.getByRole('textbox', { name: 'New entry title' }).press('Enter')
  await expect(page.getByRole('textbox', { name: 'Entry title', exact: true })).toHaveValue(title)
}

const editor = (page: Page) => page.getByRole('textbox', { name: 'Entry text' })
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveText('Saved')
const entryButton = (page: Page, title: string) =>
  page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: title, exact: true })

async function vaultId(page: Page): Promise<number> {
  const reply = (await page.evaluate(() => window.loam.invoke('bible:home', {}))) as {
    ok: true
    data: { current: { vault: { id: number } } }
  }
  return reply.data.current.vault.id
}

async function invoke<T>(page: Page, channel: string, payload: unknown): Promise<T> {
  const reply = (await page.evaluate(([name, body]) => window.loam.invoke(name, body), [
    channel,
    payload,
  ] as const)) as { ok: boolean; data: T; error?: unknown }
  if (!reply.ok) throw new Error(`${channel}: ${JSON.stringify(reply.error)}`)
  return reply.data
}

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

test('creating a vault with each starter kit writes the documented layout', async () => {
  const { app, page } = await launchApp()
  await openBible(page)
  const kits = Object.keys(kitNames) as Array<keyof typeof kitNames>
  for (const [index, kit] of kits.entries()) {
    if (index > 0) {
      await page.getByRole('button', { name: 'Switch bible…' }).click()
    }
    const game = join(root, `game-${kit}`)
    await createVault(
      app,
      page,
      game,
      kit,
      index === 0 ? 'Wonder at a world that is beautiful and deadly' : null,
    )
    const vault = join(game, 'bible')
    const config = JSON.parse(readFileSync(join(vault, 'bible.json'), 'utf8')) as {
      format: number
      kit: string
      title: string
      sections: Array<{ id: string; name: string }>
    }
    expect(config).toMatchObject({ format: 1, kit, title: `game-${kit}` })
    const ids = config.sections.map((section) => section.id)
    expect(ids).toEqual(expect.arrayContaining(['pillars', 'decisions', 'ideas']))
    expect(readFileSync(join(vault, 'README.md'), 'utf8')).toContain('## For AI agents')
    for (const id of ids) expect(existsSync(join(vault, id))).toBe(true)
    await expect(page.getByRole('navigation', { name: 'Sections' })).toContainText(
      config.sections[0]!.name,
    )
  }
  // The first-run answer became the first pillar (Slice 5b: a short name, suggested
  // from the answer's first words; the full answer under the Pillar template's first heading).
  const pillar = readFileSync(
    join(root, 'game-blank', 'bible', 'pillars', 'wonder-at-a-world.md'),
    'utf8',
  )
  expect(pillar).toMatch(
    /^---\nid: [a-z2-9]{12}\ntitle: Wonder at a world\ntags: \[\]\norder: 1\ncreated: .+\nupdated: .+\n---\n## What players should feel\n\nWonder at a world that is beautiful and deadly\n\n## What this looks like in play\n\n## What this rules out\n$/,
  )
  // Skipping the question leaves the pillars empty.
  expect(readdirSync(join(root, 'game-cozy-sim', 'bible', 'pillars'))).toEqual([])
})

test('typing autosaves; killing the app 2 s after the last keystroke loses nothing; restart reopens the entry', async () => {
  const game = join(root, 'Ashfall')
  let { app, page } = await launchApp()
  await openBible(page)
  await createVault(app, page, game, 'narrative-adventure', null)
  await newEntry(page, 'Characters', 'Rowan')
  await editor(page).click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\nRowan dreams of the Nightmoor.')
  await page.waitForTimeout(2000)
  await killApp(app)
  const file = join(game, 'bible', 'characters', 'rowan.md')
  expect(readFileSync(file, 'utf8')).toContain('Rowan dreams of the Nightmoor.')

  ;({ app, page } = await launchApp())
  await openBible(page)
  await expect(page.getByRole('textbox', { name: 'Entry title', exact: true })).toHaveValue('Rowan')
  await expect(editor(page)).toHaveValue(/Rowan dreams of the Nightmoor\./)
  await expect(page.getByTestId('entry-preview')).toContainText('Rowan dreams of the Nightmoor.')
})

test('a kill in the middle of a save never leaves a half-written entry', async () => {
  const game = join(root, 'Ashfall')
  let { app, page } = await launchApp()
  await openBible(page)
  await createVault(app, page, game, 'blank', null)
  await newEntry(page, 'Ideas', 'Big')
  const folder = join(game, 'bible', 'ideas')
  const file = join(folder, 'big.md')
  // Large bodies make the write long enough to kill the app inside it.
  const versionA = `${'A'.repeat(4_000_000)}\n`
  const versionB = `${'B'.repeat(4_000_000)}\n`
  await editor(page).fill(versionA)
  await saved(page)
  await editor(page).fill(versionB)
  // Kill as soon as the temporary file of the atomic write appears.
  const started = Date.now()
  while (!readdirSync(folder).some((name) => name.endsWith('.um-tmp'))) {
    if (Date.now() - started > 10_000) throw new Error('the save never started')
  }
  await killApp(app)
  const text = readFileSync(file, 'utf8')
  const body = text.slice(text.indexOf('\n---\n') + 5)
  expect([versionA, versionB]).toContain(body)
  expect(text.startsWith('---\nid: ')).toBe(true)

  // Reopening removes the leftover temporary file and shows a whole entry.
  ;({ app, page } = await launchApp())
  await openBible(page)
  await expect(page.getByRole('textbox', { name: 'Entry title', exact: true })).toHaveValue('Big')
  expect(readdirSync(folder).filter((name) => name.endsWith('.um-tmp'))).toEqual([])
})

test('links autocomplete, open, create; renaming rewrites links and keeps backlinks', async () => {
  const game = join(root, 'Ashfall')
  const { app, page } = await launchApp()
  await openBible(page)
  await createVault(app, page, game, 'narrative-adventure', null)
  await newEntry(page, 'World', 'The Ashfall')
  await newEntry(page, 'Characters', 'Rowan')
  await editor(page).fill('')
  await editor(page).pressSequentially('Rowan wants to reach [[the as')
  await expect(page.getByRole('listbox', { name: 'Link to entry' })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(editor(page)).toHaveValue('Rowan wants to reach [[The Ashfall]]')
  await editor(page).pressSequentially(' and meet [[Oriel]].')
  await saved(page)

  const preview = page.getByTestId('entry-preview')
  await expect(preview.locator('a.wiki-link:not(.missing)')).toHaveText('The Ashfall')
  await expect(preview.locator('a.wiki-link.missing')).toHaveText('Oriel')

  // A link opens its entry, which lists Rowan under "Linked from".
  await preview.getByText('The Ashfall').click()
  await expect(page.getByRole('textbox', { name: 'Entry title', exact: true })).toHaveValue(
    'The Ashfall',
  )
  await expect(page.getByTestId('backlinks')).toHaveText('Rowan')

  // Rename: the link in Rowan's file follows, and the backlink stays.
  await page.getByRole('textbox', { name: 'Entry title', exact: true }).fill('The Deep Quarry')
  await page.getByRole('textbox', { name: 'Entry title', exact: true }).press('Enter')
  await expect(page.getByTestId('toast-text')).toHaveText('Renamed; updated 1 link')
  await expect(page.getByTestId('backlinks')).toHaveText('Rowan')
  expect(existsSync(join(game, 'bible', 'world', 'the-deep-quarry.md'))).toBe(true)
  expect(existsSync(join(game, 'bible', 'world', 'the-ashfall.md'))).toBe(false)
  expect(readFileSync(join(game, 'bible', 'characters', 'rowan.md'), 'utf8')).toContain(
    'Rowan wants to reach [[The Deep Quarry]] and meet [[Oriel]].',
  )

  // A dashed link creates the entry it names, in the section picked (here: Rowan's own).
  await page.getByTestId('backlinks').getByRole('button', { name: 'Rowan' }).click()
  await page.getByTestId('entry-preview').locator('a.wiki-link.missing').click()
  const picker = page.getByRole('dialog', { name: 'Create entry' })
  await expect(picker.getByRole('radio', { name: 'Characters' })).toBeChecked()
  await picker.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('textbox', { name: 'Entry title', exact: true })).toHaveValue('Oriel')
  expect(existsSync(join(game, 'bible', 'characters', 'oriel.md'))).toBe(true)
  await entryButton(page, 'Rowan').click()
  await expect(page.getByTestId('entry-preview').locator('a.wiki-link.missing')).toHaveCount(0)
})

test('outside edits update search and backlinks within a second; unsaved edits get the conflict banner', async () => {
  const game = join(root, 'Ashfall')
  const { app, page } = await launchApp()
  await openBible(page)
  await createVault(app, page, game, 'narrative-adventure', null)
  await newEntry(page, 'World', 'The Ashfall')
  await saved(page)

  // Another editor (or git, or a coding agent) adds a file that links here.
  const started = Date.now()
  writeFileSync(
    join(game, 'bible', 'story', 'descent.md'),
    '---\ntitle: Descent\n---\nThe wayfinders climb down into [[The Ashfall]] to find curse-proof relics.\n',
  )
  await expect(page.getByTestId('backlinks')).toHaveText('Descent', { timeout: 1000 })
  await page.getByRole('searchbox', { name: 'Search the bible' }).fill('relics')
  await expect(page.getByTestId('search-results').getByRole('button')).toHaveCount(1, {
    timeout: 1000,
  })
  expect(Date.now() - started).toBeLessThan(2000)
  await page.getByRole('searchbox', { name: 'Search the bible' }).fill('')

  // With no unsaved edits, the open entry reloads silently.
  const ashfall = join(game, 'bible', 'world', 'the-ashfall.md')
  writeFileSync(ashfall, readFileSync(ashfall, 'utf8') + '\nEdited elsewhere.\n')
  await expect(editor(page)).toHaveValue(/Edited elsewhere\./)
  await expect(page.getByTestId('conflict-banner')).toHaveCount(0)

  // With unsaved edits, a banner asks; "Load theirs" takes the file.
  await editor(page).pressSequentially('\nMine, not saved yet.')
  writeFileSync(
    ashfall,
    readFileSync(ashfall, 'utf8').replace('Edited elsewhere.', 'Theirs, from git.'),
  )
  await expect(page.getByTestId('conflict-banner')).toBeVisible()
  await page.getByRole('button', { name: 'Load theirs' }).click()
  await expect(editor(page)).toHaveValue(/Theirs, from git\./)
  await expect(editor(page)).not.toHaveValue(/Mine, not saved yet/)

  // "Keep mine" writes the app's text over theirs.
  await editor(page).pressSequentially('\nMine again.')
  writeFileSync(
    ashfall,
    readFileSync(ashfall, 'utf8').replace('Theirs, from git.', 'Theirs twice.'),
  )
  await expect(page.getByTestId('conflict-banner')).toBeVisible()
  // Nothing was overwritten while the banner waits.
  await page.waitForTimeout(800)
  expect(readFileSync(ashfall, 'utf8')).toContain('Theirs twice.')
  await page.getByRole('button', { name: 'Keep mine' }).click()
  await expect(page.getByTestId('conflict-banner')).toHaveCount(0)
  await saved(page)
  expect(readFileSync(ashfall, 'utf8')).toContain('Mine again.')
  expect(readFileSync(ashfall, 'utf8')).not.toContain('Theirs twice.')
})

test('search finds entries; delete moves to .trash and Undo brings the entry back', async () => {
  const game = join(root, 'Ashfall')
  const { app, page } = await launchApp()
  await openBible(page)
  await createVault(app, page, game, 'blank', null)
  await newEntry(page, 'Ideas', 'Rope physics')
  await editor(page).fill('Climbing ropes that swing with real momentum.')
  await saved(page)
  await newEntry(page, 'Ideas', 'Lantern fuel')
  await editor(page).fill('Light as a resource that runs out.')
  await saved(page)

  const search = page.getByRole('searchbox', { name: 'Search the bible' })
  await search.fill('momentum')
  const results = page.getByTestId('search-results').getByRole('button')
  await expect(results).toHaveCount(1)
  await expect(results.first()).toContainText('Rope physics')
  await results.first().click()
  await expect(page.getByRole('textbox', { name: 'Entry title', exact: true })).toHaveValue(
    'Rope physics',
  )
  await search.fill('')

  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: /^Delete/ }).click()
  await expect(page.getByTestId('toast-text')).toHaveText('Moved “Rope physics” to .trash')
  expect(existsSync(join(game, 'bible', '.trash', 'ideas', 'rope-physics.md'))).toBe(true)
  expect(existsSync(join(game, 'bible', 'ideas', 'rope-physics.md'))).toBe(false)
  await expect(entryButton(page, 'Rope physics')).toHaveCount(0)
  await search.fill('momentum')
  await expect(page.getByTestId('search-results')).toContainText('No entries match.')
  await search.fill('')

  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByRole('textbox', { name: 'Entry title', exact: true })).toHaveValue(
    'Rope physics',
  )
  expect(existsSync(join(game, 'bible', 'ideas', 'rope-physics.md'))).toBe(true)
  expect(readdirSync(join(game, 'bible', '.trash', 'ideas'))).toEqual([])
  await search.fill('momentum')
  await expect(page.getByTestId('search-results').getByRole('button')).toHaveCount(1)
})

test('deleting the index and reopening rebuilds identical search and link results', async () => {
  const game = join(root, 'Ashfall')
  let { app, page } = await launchApp()
  await openBible(page)
  await createVault(app, page, game, 'narrative-adventure', 'Awe before fear')
  for (const [section, title, body] of [
    ['World', 'The Ashfall', 'A vertical world of layers and curses.'],
    ['Characters', 'Rowan', 'An apprentice who wants to reach [[The Ashfall]].'],
    ['Story', 'Descent', 'Rowan and [[Reg]] go down into [[The Ashfall]].'],
  ] as const) {
    await newEntry(page, section, title)
    await editor(page).fill(body)
    await saved(page)
  }
  const id = await vaultId(page)
  const snapshot = async () => ({
    view: await invoke(page, 'bible:view', { vaultId: id }),
    search: await Promise.all(
      ['ashfall', 'curses', 'apprentice', 'awe'].map((text) =>
        invoke(page, 'bible:search', { vaultId: id, text }),
      ),
    ).then((replies) => replies.map((reply) => (reply as { hits: unknown }).hits)),
    backlinks: await Promise.all(
      ['world/the-ashfall.md', 'characters/rowan.md'].map((path) =>
        invoke<{ backlinks: unknown }>(page, 'bible:entry', { vaultId: id, path }),
      ),
    ).then((entries) => entries.map((entry) => entry.backlinks)),
  })
  const before = await snapshot()
  expect(before.backlinks[0]).toEqual([
    { path: 'story/descent.md', title: 'Descent' },
    { path: 'characters/rowan.md', title: 'Rowan' },
  ])
  await closeAll()

  const db = new DatabaseSync(join(localAppData, 'Loam', 'loam.db'))
  db.exec('DELETE FROM bible_fts; DELETE FROM bible_links; DELETE FROM bible_entries;')
  expect(db.prepare('SELECT COUNT(*) AS n FROM bible_entries').get()).toEqual({ n: 0 })
  db.close()

  ;({ app, page } = await launchApp())
  await openBible(page)
  await expect(entryButton(page, 'Rowan')).toBeVisible()
  const after = await snapshot()
  expect({ ...after, view: { ...(after.view as object), lastEntry: null } }).toEqual({
    ...before,
    view: { ...(before.view as object), lastEntry: null },
  })
})

test('unknown front matter and unknown files survive edits and renames in the app', async () => {
  const game = join(root, 'Ashfall')
  const vault = join(game, 'bible')
  mkdirSync(join(vault, 'world'), { recursive: true })
  mkdirSync(join(vault, '.obsidian'), { recursive: true })
  writeFileSync(
    join(vault, 'bible.json'),
    JSON.stringify(
      {
        format: 1,
        title: 'Ashfall',
        kit: 'blank',
        sections: [{ id: 'world', name: 'World' }],
        theme: 'dusk',
      },
      null,
      2,
    ),
  )
  const frontMatter = [
    '---',
    'id: ashfall0000001',
    'title: The Ashfall',
    '# a comment from my other editor',
    'mood:',
    '  primary: awe',
    '  layers: [1, 2, 3]',
    'tags: [world]',
    'order: 1',
    'created: 2026-01-01T00:00:00.000Z',
    'updated: 2026-01-01T00:00:00.000Z',
    'custom_field: "keep me"',
    '---',
  ]
  writeFileSync(
    join(vault, 'world', 'the-ashfall.md'),
    [...frontMatter, 'Old body.', ''].join('\n'),
  )
  const unknown = {
    'notes.txt': 'my notes',
    'world/map.png': 'not really a png',
    '.obsidian/workspace.json': '{"a":1}',
    'drafts/loose.md': '# not an entry',
  }
  for (const [rel, text] of Object.entries(unknown)) {
    mkdirSync(join(vault, ...rel.split('/').slice(0, -1)), { recursive: true })
    writeFileSync(join(vault, ...rel.split('/')), text)
  }
  const hashes = Object.keys(unknown).map((rel) => sha(join(vault, ...rel.split('/'))))

  const { app, page } = await launchApp()
  await openBible(page)
  await pickFolderWill(app, game)
  await page.getByRole('button', { name: 'Open folder…' }).click()
  await entryButton(page, 'The Ashfall').click()
  await expect(editor(page)).toHaveValue('Old body.\n')
  await editor(page).fill('New body.\n')
  await saved(page)
  await page.getByRole('textbox', { name: 'Entry title', exact: true }).fill('The Pit')
  await page.getByRole('textbox', { name: 'Entry title', exact: true }).press('Enter')
  await expect(page.getByTestId('toast-text')).toHaveText('Renamed')
  await page.getByRole('button', { name: 'New entry in World' }).click()
  await page.getByRole('textbox', { name: 'New entry title' }).fill('Zone 1')
  await page.getByRole('textbox', { name: 'New entry title' }).press('Enter')
  await saved(page)

  const text = readFileSync(join(vault, 'world', 'the-pit.md'), 'utf8')
  const lines = text.split('\n')
  // Every front-matter line except title and updated is byte for byte the same.
  expect(lines.slice(0, 13)).toEqual(
    frontMatter.map((line) =>
      line.startsWith('title:')
        ? 'title: The Pit'
        : line.startsWith('updated:')
          ? expect.stringMatching(/^updated: 2026-\d\d-\d\dT/)
          : line,
    ),
  )
  expect(lines.slice(13).join('\n')).toBe('New body.\n')
  expect(Object.keys(unknown).map((rel) => sha(join(vault, ...rel.split('/'))))).toEqual(hashes)
  expect(JSON.parse(readFileSync(join(vault, 'bible.json'), 'utf8')).theme).toBe('dusk')
})

test('search over 500 entries returns in under 50 ms', async () => {
  const vault = join(root, 'Big', 'bible')
  mkdirSync(join(vault, 'ideas'), { recursive: true })
  writeFileSync(
    join(vault, 'bible.json'),
    JSON.stringify({
      format: 1,
      title: 'Big',
      kit: 'blank',
      sections: [{ id: 'ideas', name: 'Ideas' }],
    }),
  )
  const words = ['lantern', 'rope', 'curse', 'relic', 'wayfinder', 'layer', 'climb', 'ashfall']
  for (let index = 0; index < 500; index++) {
    const body = Array.from(
      { length: 120 },
      (_, word) => words[(index * 7 + word * 3) % words.length],
    ).join(' ')
    writeFileSync(
      join(vault, 'ideas', `idea-${index}.md`),
      `---\nid: idea${String(index).padStart(8, '0')}\ntitle: Idea ${index}\n---\n${body} marker${index}\n`,
    )
  }
  const { app, page } = await launchApp()
  await openBible(page)
  await pickFolderWill(app, vault)
  await page.getByRole('button', { name: 'Open folder…' }).click()
  await expect(page.locator('[data-section="ideas"] .bible-entry')).toHaveCount(500)
  const id = await vaultId(page)
  const timings = await page.evaluate(async (target) => {
    const out: Array<{ server: number; roundTrip: number; hits: number }> = []
    for (const text of [
      'lantern',
      'curse relic',
      'marker250',
      'clim',
      'idea 42',
      'ashfall wayfinder',
    ]) {
      const started = performance.now()
      const reply = (await window.loam.invoke('bible:search', {
        vaultId: target,
        text,
      })) as {
        data: { hits: unknown[]; ms: number }
      }
      out.push({
        server: reply.data.ms,
        roundTrip: performance.now() - started,
        hits: reply.data.hits.length,
      })
    }
    return out
  }, id)
  console.log(`[bible] search over 500 entries: ${JSON.stringify(timings)}`)
  for (const timing of timings) {
    expect(timing.hits).toBeGreaterThan(0)
    expect(timing.roundTrip).toBeLessThan(50)
  }
})
