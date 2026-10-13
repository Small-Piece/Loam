import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { cards, drop, makeImageTransfer, storedFiles } from './fixtures.ts'
import { assertBuilt, launchApp as launch } from './launch.ts'

let localAppData: string
let running: ElectronApplication[] = []

async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launch(localAppData)
  running.push(app)
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'All references' })).toBeVisible()
  return { app, page }
}

test.beforeAll(() => {
  assertBuilt()
})

test.beforeEach(() => {
  localAppData = mkdtempSync(join(tmpdir(), 'loam-e2e-delete-'))
})

test.afterEach(async () => {
  for (const app of running) await app.close().catch(() => undefined)
  running = []
  rmSync(localAppData, { recursive: true, force: true })
})

interface Snapshot {
  id: number
  title: string
  tags: string[]
  boardIds: number[]
}

/** Calls the backend through the same preload bridge the UI uses (test setup and checks). */
async function invoke<T>(page: Page, channel: string, payload: unknown): Promise<T> {
  const reply = (await page.evaluate(([name, body]) => window.loam.invoke(name, body), [
    channel,
    payload,
  ] as const)) as { ok: boolean; data: T; error?: unknown }
  if (!reply.ok) throw new Error(`${channel} failed: ${JSON.stringify(reply.error)}`)
  return reply.data
}

async function snapshot(page: Page, ids: number[]): Promise<Snapshot[]> {
  const result: Snapshot[] = []
  for (const id of ids) {
    const { detail } = await invoke<{ detail: Snapshot | null }>(page, 'refs:getDetail', { id })
    if (!detail) throw new Error(`reference ${id} missing`)
    result.push({ id, title: detail.title, tags: detail.tags, boardIds: detail.boardIds })
  }
  return result
}

async function importTwelve(page: Page): Promise<number[]> {
  await drop(
    page,
    await makeImageTransfer(
      page,
      Array.from({ length: 12 }, (_, index) => index + 1),
    ),
  )
  await expect(cards(page)).toHaveCount(12)
  const view = await invoke<{ items: Array<{ id: number }> }>(page, 'refs:listBoard', {
    boardId: null,
    inTrash: false,
    tags: [],
    text: '',
  })
  return view.items.map((item) => item.id)
}

const selectionCount = (page: Page) => page.getByTestId('selection-count')
const trashCount = (page: Page) => page.getByTestId('trash-count')
const toastText = (page: Page) => page.getByTestId('toast-text')

test('delete 10 selected references, Ctrl+Z restores all 10 with tags and boards', async () => {
  const { page } = await launchApp()
  const ids = await importTwelve(page)

  // Give every reference tags and boards, then reload so the grid shows them.
  const forest = await invoke<{ board: { id: number } }>(page, 'boards:create', {
    name: 'Zone 2 forest',
  })
  const silhouettes = await invoke<{ board: { id: number } }>(page, 'boards:create', {
    name: 'Silhouettes',
  })
  for (const [index, id] of ids.entries()) {
    await invoke(page, 'refs:update', {
      id,
      tags: index % 2 === 0 ? ['forest', `t${index}`] : ['cave'],
      boardIds: index % 3 === 0 ? [forest.board.id, silhouettes.board.id] : [forest.board.id],
    })
  }
  await page.reload()
  await expect(cards(page)).toHaveCount(12)

  // Select the first ten: click, then Shift+click.
  await cards(page).nth(0).click()
  await cards(page)
    .nth(9)
    .click({ modifiers: ['Shift'] })
  await expect(selectionCount(page)).toHaveText('10 selected')
  const selectedIds = await cards(page).evaluateAll((elements) =>
    elements.slice(0, 10).map((element) => Number((element as HTMLElement).dataset['refId'])),
  )
  const before = await snapshot(page, selectedIds)

  await page.keyboard.press('Delete')
  await expect(cards(page)).toHaveCount(2)
  await expect(toastText(page)).toHaveText('Moved 10 references to Trash')
  await expect(page.getByRole('button', { name: /Undo/ })).toBeVisible()
  await expect(trashCount(page)).toHaveText('10')

  await page.keyboard.press('Control+z')
  await expect(cards(page)).toHaveCount(12)
  await expect(toastText(page)).toHaveText('Restored 10 references')
  await expect(trashCount(page)).toHaveText('0')
  await expect(selectionCount(page)).toHaveText('10 selected')
  expect(await snapshot(page, selectedIds)).toEqual(before)

  // The toast's Undo button does the same as Ctrl+Z.
  await cards(page).nth(11).click()
  await page.keyboard.press('Delete')
  await expect(cards(page)).toHaveCount(11)
  await page.getByRole('button', { name: /Undo/ }).click()
  await expect(cards(page)).toHaveCount(12)
})

test('Ctrl+click toggles and box select picks the cards under the box', async () => {
  const { page } = await launchApp()
  await importTwelve(page)

  await cards(page).nth(0).click()
  await cards(page)
    .nth(2)
    .click({ modifiers: ['Control'] })
  await cards(page)
    .nth(4)
    .click({ modifiers: ['Control'] })
  await expect(selectionCount(page)).toHaveText('3 selected')
  await cards(page)
    .nth(2)
    .click({ modifiers: ['Control'] })
  await expect(selectionCount(page)).toHaveText('2 selected')

  // Clicking empty space clears; dragging from empty space draws a box.
  const area = page.locator('.board-scroll')
  const box = await area.boundingBox()
  if (!box) throw new Error('no grid area')
  await page.mouse.click(box.x + 8, box.y + 8)
  await expect(selectionCount(page)).toHaveCount(0)

  // Drag from the empty corner across the top of the first two columns.
  // The Ctrl+clicks above scrolled the grid; start from the top.
  await area.evaluate((element) => element.scrollTo(0, 0))
  // Wait until every thumbnail has loaded, so the layout is final before dragging.
  await expect
    .poll(() =>
      page
        .locator('.ref-card img')
        .evaluateAll((images) => images.every((image) => (image as HTMLImageElement).complete)),
    )
    .toBe(true)
  const first = await cards(page).nth(0).boundingBox()
  if (!first) throw new Error('no cards')
  const end = { x: first.x + first.width + 40, y: first.y + 30 }
  await page.mouse.move(box.x + 6, box.y + 6)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 8 })
  await expect(page.locator('.box-select')).toBeVisible()

  // While the box is still drawn, find the cards it touches, in the layout the app sees.
  const rect = { left: box.x + 6, top: box.y + 6, right: end.x, bottom: end.y }
  const expected = await cards(page).evaluateAll(
    (elements, r) =>
      elements
        .filter((element) => {
          const b = element.getBoundingClientRect()
          return b.right >= r.left && b.left <= r.right && b.bottom >= r.top && b.top <= r.bottom
        })
        .map((element) => (element as HTMLElement).dataset['refId']),
    rect,
  )
  await page.mouse.up()
  await expect(page.locator('.box-select')).toHaveCount(0)

  // The selection is exactly those cards.
  const selected = await cards(page).evaluateAll((elements) =>
    elements
      .filter((element) => element.getAttribute('aria-pressed') === 'true')
      .map((element) => (element as HTMLElement).dataset['refId']),
  )
  expect(expected.length).toBeGreaterThanOrEqual(2)
  expect(selected.sort()).toEqual(expected.sort())

  // Ctrl+drag adds to the selection instead of replacing it.
  await cards(page)
    .last()
    .click({ modifiers: ['Control'] })
  await expect(selectionCount(page)).toHaveText(`${expected.length + 1} selected`)

  // Ctrl+A selects every card; Esc clears.
  await page.keyboard.press('Control+a')
  await expect(selectionCount(page)).toHaveText('12 selected')
  await page.keyboard.press('Escape')
  await expect(selectionCount(page)).toHaveCount(0)
})

test('Delete in a board removes from the board only, and Ctrl+Z puts it back', async () => {
  const { page } = await launchApp()
  const ids = await importTwelve(page)
  const board = await invoke<{ board: { id: number } }>(page, 'boards:create', {
    name: 'Zone 2 forest',
  })
  for (const id of ids.slice(0, 3)) {
    await invoke(page, 'refs:update', { id, boardIds: [board.board.id] })
  }
  await page.reload()
  await page.getByRole('button', { name: /^Zone 2 forest/ }).click()
  // Boards open as a canvas since Slice 3; this test covers the board's Grid view.
  await page.getByRole('button', { name: 'Grid', exact: true }).click()
  await expect(cards(page)).toHaveCount(3)

  await cards(page).nth(0).click()
  await page.keyboard.press('Delete')
  await expect(cards(page)).toHaveCount(2)
  await expect(toastText(page)).toHaveText(/Removed 1 reference from Zone 2 forest/)
  await expect(trashCount(page)).toHaveText('0')
  await page.getByRole('button', { name: /^All references/ }).click()
  await expect(cards(page)).toHaveCount(12)

  await page.keyboard.press('Control+z')
  await page.getByRole('button', { name: /^Zone 2 forest/ }).click()
  await expect(cards(page)).toHaveCount(3)

  // "Move to Trash" is still available inside a board, as a button.
  await cards(page).nth(0).click()
  await page.getByRole('button', { name: 'Move to Trash' }).click()
  await expect(cards(page)).toHaveCount(2)
  await expect(trashCount(page)).toHaveText('1')
})

test('Trash view restores a selection and Empty Trash deletes the files', async () => {
  const { page } = await launchApp()
  await importTwelve(page)
  expect(storedFiles(localAppData)).toHaveLength(24)

  await cards(page).nth(0).click()
  await cards(page)
    .nth(2)
    .click({ modifiers: ['Shift'] })
  await page.keyboard.press('Delete')
  await expect(cards(page)).toHaveCount(9)

  await page.getByRole('button', { name: /^Trash/ }).click()
  await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible()
  await expect(cards(page)).toHaveCount(3)

  // Restore one.
  await cards(page).nth(0).click()
  await page.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(cards(page)).toHaveCount(2)
  await expect(trashCount(page)).toHaveText('2')

  // Empty the rest: a confirmation first, Cancel keeps everything.
  await page.getByRole('button', { name: 'Empty Trash' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Empty Trash?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(cards(page)).toHaveCount(2)

  await page.getByRole('button', { name: 'Empty Trash' }).click()
  await dialog.getByRole('button', { name: 'Empty Trash' }).click()
  await expect(toastText(page)).toHaveText('Deleted 2 references and 4 files permanently')
  await expect(cards(page)).toHaveCount(0)
  await expect(trashCount(page)).toHaveText('0')
  expect(storedFiles(localAppData)).toHaveLength(20)

  await page.getByRole('button', { name: /^All references/ }).click()
  await expect(cards(page)).toHaveCount(10)
})
