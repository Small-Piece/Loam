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
import { dirname, join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { drop, makeImageTransfer } from './fixtures.ts'
import { assertBuilt, launchApp as launch } from './launch.ts'

// Journals and vaults live in the system temp folder: never in the repository
// and never in the real Documents folder (the suggested folder is only shown).
let root: string
let running: ElectronApplication[] = []

test.beforeAll(() => {
  assertBuilt()
})

test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'loam-e2e-journal-'))
})

test.afterEach(async () => {
  await closeAll()
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

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

async function pickFolderWill(app: ElectronApplication, folder: string) {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [picked],
    })) as unknown as typeof dialog.showOpenDialog
  }, folder)
}

const pad = (value: number) => String(value).padStart(2, '0')
/** The local calendar day, as the app computes it. */
const localDay = (at: Date) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
const daysAgo = (count: number) => {
  const at = new Date()
  at.setDate(at.getDate() - count)
  return localDay(at)
}

const openJournal = (page: Page) =>
  page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: 'Journal' })
    .click()
const todayPage = (page: Page) => page.getByRole('region', { name: 'Today' })
const titleBox = (page: Page) => page.getByRole('textbox', { name: 'Entry title', exact: true })
const editor = (page: Page) => page.getByRole('textbox', { name: 'Entry text' })
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sections' })
const entryButton = (page: Page, title: string) =>
  sidebar(page).getByRole('button', { name: title, exact: true })
const read = (path: string) => readFileSync(path, 'utf8')
const frontValue = (text: string, key: string) =>
  new RegExp(`^${key}:(.*)$`, 'm').exec(text)?.[1]?.trim() ?? null

/** Creates the journal in <root>/Journal through the start screen. */
async function createJournal(app: ElectronApplication, page: Page): Promise<string> {
  const folder = join(root, 'Journal')
  await openJournal(page)
  // The suggestion is shown, but tests always choose a temp folder.
  await expect(page.getByTestId('journal-folder')).toContainText('Loam Journal')
  await pickFolderWill(app, folder)
  await page.getByRole('button', { name: 'Choose folder…' }).click()
  await expect(page.getByTestId('journal-folder')).toHaveText(folder)
  await page.getByRole('button', { name: 'Create journal' }).click()
  await expect(todayPage(page)).toBeVisible()
  return folder
}

async function newEntry(page: Page, section: string, title: string) {
  await page.getByRole('button', { name: `New entry in ${section}` }).click()
  await page.getByRole('textbox', { name: 'New entry title' }).fill(title)
  await page.getByRole('textbox', { name: 'New entry title' }).press('Enter')
  await expect(titleBox(page)).toHaveValue(title)
}

function writeFile(path: string, text: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function sessionFile(id: string, title: string, fields: string, body: string): string {
  return `---\nid: ${id}\ntitle: ${title}\ntags: []\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\n${fields}---\n${body}`
}

// A valid 1×1 PNG, for practice images written by hand.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('create a journal, start a session from Today, and open the journal again', async () => {
  const appData = join(root, 'appdata')
  const { app, page } = await launchApp(appData)
  const folder = await createJournal(app, page)

  const config = JSON.parse(read(join(folder, 'bible.json'))) as {
    kit: string
    sections: Array<{ id: string; fields?: Array<{ key: string }> }>
  }
  expect(config.kit).toBe('journal')
  expect(config.sections.map((section) => section.id)).toEqual(['sessions', 'topics', 'resources'])
  expect(existsSync(join(folder, 'bible'))).toBe(false)
  await expect(page.getByTestId('kit-notice')).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'What should players feel?' })).toHaveCount(0)

  // Yesterday's session, written elsewhere: its "Next time" shows on Today.
  writeFile(
    join(folder, 'sessions', 'yesterday.md'),
    sessionFile(
      'yest00000001',
      `${daysAgo(1)} Hands`,
      `date: ${daysAgo(1)}\n`,
      '## What I practised\n\nHands.\n\n## Next time\n\nDraw hands from life.\n',
    ),
  )
  await expect(todayPage(page).getByTestId('next-time')).toHaveText('Draw hands from life.')

  // New session: dated today, titled with the date, from the Session template.
  await todayPage(page).getByRole('button', { name: 'New session' }).click()
  const today = localDay(new Date())
  await expect(titleBox(page)).toHaveValue(today)
  const session = read(join(folder, 'sessions', `${today}.md`))
  expect(frontValue(session, 'date')).toBe(today)
  expect(session).toContain(
    '## What I practised\n\n## What I learned\n\n## What was hard\n\n## Next time\n',
  )
  await page
    .getByRole('navigation', { name: 'Journal pages' })
    .getByRole('button', { name: 'Today' })
    .click()
  await expect(todayPage(page).getByRole('list', { name: "Today's sessions" })).toHaveText(today)
  await expect(todayPage(page).getByTestId('next-time')).toHaveText('Draw hands from life.')

  // The journal folder is remembered.
  await closeAll()
  const again = await launchApp(appData)
  await openJournal(again.page)
  await expect(todayPage(again.page)).toBeVisible()
  await expect(entryButton(again.page, today)).toBeVisible()

  // Another computer: open the existing journal folder.
  await closeAll()
  const other = await launchApp(join(root, 'appdata-other'))
  await openJournal(other.page)
  await pickFolderWill(other.app, folder)
  await other.page.getByRole('button', { name: 'Open folder…' }).click()
  await expect(todayPage(other.page)).toBeVisible()
  await expect(entryButton(other.page, `${daysAgo(1)} Hands`)).toBeVisible()
})

test('calendar month and year views; no streak, missed-day or target wording anywhere', async () => {
  const { app, page } = await launchApp(join(root, 'appdata'))
  const folder = await createJournal(app, page)
  const today = localDay(new Date())
  const year = today.slice(0, 4)
  const january = `${year}-01-15`
  writeFile(
    join(folder, 'sessions', 'a.md'),
    sessionFile('aaaa00000001', 'Gesture', `date: ${january}\n`, ''),
  )
  writeFile(
    join(folder, 'sessions', 'b.md'),
    sessionFile('bbbb00000001', 'Lighting', `date: ${today}\n`, ''),
  )
  writeFile(
    join(folder, 'sessions', 'c.md'),
    sessionFile('cccc00000001', 'Color', `date: ${today}\n`, ''),
  )
  await expect(entryButton(page, 'Color')).toBeVisible()
  const texts: string[] = [await page.locator('body').innerText()]

  // Sessions opens the calendar on this month: today has two sessions.
  await page.locator('[data-section="sessions"] .bible-section-link').click()
  const calendar = page.getByRole('region', { name: 'Calendar' })
  const todayCell = calendar.locator(`.cal-day[data-day="${today}"]`)
  await expect(todayCell).toHaveAttribute('data-shade', '2')
  await expect(todayCell).toHaveAttribute('aria-label', /2 sessions$/)
  await todayCell.click()
  await expect(calendar.locator('.cal-picked').getByRole('button')).toHaveText([
    // Same day, same creation time: by title.
    'Color',
    'Lighting',
  ])
  texts.push(await page.locator('body').innerText())

  // The year view shades every day with sessions; a day lists its sessions.
  await calendar.getByRole('button', { name: 'Year' }).click()
  const yearView = page.getByTestId('year-view')
  await expect(yearView.locator(`[data-day="${january}"]`)).toHaveAttribute('data-shade', '1')
  await expect(yearView.locator(`[data-day="${today}"]`)).toHaveAttribute('data-shade', '2')
  await expect(yearView.locator('.cal-day[data-shade="0"]').first()).toBeVisible()
  await yearView.locator(`[data-day="${january}"]`).click()
  await expect(calendar.locator('.cal-picked').getByRole('button')).toHaveText(['Gesture'])
  texts.push(await page.locator('body').innerText())

  // Session, topic and resources pages too.
  await entryButton(page, 'Gesture').click()
  texts.push(await page.locator('body').innerText())
  await newEntry(page, 'Topics', 'Anatomy')
  texts.push(await page.locator('body').innerText())
  await page.locator('[data-section="resources"] .bible-section-link').click()
  await expect(page.getByRole('region', { name: 'Resources' })).toBeVisible()
  texts.push(await page.locator('body').innerText())
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('[aria-label], [title], [placeholder]')].map((element) =>
      ['aria-label', 'title', 'placeholder']
        .map((name) => element.getAttribute(name) ?? '')
        .join(' '),
    ),
  )
  const all = [...texts, ...labels].join('\n')
  expect(all).not.toMatch(/streak/i)
  expect(all).not.toMatch(/missed/i)
  expect(all).not.toMatch(/goal/i)
})

test('practice images land in _assets and, when asked, in the Library tagged practice and topic', async () => {
  const appData = join(root, 'appdata')
  const { app, page } = await launchApp(appData)
  const folder = await createJournal(app, page)
  await newEntry(page, 'Topics', 'Anatomy')
  const topicId = frontValue(read(join(folder, 'topics', 'anatomy.md')), 'id')
  await page
    .getByRole('navigation', { name: 'Journal pages' })
    .getByRole('button', { name: 'Today' })
    .click()
  await todayPage(page).getByRole('button', { name: 'New session' }).click()
  const today = localDay(new Date())
  await expect(titleBox(page)).toHaveValue(today)
  const sessionPath = join(folder, 'sessions', `${today}.md`)
  writeFileSync(sessionPath, read(sessionPath).replace(/^topics:.*$/m, `topics: [${topicId}]`))
  await expect(page.getByRole('region', { name: 'Properties' })).toContainText('Anatomy')

  // Drop two images from Explorer: originals into _assets, links in the text.
  await expect(page.getByRole('checkbox', { name: 'Also add to Library' })).toBeChecked()
  await drop(page, await makeImageTransfer(page, [1, 2]))
  await expect(page.getByTestId('toast-text')).toHaveText(
    'Added to the Library, tagged practice, Anatomy',
  )
  await expect(editor(page)).toHaveValue(/!\[ref-01\]\(\.\.\/_assets\/[0-9a-f]{64}\.png\)/)
  await expect(editor(page)).toHaveValue(/!\[ref-02\]\(\.\.\/_assets\/[0-9a-f]{64}\.png\)/)
  await expect(page.getByTestId('save-status')).toHaveText('Saved')
  const assets = readdirSync(join(folder, '_assets'))
  expect(assets).toHaveLength(2)
  expect(assets.every((name) => name.endsWith('.png'))).toBe(true)
  expect(frontValue(read(sessionPath), 'references')).toBe(
    `[${assets
      .map((name) => `_assets/${name}`)
      .sort((a, b) => read(sessionPath).indexOf(a) - read(sessionPath).indexOf(b))
      .join(', ')}]`,
  )

  // Unticked (and remembered): the next image stays out of the Library.
  await page.getByRole('checkbox', { name: 'Also add to Library' }).uncheck()
  await drop(page, await makeImageTransfer(page, [3]))
  await expect(editor(page)).toHaveValue(/!\[ref-03\]/)
  await expect.poll(() => readdirSync(join(folder, '_assets')).length).toBe(3)

  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: 'Library' })
    .click()
  await expect(page.getByTestId('ref-card')).toHaveCount(2)
  await page.getByTestId('ref-card').first().click()
  const detail = page.getByRole('complementary', { name: 'Reference detail' })
  await expect(detail.getByRole('button', { name: 'Remove tag practice' })).toBeVisible()
  await expect(detail.getByRole('button', { name: 'Remove tag anatomy' })).toBeVisible()

  await closeAll()
  const again = await launchApp(appData)
  await openJournal(again.page)
  await entryButton(again.page, today).click()
  await expect(again.page.getByRole('checkbox', { name: 'Also add to Library' })).not.toBeChecked()
})

test('a topic shows its practice images over time, compares two, and lists its resources', async () => {
  const { app, page } = await launchApp(join(root, 'appdata'))
  const folder = await createJournal(app, page)
  writeFile(join(folder, '_assets', 'early.png'), TINY_PNG)
  writeFile(join(folder, '_assets', 'late.png'), TINY_PNG)
  writeFile(
    join(folder, 'topics', 'anatomy.md'),
    sessionFile('anat00000001', 'Anatomy', 'status: active\n', ''),
  )
  writeFile(
    join(folder, 'sessions', 'late.md'),
    sessionFile(
      'late00000001',
      'Hands again',
      'date: 2026-09-20\ntopics: [anat00000001]\nminutes: 30\nreferences: [_assets/late.png]\n',
      '![late](../_assets/late.png)\n',
    ),
  )
  writeFile(
    join(folder, 'sessions', 'early.md'),
    sessionFile(
      'earl00000001',
      'First hands',
      'date: 2026-09-01\ntopics: [anat00000001]\nminutes: 45\nreferences: [_assets/early.png]\n',
      '',
    ),
  )
  writeFile(
    join(folder, 'resources', 'book.md'),
    sessionFile(
      'book00000001',
      'Figure drawing book',
      'url: https://example.com/figure?ed=2\ntopics: [anat00000001]\nstatus: in progress\n',
      '',
    ),
  )
  await expect(entryButton(page, 'Figure drawing book')).toBeVisible()

  // The topic opens on its progress: images oldest first, with dates.
  await entryButton(page, 'Anatomy').click()
  const progress = page.getByTestId('topic-progress')
  const strip = progress.getByRole('region', { name: 'Practice images' })
  await expect(strip.locator('.practice-caption')).toHaveText([
    '2026-09-01 First hands',
    '2026-09-20 Hands again',
  ])
  await expect
    .poll(() =>
      strip
        .locator('img')
        .evaluateAll((images) =>
          images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
        ),
    )
    .toBe(true)
  await expect(
    progress.getByRole('region', { name: 'Sessions on this topic' }).getByRole('button'),
  ).toHaveText(['Hands again', 'First hands'])
  await expect(progress.getByTestId('topic-minutes')).toHaveText('75 minutes logged on this topic.')
  await expect(progress.getByRole('region', { name: 'Resources for this topic' })).toContainText(
    'in progress',
  )
  await expect(progress.getByRole('region', { name: 'Resources for this topic' })).toContainText(
    'Figure drawing book',
  )

  // Compare: two images side by side at the same height, with their dates.
  await strip.getByRole('button', { name: 'Compare' }).click()
  await strip.getByRole('button', { name: 'Compare image from First hands' }).click()
  await strip.getByRole('button', { name: 'Compare image from Hands again' }).click()
  const compare = progress.getByTestId('compare-view')
  await expect(compare.locator('figure')).toHaveCount(2)
  await expect(compare.locator('figcaption')).toHaveText([
    /Tuesday 1 September 2026 · First hands/,
    /Sunday 20 September 2026 · Hands again/,
  ])
  const boxes = await compare
    .locator('img')
    .evaluateAll((images) => images.map((image) => image.getBoundingClientRect()))
  expect(boxes[0]?.height).toBeGreaterThan(100)
  expect(boxes[0]?.height).toBe(boxes[1]?.height)
  expect(boxes[0]?.left ?? 0).toBeLessThan(boxes[1]?.left ?? 0)

  // Resources: grouped by status, with topic chips; links ask first.
  await page.locator('[data-section="resources"] .bible-section-link').click()
  const list = page.getByRole('region', { name: 'Resources' })
  const inProgress = list.getByRole('region', { name: 'In progress' })
  await expect(inProgress).toContainText('Figure drawing book')
  await expect(inProgress.getByRole('button', { name: 'Anatomy' })).toBeVisible()
  await expect(list.getByRole('region', { name: 'To watch' })).toContainText('Nothing here.')
  await app.evaluate(({ shell }) => {
    const opened: string[] = []
    ;(globalThis as { opened?: string[] }).opened = opened
    shell.openExternal = (async (url: string) => {
      opened.push(url)
    }) as typeof shell.openExternal
  })
  await inProgress.getByRole('button', { name: 'https://example.com/figure?ed=2' }).click()
  const confirm = page.getByRole('dialog', { name: 'Open link' })
  await expect(confirm.getByTestId('external-url')).toHaveText('https://example.com/figure?ed=2')
  await confirm.getByRole('button', { name: 'Open in browser' }).click()
  await expect
    .poll(() => app.evaluate(() => (globalThis as { opened?: string[] }).opened))
    .toEqual(['https://example.com/figure?ed=2'])
  await inProgress.getByRole('button', { name: 'Anatomy' }).click()
  await expect(titleBox(page)).toHaveValue('Anatomy')
})

test('the link picker remembers the section chosen for links from a section', async () => {
  const { app, page } = await launchApp(join(root, 'appdata'))
  const game = join(root, 'Dream')
  mkdirSync(game)
  await page.getByRole('button', { name: 'Bible', exact: true }).click()
  await pickFolderWill(app, game)
  await page.getByRole('button', { name: 'Choose folder…' }).click()
  await page.getByRole('radio', { name: /^Atmospheric \/ horror/ }).check()
  await page.getByRole('button', { name: 'Create bible' }).click()
  await page
    .getByRole('dialog', { name: 'What should players feel?' })
    .getByRole('button', { name: 'Skip' })
    .click()
  // The Journal kit is not a bible kit.
  expect(read(join(game, 'bible', 'bible.json'))).toContain('"kit": "atmospheric-horror"')

  // First time: no memory and no similar title, so the link's own section; pick World.
  await newEntry(page, 'Creatures', 'Pale hunter')
  await editor(page).press('Control+End')
  await editor(page).pressSequentially('\nHunts in [[Zorblat]].')
  await expect(page.getByTestId('save-status')).toHaveText('Saved')
  await page.getByTestId('entry-preview').locator('a.wiki-link.missing').click()
  let picker = page.getByRole('dialog', { name: 'Create entry' })
  await expect(picker.getByRole('radio', { name: 'Creatures' })).toBeChecked()
  await picker.getByRole('radio', { name: 'World' }).check()
  await picker.getByRole('button', { name: 'Create' }).click()
  await expect(titleBox(page)).toHaveValue('Zorblat')
  expect(existsSync(join(game, 'bible', 'world', 'zorblat.md'))).toBe(true)

  // Next missing link from Creatures: World is the default now.
  await newEntry(page, 'Creatures', 'Moth')
  await editor(page).press('Control+End')
  await editor(page).pressSequentially('\nNests in [[Quuxen]].')
  await expect(page.getByTestId('save-status')).toHaveText('Saved')
  await page.getByTestId('entry-preview').locator('a.wiki-link.missing').click()
  picker = page.getByRole('dialog', { name: 'Create entry' })
  await expect(picker.getByRole('radio', { name: 'World' })).toBeChecked()
  await picker.getByRole('button', { name: 'Create' }).click()
  await expect(titleBox(page)).toHaveValue('Quuxen')
  expect(existsSync(join(game, 'bible', 'world', 'quuxen.md'))).toBe(true)
})
