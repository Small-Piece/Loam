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
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { assertBuilt, launchApp as launch } from './launch.ts'

// Test vaults live in the system temp folder, never inside the repository.
let root: string
let localAppData: string
let running: ElectronApplication[] = []

test.beforeAll(() => {
  assertBuilt()
})

test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'loam-e2e-bible5b-'))
  localAppData = join(root, 'appdata')
  mkdirSync(localAppData)
})

test.afterEach(async () => {
  for (const app of running) await app.close().catch(() => undefined)
  running = []
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launch(localAppData)
  running.push(app)
  const page = await app.firstWindow()
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible()
  await page.getByRole('button', { name: 'Bible', exact: true }).click()
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

/** Creates a vault in <game>/bible; the first-run question is answered or skipped. */
async function createVault(
  app: ElectronApplication,
  page: Page,
  game: string,
  kit: RegExp,
  first: { answer: string; name?: string } | null,
) {
  mkdirSync(game, { recursive: true })
  await pickFolderWill(app, game)
  await page.getByRole('button', { name: 'Choose folder…' }).click()
  await page.getByRole('radio', { name: kit }).check()
  await page.getByRole('button', { name: 'Create bible' }).click()
  const question = page.getByRole('dialog', { name: 'What should players feel?' })
  await expect(question).toBeVisible()
  if (first === null) {
    await question.getByRole('button', { name: 'Skip' }).click()
  } else {
    await question.getByRole('textbox', { name: 'What should players feel?' }).fill(first.answer)
    if (first.name !== undefined) {
      await question.getByRole('textbox', { name: 'Name it in 2–4 words' }).fill(first.name)
    }
    await question.getByRole('button', { name: 'Add first pillar' }).click()
  }
  await expect(question).toHaveCount(0)
}

async function newEntry(page: Page, section: string, title: string) {
  await page.getByRole('button', { name: `New entry in ${section}` }).click()
  await page.getByRole('textbox', { name: 'New entry title' }).fill(title)
  await page.getByRole('textbox', { name: 'New entry title' }).press('Enter')
  await expect(titleBox(page)).toHaveValue(title)
}

const titleBox = (page: Page) => page.getByRole('textbox', { name: 'Entry title', exact: true })
const editor = (page: Page) => page.getByRole('textbox', { name: 'Entry text' })
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveText('Saved')
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sections' })
const entryButton = (page: Page, title: string) =>
  sidebar(page).getByRole('button', { name: title, exact: true })
const sectionTitles = (page: Page, section: string) =>
  page.locator(`[data-section="${section}"] button.bible-entry`).allInnerTexts()
const read = (path: string) => readFileSync(path, 'utf8')

async function openEntryMenu(page: Page, title: string): Promise<Locator> {
  await sidebar(page)
    .getByRole('button', { name: `Actions for ${title}` })
    .click()
  const menu = page.getByRole('menu', { name: `Actions for ${title}` })
  await expect(menu).toBeVisible()
  return menu
}

test('sidebar by mouse: rename, duplicate, move, reorder by drag and delete; links follow a move', async () => {
  const game = join(root, 'Dream')
  const vault = join(game, 'bible')
  const { app, page } = await launchApp()
  await createVault(app, page, game, /^Atmospheric/, null)
  await newEntry(page, 'World', 'The Ashfall')
  await newEntry(page, 'World', 'Layer One')
  await newEntry(page, 'World', 'Oakmere')
  await newEntry(page, 'Story', 'Descent')
  await editor(page).fill('They go down into [[The Ashfall]].')
  await saved(page)

  // Rename from the menu, in place in the sidebar.
  await (await openEntryMenu(page, 'Layer One')).getByRole('menuitem', { name: /^Rename/ }).click()
  await page.getByRole('textbox', { name: 'Rename entry' }).fill('Edge of the Ashfall')
  await page.getByRole('textbox', { name: 'Rename entry' }).press('Enter')
  await expect(entryButton(page, 'Edge of the Ashfall')).toBeVisible()
  expect(existsSync(join(vault, 'world', 'edge-of-the-ashfall.md'))).toBe(true)

  // Duplicate.
  await (await openEntryMenu(page, 'Oakmere')).getByRole('menuitem', { name: 'Duplicate' }).click()
  await expect(titleBox(page)).toHaveValue('Oakmere copy')
  expect(existsSync(join(vault, 'world', 'oakmere-copy.md'))).toBe(true)

  // Move "The Ashfall" to Atmosphere: the link in Descent still resolves.
  await (
    await openEntryMenu(page, 'The Ashfall')
  )
    .getByRole('menuitem', { name: 'Atmosphere' })
    .click()
  await expect(page.getByTestId('toast-text')).toHaveText('Moved to Atmosphere')
  // It still holds only the World template, so the move offers Atmosphere's; keep the old one.
  const swap = page.getByRole('alertdialog')
  await expect(swap).toContainText('Use the Atmosphere template?')
  await swap.getByRole('button', { name: 'Cancel' }).click()
  expect(await sectionTitles(page, 'atmosphere')).toEqual(['The Ashfall'])
  expect(existsSync(join(vault, 'atmosphere', 'the-ashfall.md'))).toBe(true)
  expect(existsSync(join(vault, 'world', 'the-ashfall.md'))).toBe(false)
  await entryButton(page, 'Descent').click()
  const link = page.getByTestId('entry-preview').locator('a.wiki-link')
  await expect(link).toHaveText('The Ashfall')
  await expect(link).not.toHaveClass(/missing/)
  await link.click()
  await expect(titleBox(page)).toHaveValue('The Ashfall')
  await expect(page.getByTestId('backlinks')).toHaveText('Descent')

  // Reorder by drag within World: Oakmere copy to the top.
  expect(await sectionTitles(page, 'world')).toEqual([
    'Edge of the Ashfall',
    'Oakmere',
    'Oakmere copy',
  ])
  const target = entryButton(page, 'Edge of the Ashfall')
  await entryButton(page, 'Oakmere copy').dragTo(target, { targetPosition: { x: 20, y: 3 } })
  await expect
    .poll(() => sectionTitles(page, 'world'))
    .toEqual(['Oakmere copy', 'Edge of the Ashfall', 'Oakmere'])
  // Only the moved entry's order changed; it is now below its new neighbour's.
  const orderOf = (file: string) =>
    Number(/^order: (\S+)$/m.exec(read(join(vault, 'world', file)))?.[1])
  expect(orderOf('oakmere-copy.md')).toBeLessThan(orderOf('edge-of-the-ashfall.md'))

  // Drag onto another section's entry: moved there, at that place.
  await entryButton(page, 'Oakmere').dragTo(entryButton(page, 'Descent'), {
    targetPosition: { x: 20, y: 3 },
  })
  await expect.poll(() => sectionTitles(page, 'story')).toEqual(['Oakmere', 'Descent'])
  expect(existsSync(join(vault, 'story', 'oakmere.md'))).toBe(true)
  const storySwap = page.getByRole('alertdialog')
  await expect(storySwap).toContainText('Use the Story template?')
  await storySwap.getByRole('button', { name: 'Cancel' }).click()

  // Delete from the menu, with Undo.
  await (
    await openEntryMenu(page, 'Oakmere copy')
  )
    .getByRole('menuitem', { name: /^Delete/ })
    .click()
  await expect(entryButton(page, 'Oakmere copy')).toHaveCount(0)
  expect(existsSync(join(vault, '.trash', 'world', 'oakmere-copy.md'))).toBe(true)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(entryButton(page, 'Oakmere copy')).toBeVisible()

  // Right-click opens the same menu.
  await entryButton(page, 'Descent').click({ button: 'right' })
  await expect(page.getByRole('menu', { name: 'Actions for Descent' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
})

test('sidebar by keyboard: F2, Alt+arrows, Shift+F10 menu, Delete and Enter', async () => {
  const game = join(root, 'Dream')
  const vault = join(game, 'bible')
  const { app, page } = await launchApp()
  await createVault(app, page, game, /^Blank/, null)
  for (const title of ['Rope', 'Lantern', 'Wayfinder']) await newEntry(page, 'Ideas', title)
  await newEntry(page, 'Decisions', 'Go deeper')

  // F2 renames.
  await entryButton(page, 'Rope').focus()
  await page.keyboard.press('F2')
  await expect(page.getByRole('textbox', { name: 'Rename entry' })).toBeFocused()
  await page.keyboard.type('Climbing rope')
  await page.keyboard.press('Enter')
  await expect(entryButton(page, 'Climbing rope')).toBeFocused()
  expect(existsSync(join(vault, 'ideas', 'climbing-rope.md'))).toBe(true)

  // Alt+Down reorders.
  await page.keyboard.press('Alt+ArrowDown')
  await expect
    .poll(() => sectionTitles(page, 'ideas'))
    .toEqual(['Lantern', 'Climbing rope', 'Wayfinder'])
  await expect(entryButton(page, 'Climbing rope')).toBeFocused()
  await page.keyboard.press('Alt+ArrowUp')
  await expect
    .poll(() => sectionTitles(page, 'ideas'))
    .toEqual(['Climbing rope', 'Lantern', 'Wayfinder'])

  // Shift+F10 opens the menu with the first item focused; arrows move; Enter picks.
  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu', { name: 'Actions for Climbing rope' })
  await expect(menu.getByRole('menuitem', { name: /^Rename/ })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: 'Duplicate' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(titleBox(page)).toHaveValue('Climbing rope copy')

  // Move to another section from the keyboard menu.
  await entryButton(page, 'Wayfinder').focus()
  await page.keyboard.press('Shift+F10')
  const wayfinderMenu = page.getByRole('menu', { name: 'Actions for Wayfinder' })
  await wayfinderMenu.getByRole('menuitem', { name: 'Decisions' }).focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => sectionTitles(page, 'decisions')).toEqual(['Go deeper', 'Wayfinder'])

  // Delete removes; Enter opens.
  await entryButton(page, 'Lantern').focus()
  await page.keyboard.press('Delete')
  await expect(entryButton(page, 'Lantern')).toHaveCount(0)
  expect(existsSync(join(vault, '.trash', 'ideas', 'lantern.md'))).toBe(true)
  await entryButton(page, 'Go deeper').focus()
  await page.keyboard.press('Enter')
  await expect(titleBox(page)).toHaveValue('Go deeper')
})

test('the Trash view restores an entry and a whole section; permanent delete asks first', async () => {
  const game = join(root, 'Dream')
  const vault = join(game, 'bible')
  const { app, page } = await launchApp()
  await createVault(app, page, game, /^Atmospheric/, null)
  await newEntry(page, 'Creatures', 'Orbed Piercer')
  await page.getByRole('combobox', { name: 'Threat' }).selectOption('deadly')
  await expect
    .poll(() => read(join(vault, 'creatures', 'orbed-piercer.md')))
    .toContain('threat: deadly')
  await newEntry(page, 'Story', 'Descent')
  await newEntry(page, 'Story', 'Return')

  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: /^Delete/ }).click()
  await (
    await openEntryMenu(page, 'Orbed Piercer')
  )
    .getByRole('menuitem', { name: /^Delete/ })
    .click()
  await page.getByRole('button', { name: 'Story section options' }).click()
  await page.getByRole('menuitem', { name: 'Remove…' }).click()
  await page.getByRole('button', { name: 'Remove section' }).click()
  await expect(sidebar(page).locator('[data-section="story"]')).toHaveCount(0)

  await page.getByRole('button', { name: 'Trash' }).click()
  const view = page.getByRole('region', { name: 'Bible trash' })
  const rows = view.locator('tbody tr')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText('Section Story (1 entry)')
  await expect(rows.nth(1)).toContainText('Entry Orbed Piercer')
  await expect(rows.nth(1)).toContainText('Creatures · creatures/orbed-piercer.md')
  await expect(rows.nth(2)).toContainText('Entry Return')
  for (const row of [0, 1, 2])
    await expect(rows.nth(row).locator('td').nth(2)).not.toHaveText('unknown')

  // Restore the entry, with its field value.
  await view.getByRole('button', { name: 'Restore Orbed Piercer' }).click()
  // The toast comes with the reply, once the restore is complete on disk. (The
  // trash list can change earlier: the file moves before the index catches up.)
  await expect(page.getByTestId('toast-text')).toHaveText('Restored “Orbed Piercer”')
  await expect(rows).toHaveCount(2)
  expect(read(join(vault, 'creatures', 'orbed-piercer.md'))).toContain('threat: deadly')
  await expect(entryButton(page, 'Orbed Piercer')).toBeVisible()

  // Restore the section to where it was, with its entry.
  await view.getByRole('button', { name: 'Restore Story' }).click()
  await expect(page.getByTestId('toast-text')).toHaveText('Restored “Story”')
  await expect(rows).toHaveCount(1)
  const config = JSON.parse(read(join(vault, 'bible.json'))) as { sections: Array<{ id: string }> }
  expect(config.sections.map((section) => section.id)).toEqual([
    'pillars',
    'atmosphere',
    'world',
    'creatures',
    'story',
    'decisions',
    'ideas',
  ])
  expect(await sectionTitles(page, 'story')).toEqual(['Descent'])

  // Permanent delete asks; Cancel keeps the file.
  await view.getByRole('button', { name: 'Delete Return permanently' }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Delete “Return” permanently?' })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  expect(existsSync(join(vault, '.trash', 'story', 'return.md'))).toBe(true)
  await view.getByRole('button', { name: 'Delete Return permanently' }).click()
  await confirm.getByRole('button', { name: 'Delete permanently' }).click()
  await expect(view.getByText('The trash is empty.')).toBeVisible()
  expect(existsSync(join(vault, '.trash', 'story', 'return.md'))).toBe(false)
})

test('first run: the pillar has a short name, the full answer and the Pillar template', async () => {
  const game = join(root, 'Dream')
  const { app, page } = await launchApp()
  mkdirSync(game, { recursive: true })
  await pickFolderWill(app, game)
  await page.getByRole('button', { name: 'Choose folder…' }).click()
  await page.getByRole('radio', { name: /^Narrative/ }).check()
  await page.getByRole('button', { name: 'Create bible' }).click()
  const answer = 'Wonder of the world, but the player feels awe and despair at the same time.'
  await page.getByRole('textbox', { name: 'What should players feel?' }).fill(answer)
  // The name is suggested from the answer, then changed.
  await expect(page.getByRole('textbox', { name: 'Name it in 2–4 words' })).toHaveValue(
    'Wonder of the world',
  )
  await page.getByRole('textbox', { name: 'Name it in 2–4 words' }).fill('Awe and despair')
  await page.getByRole('button', { name: 'Add first pillar' }).click()
  await expect(titleBox(page)).toHaveValue('Awe and despair')
  const text = read(join(game, 'bible', 'pillars', 'awe-and-despair.md'))
  expect(text.slice(text.indexOf('\n---\n') + 5)).toBe(
    `## What players should feel\n\n${answer}\n\n## What this looks like in play\n\n## What this rules out\n`,
  )
  await expect(page.getByTestId('entry-preview').getByRole('heading', { level: 2 })).toHaveText([
    'What players should feel',
    'What this looks like in play',
    'What this rules out',
  ])
})

test('section fields: every type round-trips through the panel and hand edits; removing a field keeps values', async () => {
  const game = join(root, 'Dream')
  const vault = join(game, 'bible')
  const { app, page } = await launchApp()
  await createVault(app, page, game, /^Blank/, { answer: 'Awe', name: 'Awe' })
  await newEntry(page, 'Decisions', 'Go deeper')

  // Define one field of every type in Ideas through the section settings.
  await page.getByRole('button', { name: 'Ideas section options' }).click()
  await page.getByRole('menuitem', { name: 'Fields…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Ideas fields' })
  const fields: Array<[string, string, string?]> = [
    ['Note', 'text'],
    ['Cost', 'number'],
    ['Size', 'select', 'small, big'],
    ['Mood', 'multi-select', 'eerie, calm'],
    ['Serves', 'entry'],
    ['Related', 'entries'],
    ['Since', 'date'],
    ['Approved', 'checkbox'],
  ]
  for (const [index, [label, type, options]] of fields.entries()) {
    await dialog.getByRole('button', { name: '+ Add field' }).click()
    await dialog.getByRole('textbox', { name: `Field ${index + 1} name` }).fill(label)
    await dialog.getByRole('combobox', { name: `Field ${index + 1} type` }).selectOption(type)
    if (options)
      await dialog.getByRole('textbox', { name: `Field ${index + 1} choices` }).fill(options)
  }
  await dialog.getByRole('combobox', { name: 'Field 5 section' }).selectOption('pillars')
  await dialog.getByRole('button', { name: 'Save fields' }).click()
  await expect(dialog).toHaveCount(0)

  await newEntry(page, 'Ideas', 'Rope')
  const file = join(vault, 'ideas', 'rope.md')
  // A new entry carries every field, empty.
  expect(read(file)).toMatch(
    /\nnote:\ncost:\nsize:\nmood: \[\]\nserves:\nrelated: \[\]\nsince:\napproved: false\n---\n/,
  )

  // Set every value in the Properties panel.
  const panel = page.getByRole('region', { name: 'Properties' })
  await panel.getByRole('textbox', { name: 'Note' }).fill('Swings like "a pendulum"')
  await panel.getByRole('textbox', { name: 'Note' }).press('Enter')
  await panel.getByRole('spinbutton', { name: 'Cost' }).fill('3.5')
  await panel.getByRole('spinbutton', { name: 'Cost' }).press('Enter')
  await panel.getByRole('combobox', { name: 'Size' }).selectOption('big')
  await panel.getByRole('group', { name: 'Mood' }).getByRole('button', { name: 'eerie' }).click()
  await panel.getByRole('combobox', { name: 'Serves' }).selectOption({ label: 'Awe' })
  await panel.getByRole('combobox', { name: 'Add to Related' }).selectOption({ label: 'Go deeper' })
  await panel.locator('input[type="date"]').fill('2026-10-13')
  await panel.getByRole('checkbox', { name: 'Approved' }).check()
  await panel.getByRole('combobox', { name: 'Add tag' }).fill('climbing')
  await panel.getByRole('combobox', { name: 'Add tag' }).press('Enter')
  await saved(page)
  await expect.poll(() => read(file)).toContain('approved: true')
  const ids = Object.fromEntries(
    ['awe', 'go-deeper'].map((slug) => {
      const section = slug === 'awe' ? 'pillars' : 'decisions'
      return [slug, /^id: (\S+)$/m.exec(read(join(vault, section, `${slug}.md`)))?.[1]]
    }),
  )
  const text = read(file)
  for (const line of [
    'tags: [climbing]',
    'note: "Swings like \\"a pendulum\\""',
    'cost: 3.5',
    'size: big',
    'mood: [eerie]',
    `serves: ${ids['awe']}`,
    `related: [${ids['go-deeper']}]`,
    'since: 2026-10-13',
    'approved: true',
  ]) {
    expect(text).toContain(`\n${line}\n`)
  }

  // Edited in another editor: the panel shows the new values; a bad one gets a warning.
  writeFileSync(
    file,
    text
      .replace('size: big', 'size: small')
      .replace('mood: [eerie]', 'mood:\n  - calm\n  - eerie')
      .replace(`serves: ${ids['awe']}`, 'serves: "[[Awe]]"')
      .replace('cost: 3.5', 'cost: lots'),
  )
  await expect(panel.getByRole('combobox', { name: 'Size' })).toHaveValue('small')
  await expect(
    panel.getByRole('group', { name: 'Mood' }).getByRole('button', { name: 'calm' }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(panel.getByRole('combobox', { name: 'Serves' })).toHaveValue('')
  await expect(panel.locator('[data-field="cost"] .prop-warning')).toHaveText(
    '⚠ Expected a number (in the file: lots)',
  )
  await expect(panel.locator('[data-field="serves"] .prop-warning')).toHaveCount(0)
  expect(read(file)).toContain('cost: lots')

  // Removing a field definition hides it and leaves the file alone.
  const before = read(file)
  await page.getByRole('button', { name: 'Ideas section options' }).click()
  await page.getByRole('menuitem', { name: 'Fields…' }).click()
  await dialog.getByRole('button', { name: 'Remove Cost' }).click()
  await dialog.getByRole('button', { name: 'Save fields' }).click()
  await expect(panel.locator('[data-field="cost"]')).toHaveCount(0)
  expect(read(file)).toBe(before)
  const config = JSON.parse(read(join(vault, 'bible.json'))) as {
    sections: Array<{ id: string; fields?: Array<{ key: string }> }>
  }
  expect(
    config.sections.find((section) => section.id === 'ideas')?.fields?.map((field) => field.key),
  ).toEqual(['note', 'size', 'mood', 'serves', 'related', 'since', 'approved'])
})

test("each non-Blank starter kit's fields appear on new entries in their sections", async () => {
  const { app, page } = await launchApp()
  const kits: Array<[RegExp, string, string, string[]]> = [
    [/^Narrative/, 'Characters', 'characters', ['Role', 'First appears']],
    [/^Action/, 'Enemies', 'enemies', ['Threat', 'Biome']],
    [/^Cozy/, 'Activities', 'activities', ['Seasons']],
    [/^Atmospheric/, 'Creatures', 'creatures', ['Threat', 'Habitat']],
  ]
  for (const [index, [kit, section, folder, labels]] of kits.entries()) {
    if (index > 0) await page.getByRole('button', { name: 'Switch bible…' }).click()
    const game = join(root, `game-${index}`)
    await createVault(app, page, game, kit, null)
    await newEntry(page, section, `Thing ${index}`)
    const panel = page.getByRole('region', { name: 'Properties' })
    await expect(panel.locator('.prop-label')).toHaveText(['Tags', ...labels])
    const text = read(join(game, 'bible', folder, `thing-${index}.md`))
    expect(readdirSync(join(game, 'bible', folder))).toEqual([`thing-${index}.md`])
    expect(text).toMatch(/\nupdated: \S+\n\w+:/)
  }
})

test('pillar cards: drag to reorder survives a restart; a sixth pillar shows the note', async () => {
  const game = join(root, 'Dream')
  let { app, page } = await launchApp()
  await createVault(app, page, game, /^Blank/, { answer: 'Awe at the depth', name: 'Awe' })
  for (const name of ['Dread', 'Curiosity', 'Loneliness', 'Wonder'])
    await newEntry(page, 'Pillars', name)
  await sidebar(page).getByRole('button', { name: 'Pillars', exact: true }).click()
  const cards = page.locator('.pillar-card .pillar-title')
  await expect(cards).toHaveText(['Awe', 'Dread', 'Curiosity', 'Loneliness', 'Wonder'])
  await expect(page.locator('.pillar-card').first()).toContainText('Awe at the depth')
  await expect(page.getByTestId('pillar-note')).toHaveCount(0)

  // Drag "Wonder" before "Awe".
  await page
    .locator('.pillar-card[data-path="pillars/wonder.md"]')
    .dragTo(page.locator('.pillar-card[data-path="pillars/awe.md"]'), {
      targetPosition: { x: 40, y: 5 },
    })
  await expect(cards).toHaveText(['Wonder', 'Awe', 'Dread', 'Curiosity', 'Loneliness'])

  // A sixth pillar: the add form says so, and the page shows the note. Nothing is blocked.
  await page.getByRole('button', { name: 'Add pillar' }).click()
  await expect(page.getByRole('note').filter({ hasText: 'This will be pillar 6' })).toBeVisible()
  await page.getByRole('textbox', { name: 'New entry title' }).fill('Silence')
  await page.getByRole('textbox', { name: 'New entry title' }).press('Enter')
  await expect(titleBox(page)).toHaveValue('Silence')
  await sidebar(page).getByRole('button', { name: 'Pillars', exact: true }).click()
  await expect(page.getByTestId('pillar-note')).toContainText('You have 6 pillars')

  // The order is in the files: it survives a restart.
  await closeAll()
  ;({ app, page } = await launchApp())
  await sidebar(page).getByRole('button', { name: 'Pillars', exact: true }).click()
  await expect(page.locator('.pillar-card .pillar-title')).toHaveText([
    'Wonder',
    'Awe',
    'Dread',
    'Curiosity',
    'Loneliness',
    'Silence',
  ])

  // Cards have the entry actions: rename in place, and open the entry.
  const pillarsPage = page.getByRole('region', { name: 'Pillars' })
  await pillarsPage.getByRole('button', { name: 'Actions for Dread' }).click()
  await page.getByRole('menuitem', { name: /^Rename/ }).click()
  await page.getByRole('textbox', { name: 'Pillar name' }).fill('Quiet dread')
  await page.getByRole('textbox', { name: 'Pillar name' }).press('Enter')
  await expect(page.locator('.pillar-card .pillar-title').nth(2)).toHaveText('Quiet dread')
  await page.locator('.pillar-card .pillar-title').nth(2).click()
  await expect(titleBox(page)).toHaveValue('Quiet dread')
})
