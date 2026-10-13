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
import { dirname, join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { drop, makeImageTransfer } from './fixtures.ts'
import { assertBuilt, launchApp as launch } from './launch.ts'

// Test vaults live in the system temp folder, never inside the repository.
let root: string
let running: ElectronApplication[] = []

test.beforeAll(() => {
  assertBuilt()
})

test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'loam-e2e-bible5c-'))
})

test.afterEach(async () => {
  await closeAll()
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

/** Launches with its own %LOCALAPPDATA%; the References screen shows first. */
async function launchApp(appData: string): Promise<{ app: ElectronApplication; page: Page }> {
  mkdirSync(appData, { recursive: true })
  const app = await launch(appData)
  running.push(app)
  const page = await app.firstWindow()
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible()
  return { app, page }
}

async function closeAll() {
  for (const app of running) await app.close().catch(() => undefined)
  running = []
}

async function openBible(page: Page) {
  await page.getByRole('button', { name: 'Bible', exact: true }).click()
}

async function pickFolderWill(app: ElectronApplication, folder: string) {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [picked],
    })) as unknown as typeof dialog.showOpenDialog
  }, folder)
}

/** Creates an Atmospheric / horror vault in <game>/bible with one pillar. */
async function createHorrorVault(app: ElectronApplication, page: Page, game: string) {
  mkdirSync(game, { recursive: true })
  await openBible(page)
  await pickFolderWill(app, game)
  await page.getByRole('button', { name: 'Choose folder…' }).click()
  await page.getByRole('radio', { name: /^Atmospheric \/ horror/ }).check()
  await page.getByRole('button', { name: 'Create bible' }).click()
  const question = page.getByRole('dialog', { name: 'What should players feel?' })
  await question
    .getByRole('textbox', { name: 'What should players feel?' })
    .fill('Dread of what waits below')
  await question.getByRole('textbox', { name: 'Name it in 2–4 words' }).fill('Dread below')
  await question.getByRole('button', { name: 'Add first pillar' }).click()
  await expect(question).toHaveCount(0)
}

async function openFolder(app: ElectronApplication, page: Page, folder: string) {
  await openBible(page)
  await pickFolderWill(app, folder)
  await page.getByRole('button', { name: 'Open folder…' }).click()
}

async function newEntry(page: Page, section: string, title: string) {
  await page.getByRole('button', { name: `New entry in ${section}` }).click()
  await page.getByRole('textbox', { name: 'New entry title' }).fill(title)
  await page.getByRole('textbox', { name: 'New entry title' }).press('Enter')
  await expect(titleBox(page)).toHaveValue(title)
}

const titleBox = (page: Page) => page.getByRole('textbox', { name: 'Entry title', exact: true })
const editor = (page: Page) => page.getByRole('textbox', { name: 'Entry text' })
const preview = (page: Page) => page.getByTestId('entry-preview')
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveText('Saved')
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sections' })
const entryButton = (page: Page, title: string) =>
  sidebar(page).getByRole('button', { name: title, exact: true })
const pillarCheck = (page: Page) =>
  page.getByRole('group', { name: 'Which pillars does this serve?' })
const sectionHeading = (page: Page, section: string) =>
  page.locator(`[data-section="${section}"] .bible-section-link`)
const read = (path: string) => readFileSync(path, 'utf8')
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const frontValue = (text: string, key: string) =>
  new RegExp(`^${key}:(.*)$`, 'm').exec(text)?.[1]?.trim() ?? null

/** Every file under a folder, with its hash. */
function hashTree(folder: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string, prefix: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name
      if (item.isDirectory()) walk(join(dir, item.name), rel)
      else out[rel] = sha(read(join(dir, item.name)))
    }
  }
  walk(folder, '')
  return out
}

/** True once the image has decoded with real pixels. */
const imageLoaded = (page: Page) =>
  preview(page)
    .locator('img.md-local-image')
    .first()
    .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)

test('decision log, pillar check, idea board, promote with undo and review', async () => {
  const game = join(root, 'Dream')
  const vault = join(game, 'bible')
  const { app, page } = await launchApp(join(root, 'appdata'))
  await createHorrorVault(app, page, game)
  const pillarFile = readdirSync(join(vault, 'pillars'))[0] ?? ''
  const pillarId = frontValue(read(join(vault, 'pillars', pillarFile)), 'id')

  // A new decision: dated today, decided, the kit's body template, no pillar yet.
  await newEntry(page, 'Decisions', 'Mute the music')
  const decisionFile = join(vault, 'decisions', 'mute-the-music.md')
  let text = read(decisionFile)
  expect(frontValue(text, 'date')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(frontValue(text, 'status')).toBe('decided')
  expect(text).toContain('## Decision\n')
  await expect(page.getByTestId('no-pillar')).toBeVisible()

  // Tick the pillar: stored by id in front matter only; saving was never blocked.
  await pillarCheck(page).getByRole('button', { name: 'Dread below' }).click()
  await expect(pillarCheck(page).getByRole('button', { name: 'Dread below' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByTestId('no-pillar')).toHaveCount(0)
  await saved(page)
  text = read(decisionFile)
  expect(frontValue(text, 'pillars')).toBe(`[${pillarId}]`)
  expect(text.split('---\n').slice(2).join('---\n')).not.toContain(pillarId)

  // A hand edit elsewhere in the file keeps the link and adds an alternative.
  writeFileSync(
    decisionFile,
    text
      .replace(/^alternatives:.*$/m, 'alternatives: [A quiet score]')
      .replace('## Why\n', '## Why\n\nSilence is louder.\n'),
  )
  await expect(page.getByRole('group', { name: 'Alternatives' })).toContainText('A quiet score')
  await expect(pillarCheck(page).getByRole('button', { name: 'Dread below' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  // A second decision serves no pillar; the log lists both, newest first.
  await newEntry(page, 'Decisions', 'Drop the map')
  await sectionHeading(page, 'decisions').click()
  const log = page.getByRole('region', { name: 'Decision log' })
  await expect(log.locator('.timeline-item .pillar-title')).toHaveText([
    'Drop the map',
    'Mute the music',
  ])
  await expect(log.locator('.timeline-item').nth(0)).toContainText('Serves no pillar')
  await expect(log.locator('.timeline-item').nth(1)).toContainText('Dread below')

  // An idea is parked; the board moves it between columns.
  await newEntry(page, 'Ideas', 'Lantern oil')
  expect(frontValue(read(join(vault, 'ideas', 'lantern-oil.md')), 'status')).toBe('parked')
  await sectionHeading(page, 'ideas').click()
  const board = page.getByRole('region', { name: 'Idea board' })
  const column = (name: string) => board.getByRole('region', { name })
  await expect(column('Parked')).toContainText('Lantern oil')
  await board.getByRole('button', { name: 'Drop Lantern oil' }).click()
  await expect(column('Dropped')).toContainText('Lantern oil')
  await board.getByRole('button', { name: 'Park Lantern oil' }).click()
  await expect(column('Parked')).toContainText('Lantern oil')

  // Review lists every decision and idea with no pillar.
  await page.getByRole('button', { name: /^Serves no pillar/ }).click()
  await expect(page.getByTestId('review-list').getByRole('button')).toHaveText([
    'Drop the map',
    'Lantern oil',
  ])

  // Promote: creates the decision, links both ways, marks the idea promoted.
  const ideaFile = join(vault, 'ideas', 'lantern-oil.md')
  const ideaBefore = read(ideaFile)
  const ideaId = frontValue(ideaBefore, 'id')
  await sectionHeading(page, 'ideas').click()
  await board.getByRole('button', { name: 'Promote Lantern oil' }).click()
  const promote = page.getByRole('dialog', { name: 'Promote idea' })
  await expect(promote.getByRole('textbox', { name: 'Title' })).toHaveValue(
    'Lantern oil (decision)',
  )
  await promote.getByRole('button', { name: 'Promote' }).click()
  await expect(titleBox(page)).toHaveValue('Lantern oil (decision)')
  await expect(page.locator('.entry-markers')).toContainText('Promoted from Lantern oil')
  const targetFile = join(vault, 'decisions', 'lantern-oil-decision.md')
  const target = read(targetFile)
  expect(frontValue(target, 'promoted_from')).toBe(ideaId)
  expect(frontValue(target, 'status')).toBe('decided')
  const idea = read(ideaFile)
  expect(frontValue(idea, 'status')).toBe('promoted')
  expect(frontValue(idea, 'promoted_to')).toBe(frontValue(target, 'id'))

  // One undo takes both back: the idea is byte-identical again.
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(entryButton(page, 'Lantern oil (decision)')).toHaveCount(0)
  expect(existsSync(targetFile)).toBe(false)
  expect(read(ideaFile)).toBe(ideaBefore)

  // Promote from the entry page into a regular section.
  await entryButton(page, 'Lantern oil').click()
  await page.getByRole('button', { name: 'Promote…' }).click()
  await promote.getByRole('combobox', { name: 'Into' }).selectOption('world')
  await expect(promote.getByRole('textbox', { name: 'Title' })).toHaveValue('Lantern oil')
  await promote.getByRole('textbox', { name: 'Title' }).fill('Oil lanterns')
  await promote.getByRole('button', { name: 'Promote' }).click()
  await expect(titleBox(page)).toHaveValue('Oil lanterns')
  expect(frontValue(read(join(vault, 'world', 'oil-lanterns.md')), 'promoted_from')).toBe(ideaId)
  await page.getByRole('button', { name: 'Lantern oil', exact: true }).last().click()
  await expect(titleBox(page)).toHaveValue('Lantern oil')
  await expect(page.locator('.entry-markers')).toContainText('Promoted to Oil lanterns')

  // The pillar shows what serves it, on its card and on its page.
  await sectionHeading(page, 'pillars').click()
  await expect(page.getByTestId('pillar-counts')).toHaveText('1 decision · 0 ideas')
  await entryButton(page, 'Dread below').click()
  await expect(page.getByTestId('served-by')).toContainText('Decisions (1)')
  await expect(page.getByTestId('served-by')).toContainText('Mute the music')
})

test('Library images become vault references; links ask first; a clone shows the same', async () => {
  const game = join(root, 'Dream')
  const vault = join(game, 'bible')
  const { app, page } = await launchApp(join(root, 'appdata'))
  await expect(page.getByRole('heading', { name: 'All references' })).toBeVisible()
  await drop(page, await makeImageTransfer(page, [1, 2]))
  await expect(page.getByTestId('ref-card')).toHaveCount(2)

  await createHorrorVault(app, page, game)
  await newEntry(page, 'Decisions', 'Lamps only')
  await pillarCheck(page).getByRole('button', { name: 'Dread below' }).click()
  await saved(page)

  // Drag a Library image onto a World entry: copied to _assets, linked in text.
  await newEntry(page, 'World', 'The shaft')
  await page.getByRole('button', { name: 'References' }).click()
  const library = page.getByRole('complementary', { name: 'References' })
  await expect(library.getByTestId('library-item')).toHaveCount(2)
  await library.getByTestId('library-item').first().dragTo(editor(page))
  await expect(editor(page)).toHaveValue(/!\[[^\]]*\]\(\.\.\/_assets\/[0-9a-f]{64}\.\w+\)\n/)
  await saved(page)
  const assets = readdirSync(join(vault, '_assets'))
  expect(assets).toHaveLength(1)
  const shaft = read(join(vault, 'world', 'the-shaft.md'))
  expect(frontValue(shaft, 'references')).toBe(`[_assets/${assets[0]}]`)

  // The preview renders the vault image through the path-checked scheme.
  await expect.poll(() => imageLoaded(page)).toBe(true)

  // External links open only after a confirm that shows the full URL.
  await app.evaluate(({ shell }) => {
    const opened: string[] = []
    ;(globalThis as { opened?: string[] }).opened = opened
    shell.openExternal = (async (url: string) => {
      opened.push(url)
    }) as typeof shell.openExternal
  })
  await editor(page).press('Control+End')
  await editor(page).pressSequentially('See [the mine](https://example.com/mine?depth=6).')
  await saved(page)
  await preview(page).getByRole('link', { name: 'the mine' }).click()
  const confirm = page.getByRole('dialog', { name: 'Open link' })
  await expect(confirm.getByTestId('external-url')).toHaveText('https://example.com/mine?depth=6')
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await preview(page).getByRole('link', { name: 'the mine' }).click()
  await confirm.getByRole('button', { name: 'Open in browser' }).click()
  await expect
    .poll(() => app.evaluate(() => (globalThis as { opened?: string[] }).opened))
    .toEqual(['https://example.com/mine?depth=6'])

  // The Library detail lists where the image is used.
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: 'Library' })
    .click()
  await expect(page.getByRole('heading', { name: 'All references' })).toBeVisible()
  await page.getByTestId('ref-card').first().click()
  await expect(page.getByTestId('bible-uses')).toContainText('The shaft')

  // A clone in another folder, with an empty Library: same image, same pillar views.
  await closeAll()
  const clone = join(root, 'Elsewhere', 'bible')
  mkdirSync(dirname(clone), { recursive: true })
  cpSync(vault, clone, { recursive: true })
  const second = await launchApp(join(root, 'appdata-clone'))
  await openFolder(second.app, second.page, clone)
  await entryButton(second.page, 'The shaft').click()
  await expect.poll(() => imageLoaded(second.page)).toBe(true)
  await sectionHeading(second.page, 'pillars').click()
  await expect(second.page.getByTestId('pillar-counts')).toHaveText('1 decision · 0 ideas')
  await entryButton(second.page, 'Dread below').click()
  await expect(second.page.getByTestId('served-by')).toContainText('Lamps only')
})

/** A vault as the Slice 5a build wrote it: no fields in bible.json, 5a front matter. */
function write5aVault(vault: string) {
  const day = 24 * 60 * 60 * 1000
  const iso = (offset: number) => new Date(Date.now() - offset * day).toISOString()
  const files: Record<string, string> = {
    'bible.json': `${JSON.stringify(
      {
        format: 1,
        title: 'Dream',
        kit: 'atmospheric-horror',
        sections: [
          'Pillars',
          'Atmosphere',
          'World',
          'Creatures',
          'Story',
          'Decisions',
          'Ideas',
        ].map((name) => ({ id: name.toLowerCase(), name })),
      },
      null,
      2,
    )}\n`,
    'README.md': '# Dream\n',
    'creatures/hermit.md': `---\nid: herm00000001\ntitle: Hermit\ntags: []\norder: 1\ncreated: ${iso(200)}\nupdated: ${iso(200)}\n---\n## What it is\n\nSmall and patient.\n`,
    'world/old-shore.md': `---\nid: shor00000001\ntitle: Old shore\ntags: []\norder: 1\ncreated: ${iso(120)}\nupdated: ${iso(90)}\n---\n## Overview\n\nWhere the water was.\n`,
    'decisions/drain-the-lake.md': `---\nid: drai00000001\ntitle: Drain the lake\ntags: []\norder: 1\ncreated: ${iso(2)}\nupdated: ${iso(1)}\n---\n## Decision\n\nThe lake is gone; see [[Old shore]].\n`,
  }
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(vault, rel)), { recursive: true })
    writeFileSync(join(vault, rel), content)
  }
}

test('a 5a-built vault: kit update adds only fields; staleness shows quietly', async () => {
  const vault = join(root, 'Dream', 'bible')
  write5aVault(vault)
  const before = hashTree(vault)
  const appData = join(root, 'appdata')
  const { app, page } = await launchApp(appData)
  await openFolder(app, page, vault)
  await expect(entryButton(page, 'Hermit')).toBeVisible()
  expect(hashTree(vault)).toEqual(before)

  // An entry untouched for 90 days, linked from a decision changed since.
  await expect(page.locator('[data-section="world"] .stale-flag')).toHaveCount(1)
  await entryButton(page, 'Old shore').click()
  await expect(page.getByTestId('stale-marker')).toHaveText('May be out of date')
  await entryButton(page, 'Hermit').click()
  await expect(page.getByTestId('stale-marker')).toHaveCount(0)

  // The kit has fields this vault lacks: apply them all, leave the section out.
  await page.getByTestId('kit-notice').click()
  const dialog = page.getByRole('dialog', { name: 'Kit updates' })
  await expect(dialog.getByRole('checkbox')).toHaveCount(5)
  await dialog.getByRole('button', { name: 'Add selected' }).click()
  await expect(page.getByTestId('toast-text')).toHaveText('Added from the starter kit')
  await expect(page.getByTestId('kit-notice')).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Threat' })).toBeVisible()

  const after = hashTree(vault)
  for (const rel of Object.keys(before)) {
    if (rel !== 'bible.json') expect(after[rel], rel).toBe(before[rel])
  }
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
  const config = JSON.parse(read(join(vault, 'bible.json'))) as {
    sections: Array<{ id: string; fields?: Array<{ key: string }> }>
  }
  const keys = (id: string) => config.sections.find((s) => s.id === id)?.fields?.map((f) => f.key)
  expect(keys('creatures')).toEqual(['threat', 'habitat'])
  expect(keys('world')).toEqual(['depth', 'mood'])
  expect(keys('atmosphere')).toEqual(['mood'])

  // The notice does not come back.
  await closeAll()
  const again = await launchApp(appData)
  // The app reopens the last bible by itself.
  await openBible(again.page)
  await expect(entryButton(again.page, 'Hermit')).toBeVisible()
  await expect(again.page.getByTestId('kit-notice')).toHaveCount(0)
})

test('missing links pick a section; a template-only move offers the new template', async () => {
  const game = join(root, 'Dream')
  const vault = join(game, 'bible')
  const { app, page } = await launchApp(join(root, 'appdata'))
  await createHorrorVault(app, page, game)

  // A missing link in prose: the picker suggests World, where "Floor 5" lives.
  await newEntry(page, 'World', 'Floor 5')
  await newEntry(page, 'Creatures', 'Pale hunter')
  await editor(page).press('Control+End')
  await editor(page).pressSequentially('\nLives on [[Floor 6]].')
  await saved(page)
  await preview(page).locator('a.wiki-link.missing').click()
  const picker = page.getByRole('dialog', { name: 'Create entry' })
  await expect(picker.getByRole('radio', { name: 'World' })).toBeChecked()
  await picker.getByRole('button', { name: 'Create' }).click()
  await expect(titleBox(page)).toHaveValue('Floor 6')
  const floor6 = read(join(vault, 'world', 'floor-6.md'))
  expect(floor6).toContain('## Overview\n')
  expect(floor6).toContain('## Rules of this world\n')

  // A missing name in a field limited to World is created there without asking.
  await entryButton(page, 'Pale hunter').click()
  const hunterFile = join(vault, 'creatures', 'pale-hunter.md')
  writeFileSync(hunterFile, read(hunterFile).replace(/^habitat:.*$/m, 'habitat: "[[Floor 7]]"'))
  await page.getByRole('button', { name: 'Create “Floor 7”' }).click()
  await expect(titleBox(page)).toHaveValue('Floor 7')
  await expect(page.getByRole('dialog', { name: 'Create entry' })).toHaveCount(0)
  expect(read(join(vault, 'world', 'floor-7.md'))).toContain('## Overview\n')

  // Template-only entry moved to World: the swap is offered; front-matter keys stay.
  await newEntry(page, 'Creatures', 'Wisp')
  await sidebar(page).getByRole('button', { name: 'Actions for Wisp' }).click()
  await page
    .getByRole('menu', { name: 'Actions for Wisp' })
    .getByRole('menuitem', { name: 'World' })
    .click()
  const swap = page.getByRole('alertdialog')
  await expect(swap).toContainText('Use the World template?')
  await swap.getByRole('button', { name: 'Use new template' }).click()
  await expect(page.getByTestId('toast-text')).toHaveText('Template swapped')
  const wisp = read(join(vault, 'world', 'wisp.md'))
  expect(wisp).toContain('## Rules of this world\n')
  expect(wisp).not.toContain('## What it wants')
  expect(wisp).toMatch(/^threat:/m)
  expect(wisp).toMatch(/^habitat:/m)
  await expect(editor(page)).toHaveValue(/## Rules of this world/)

  // A written entry moves without the offer.
  await newEntry(page, 'Creatures', 'Moth')
  await editor(page).press('Control+End')
  await editor(page).pressSequentially('\nIt eats light.')
  await saved(page)
  await sidebar(page).getByRole('button', { name: 'Actions for Moth' }).click()
  await page
    .getByRole('menu', { name: 'Actions for Moth' })
    .getByRole('menuitem', { name: 'World' })
    .click()
  await expect(page.getByTestId('toast-text')).toHaveText('Moved to World')
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  expect(read(join(vault, 'world', 'moth.md'))).toContain('It eats light.')
})
