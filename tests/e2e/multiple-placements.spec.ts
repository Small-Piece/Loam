import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { drop, makeImageTransfer } from './fixtures.ts'
import { assertBuilt, launchApp as launch } from './launch.ts'

// Temp data folder only.
let localAppData: string
let running: ElectronApplication[] = []

async function launchApp(): Promise<Page> {
  const app = await launch(localAppData)
  running.push(app)
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'All references' })).toBeVisible()
  return page
}

async function closeAll(): Promise<void> {
  for (const app of running) await app.close().catch(() => undefined)
  running = []
}

test.beforeAll(() => {
  assertBuilt()
})

test.beforeEach(() => {
  localAppData = mkdtempSync(join(tmpdir(), 'loam-e2e-placements-'))
})

test.afterEach(async () => {
  await closeAll()
  rmSync(localAppData, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

interface Item {
  id: number
  referenceId: number
  x: number
  y: number
  scale: number
  z: number
}

interface Note {
  id: number
  attachedItemId: number | null
}

async function invoke<T>(page: Page, channel: string, payload: unknown): Promise<T> {
  const reply = (await page.evaluate(([name, body]) => window.loam.invoke(name, body), [
    channel,
    payload,
  ] as const)) as { ok: boolean; data: T; error?: unknown }
  if (!reply.ok) throw new Error(`${channel} failed: ${JSON.stringify(reply.error)}`)
  return reply.data
}

async function canvasView(page: Page, boardId: number): Promise<{ items: Item[]; notes: Note[] }> {
  return invoke(page, 'canvas:get', { boardId })
}

/** The number beside the board in the sidebar data. */
async function boardCount(page: Page, boardId: number): Promise<number | undefined> {
  const view = await invoke<{ boards: Array<{ id: number; count: number }> }>(
    page,
    'refs:listBoard',
    { boardId: null, inTrash: false, tags: [], text: '' },
  )
  return view.boards.find((board) => board.id === boardId)?.count
}

/** Drops small images into the Library, then makes a canvas board; returns its id. */
async function libraryAndBoard(page: Page, images: number, name: string): Promise<number> {
  await drop(
    page,
    await makeImageTransfer(
      page,
      Array.from({ length: images }, (_, index) => ({ index: index + 1, width: 160, height: 120 })),
    ),
  )
  await expect(page.getByTestId('ref-card')).toHaveCount(images)
  await page.getByRole('button', { name: 'New board' }).click()
  await page.getByRole('textbox', { name: 'New board name' }).fill(name)
  await page.getByRole('textbox', { name: 'New board name' }).press('Enter')
  await expect(page.getByTestId('canvas')).toBeVisible()
  await expect(page.getByTestId('library-item')).toHaveCount(images)
  const view = await invoke<{ boards: Array<{ id: number; name: string }> }>(
    page,
    'refs:listBoard',
    { boardId: null, inTrash: false, tags: [], text: '' },
  )
  const board = view.boards.find((entry) => entry.name === name)
  if (!board) throw new Error('board not created')
  return board.id
}

const items = (page: Page) => page.getByTestId('canvas-item')
const itemEl = (page: Page, id: number) => page.locator(`[data-item-id="${id}"]`)
const notes = (page: Page) => page.getByTestId('canvas-note')
const tiles = (page: Page) => page.getByTestId('library-item')

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error('not visible')
  return box
}

/**
 * Drags with the mouse from a point by (dx, dy). Alt is held from the press (a copy);
 * Shift is pressed halfway, as a person does to attach a note on drop (Shift at the
 * press would toggle the selection instead).
 */
async function dragBy(
  page: Page,
  from: { x: number; y: number },
  dx: number,
  dy: number,
  modifier?: 'Alt' | 'Shift',
) {
  if (modifier === 'Alt') await page.keyboard.down('Alt')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 4 })
  if (modifier === 'Shift') await page.keyboard.down('Shift')
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 })
  await page.mouse.up()
  if (modifier) await page.keyboard.up(modifier)
}

/** Drags the first Library tile onto the canvas at a fraction of its size. */
async function dropTile(page: Page, tile: Locator, fx: number, fy: number) {
  const area = await boxOf(page.getByTestId('canvas'))
  await tile.dragTo(page.getByTestId('canvas'), {
    targetPosition: { x: area.width * fx, y: area.height * fy },
  })
}

test('the same image dropped three times: three items, each kept in its own place and size after a restart', async () => {
  let page = await launchApp()
  const boardId = await libraryAndBoard(page, 1, 'Repeats')

  for (const [index, fx] of [0.2, 0.5, 0.8].entries()) {
    await dropTile(page, tiles(page).first(), fx, 0.3)
    await expect(items(page)).toHaveCount(index + 1)
  }
  // The tile is marked as on this board and can still be dragged.
  await expect(tiles(page).first()).toHaveClass(/on-board/)
  const placed = (await canvasView(page, boardId)).items
  expect(new Set(placed.map((item) => item.id)).size).toBe(3)
  expect(new Set(placed.map((item) => item.referenceId)).size).toBe(1)
  // The board counts the image once.
  expect(await boardCount(page, boardId)).toBe(1)

  // Resize the middle copy only, from its corner handle.
  const middle = [...placed].sort((a, b) => a.x - b.x)[1]!
  await itemEl(page, middle.id).click()
  const handle = await boxOf(itemEl(page, middle.id).locator('[data-handle="se"]'))
  await dragBy(page, { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, 60, 45)
  await expect
    .poll(
      async () =>
        (await canvasView(page, boardId)).items.find((item) => item.id === middle.id)?.scale,
    )
    .toBeGreaterThan(middle.scale)
  const before = (await canvasView(page, boardId)).items
  const scales = before.map((item) => item.scale)
  expect(new Set(scales).size).toBe(2)
  expect(new Set(before.map((item) => item.x)).size).toBe(3)

  await closeAll()
  page = await launchApp()
  await page.getByRole('button', { name: /^Repeats/ }).click()
  await expect(items(page)).toHaveCount(3)
  expect((await canvasView(page, boardId)).items).toEqual(before)
})

test('Ctrl+D and Alt+drag copy; Delete removes only the selected copy and Ctrl+Z brings it back; a note follows its own copy', async () => {
  const page = await launchApp()
  const boardId = await libraryAndBoard(page, 1, 'Copies')
  await dropTile(page, tiles(page).first(), 0.25, 0.25)
  await expect(items(page)).toHaveCount(1)
  const [original] = (await canvasView(page, boardId)).items
  if (!original) throw new Error('no item')

  // Ctrl+D: a copy, slightly offset, same size, selected instead of the original.
  await itemEl(page, original.id).click()
  await page.keyboard.press('Control+d')
  await expect(items(page)).toHaveCount(2)
  const afterDuplicate = (await canvasView(page, boardId)).items
  const duplicate = afterDuplicate.find((item) => item.id !== original.id)!
  expect(duplicate).toMatchObject({ referenceId: original.referenceId, scale: original.scale })
  expect(duplicate.x).toBeGreaterThan(original.x)
  expect(duplicate.y).toBeGreaterThan(original.y)
  expect(duplicate.z).toBeGreaterThan(original.z)
  await expect(itemEl(page, duplicate.id)).toHaveAttribute('aria-selected', 'true')
  await expect(itemEl(page, original.id)).toHaveAttribute('aria-selected', 'false')
  expect(afterDuplicate.find((item) => item.id === original.id)).toEqual(original)

  // Alt+drag from the original (its top-left corner, clear of the copy): a copy moves, it stays.
  const originalBox = await boxOf(itemEl(page, original.id))
  await dragBy(page, { x: originalBox.x + 8, y: originalBox.y + 8 }, 260, 0, 'Alt')
  await expect(items(page)).toHaveCount(3)
  const afterAltDrag = (await canvasView(page, boardId)).items
  expect(afterAltDrag.find((item) => item.id === original.id)).toEqual(original)
  const dragged = afterAltDrag.find((item) => item.id !== original.id && item.id !== duplicate.id)!
  expect(dragged.referenceId).toBe(original.referenceId)
  expect(dragged.x).toBeGreaterThan(original.x + 100)
  await expect(itemEl(page, dragged.id)).toHaveAttribute('aria-selected', 'true')

  // Delete removes only the selected copy; Ctrl+Z brings exactly it back.
  await page.keyboard.press('Delete')
  await expect(items(page)).toHaveCount(2)
  expect((await canvasView(page, boardId)).items).toEqual(afterDuplicate)
  await page.keyboard.press('Control+z')
  await expect(items(page)).toHaveCount(3)
  expect((await canvasView(page, boardId)).items).toEqual(afterAltDrag)

  // A note attached to the dragged copy (Shift+drop onto it) moves with that copy only.
  const canvasBox = await boxOf(page.getByTestId('canvas'))
  const spot = { x: canvasBox.x + canvasBox.width * 0.3, y: canvasBox.y + canvasBox.height * 0.75 }
  await page.mouse.dblclick(spot.x, spot.y)
  await expect(page.getByRole('textbox', { name: 'Note text' })).toBeFocused()
  await page.keyboard.type('only this one')
  await page.keyboard.press('Escape')
  await expect(notes(page)).toHaveCount(1)
  const noteBox = await boxOf(notes(page).first())
  const target = await boxOf(itemEl(page, dragged.id))
  await dragBy(
    page,
    { x: noteBox.x + 6, y: noteBox.y + 6 },
    target.x + 20 - noteBox.x,
    target.y + 20 - noteBox.y,
    'Shift',
  )
  await expect
    .poll(async () => (await canvasView(page, boardId)).notes[0]?.attachedItemId)
    .toBe(dragged.id)

  // Moving another copy of the same image leaves the note where it is.
  const noteStill = await boxOf(notes(page).first())
  const duplicateBox = await boxOf(itemEl(page, duplicate.id))
  await dragBy(
    page,
    { x: duplicateBox.x + duplicateBox.width - 8, y: duplicateBox.y + duplicateBox.height - 8 },
    0,
    120,
  )
  await expect
    .poll(async () => (await canvasView(page, boardId)).items.find((i) => i.id === duplicate.id)?.y)
    .not.toBe(duplicate.y)
  expect(await boxOf(notes(page).first())).toEqual(noteStill)

  // Moving its own copy takes the note along by the same amount.
  const ownBox = await boxOf(itemEl(page, dragged.id))
  await dragBy(page, { x: ownBox.x + ownBox.width - 8, y: ownBox.y + ownBox.height - 8 }, 0, 90)
  await expect
    .poll(async () => Math.round((await boxOf(notes(page).first())).y - noteStill.y))
    .toBeGreaterThan(60)
  const movedNote = await boxOf(notes(page).first())
  const movedOwn = await boxOf(itemEl(page, dragged.id))
  expect(Math.round(movedNote.y - noteStill.y)).toBe(Math.round(movedOwn.y - ownBox.y))
})

test('Ctrl/Shift select five Library tiles and drag them onto the canvas: five placements side by side', async () => {
  const page = await launchApp()
  const boardId = await libraryAndBoard(page, 5, 'Batch')
  const list = page.getByRole('listbox', { name: 'Library references' })
  const selected = list.getByRole('option', { selected: true })

  // A plain click selects one; Shift extends a range; Ctrl adds or removes one.
  await tiles(page).nth(0).click()
  await expect(selected).toHaveCount(1)
  await tiles(page)
    .nth(3)
    .click({ modifiers: ['Shift'] })
  await expect(selected).toHaveCount(4)
  await tiles(page)
    .nth(4)
    .click({ modifiers: ['Control'] })
  await expect(selected).toHaveCount(5)
  await tiles(page)
    .nth(4)
    .click({ modifiers: ['Control'] })
  await expect(selected).toHaveCount(4)
  await tiles(page).nth(1).click()
  await expect(selected).toHaveCount(1)
  await tiles(page).nth(0).click()
  await tiles(page)
    .nth(4)
    .click({ modifiers: ['Shift'] })
  await expect(selected).toHaveCount(5)

  // Dragging any selected tile drags all five.
  await dropTile(page, tiles(page).nth(2), 0.5, 0.5)
  await expect(items(page)).toHaveCount(5)
  const placed = (await canvasView(page, boardId)).items
  expect(new Set(placed.map((item) => item.referenceId)).size).toBe(5)
  expect(await boardCount(page, boardId)).toBe(5)

  // Side by side: one row, no two overlapping.
  const boxes = await Promise.all(placed.map((item) => boxOf(itemEl(page, item.id))))
  boxes.sort((a, b) => a.x - b.x)
  for (const [index, box] of boxes.entries()) {
    expect(Math.abs(box.y - boxes[0]!.y)).toBeLessThan(2)
    if (index > 0) expect(box.x).toBeGreaterThan(boxes[index - 1]!.x + boxes[index - 1]!.width)
  }

  // The tiles show they are on the board, and a plain drag of one places it again.
  await expect(list.locator('.library-item.on-board')).toHaveCount(5)
  await tiles(page).nth(0).click()
  await expect(selected).toHaveCount(1)
  await dropTile(page, tiles(page).nth(0), 0.5, 0.85)
  await expect(items(page)).toHaveCount(6)
  expect(await boardCount(page, boardId)).toBe(5)
})
