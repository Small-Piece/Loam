import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { assertBuilt, launchApp as launch } from './launch.ts'

// Temp data folder only.
let root: string
let running: ElectronApplication[] = []

test.beforeAll(() => {
  assertBuilt()
})

test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'loam-e2e-board-order-'))
})

test.afterEach(async () => {
  for (const app of running) await app.close().catch(() => undefined)
  running = []
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

async function launchApp(appData: string) {
  const app = await launch(appData)
  running.push(app)
  const page = await app.firstWindow()
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible()
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  return { app, page }
}

async function closeApp(app: ElectronApplication) {
  await app.close()
  running = running.filter((other) => other !== app)
}

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Boards' })
const rows = (page: Page) => sidebar(page).getByTestId('board-row')
const boardButton = (page: Page, name: string) =>
  sidebar(page).getByRole('button', { name: new RegExp(`^${name}\\b`) })
const order = (page: Page) => rows(page).locator('.board-name').allInnerTexts()

async function newBoard(page: Page, name: string) {
  await sidebar(page).getByRole('button', { name: 'New board' }).click()
  await sidebar(page).getByRole('textbox', { name: 'New board name' }).fill(name)
  await sidebar(page).getByRole('textbox', { name: 'New board name' }).press('Enter')
  await expect(boardButton(page, name)).toBeVisible()
}

test('boards can be dragged into a new order that survives a restart', async () => {
  const appData = join(root, 'appdata')
  const first = await launchApp(appData)
  // New boards go last, whatever their names.
  for (const name of ['Mood', 'Characters', 'Architecture']) await newBoard(first.page, name)
  await expect.poll(() => order(first.page)).toEqual(['Mood', 'Characters', 'Architecture'])

  // Drag "Architecture" onto the top half of "Mood": it lands first.
  await boardButton(first.page, 'Architecture').dragTo(rows(first.page).first(), {
    targetPosition: { x: 40, y: 3 },
  })
  await expect.poll(() => order(first.page)).toEqual(['Architecture', 'Mood', 'Characters'])
  // Drag "Architecture" below the last board: it lands at the end.
  const last = rows(first.page).last()
  const box = await last.boundingBox()
  await boardButton(first.page, 'Architecture').dragTo(last, {
    targetPosition: { x: 40, y: (box?.height ?? 30) - 3 },
  })
  await expect.poll(() => order(first.page)).toEqual(['Mood', 'Characters', 'Architecture'])
  await boardButton(first.page, 'Characters').dragTo(rows(first.page).first(), {
    targetPosition: { x: 40, y: 3 },
  })
  await expect.poll(() => order(first.page)).toEqual(['Characters', 'Mood', 'Architecture'])
  await closeApp(first.app)

  const again = await launchApp(appData)
  await expect.poll(() => order(again.page)).toEqual(['Characters', 'Mood', 'Architecture'])
  // A board created now still goes last.
  await newBoard(again.page, 'Lighting')
  await expect
    .poll(() => order(again.page))
    .toEqual(['Characters', 'Mood', 'Architecture', 'Lighting'])
})

test('Move up and Move down in the board menu, by mouse and keyboard, disabled at the ends', async () => {
  const { page } = await launchApp(join(root, 'appdata'))
  for (const name of ['One', 'Two', 'Three']) await newBoard(page, name)

  // The first board cannot move up; the last cannot move down.
  await boardButton(page, 'One').click({ button: 'right' })
  let menu = page.getByRole('menu', { name: 'Actions for One' })
  await expect(menu.getByRole('menuitem', { name: /Move up/ })).toBeDisabled()
  await expect(menu.getByRole('menuitem', { name: /Move down/ })).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await boardButton(page, 'Three').click({ button: 'right' })
  menu = page.getByRole('menu', { name: 'Actions for Three' })
  await expect(menu.getByRole('menuitem', { name: /Move down/ })).toBeDisabled()

  // Mouse: move "Three" up.
  await menu.getByRole('menuitem', { name: /Move up/ }).click()
  await expect.poll(() => order(page)).toEqual(['One', 'Three', 'Two'])

  // Keyboard: Shift+F10 opens the menu on the focused board; Enter on Move down.
  await boardButton(page, 'One').focus()
  await page.keyboard.press('Shift+F10')
  menu = page.getByRole('menu', { name: 'Actions for One' })
  await expect(menu.getByRole('menuitem', { name: /Move down/ })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(() => order(page)).toEqual(['Three', 'One', 'Two'])
  await expect(boardButton(page, 'One')).toBeFocused()

  // Alt+Up and Alt+Down move the focused board directly.
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(() => order(page)).toEqual(['Three', 'Two', 'One'])
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(() => order(page)).toEqual(['Three', 'Two', 'One'])
  await page.keyboard.press('Alt+ArrowUp')
  await expect.poll(() => order(page)).toEqual(['Three', 'One', 'Two'])

  // "All references" and Trash stay where they are.
  const items = sidebar(page).locator('.board-item .board-name')
  await expect(items.first()).toHaveText('All references')
  await expect(items.last()).toHaveText('Trash')
})
