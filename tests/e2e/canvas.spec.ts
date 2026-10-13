import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { drop, makeImageTransfer } from './fixtures.ts'
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
  localAppData = mkdtempSync(join(tmpdir(), 'loam-e2e-canvas-'))
})

test.afterEach(async () => {
  for (const app of running) await app.close().catch(() => undefined)
  running = []
  rmSync(localAppData, { recursive: true, force: true })
})

interface Item {
  referenceId: number
  x: number
  y: number
  scale: number
  z: number
  title: string
  imageWidth: number
  imageHeight: number
}

async function invoke<T>(page: Page, channel: string, payload: unknown): Promise<T> {
  const reply = (await page.evaluate(([name, body]) => window.loam.invoke(name, body), [
    channel,
    payload,
  ] as const)) as { ok: boolean; data: T; error?: unknown }
  if (!reply.ok) throw new Error(`${channel} failed: ${JSON.stringify(reply.error)}`)
  return reply.data
}

async function canvasItems(page: Page, boardId: number): Promise<Item[]> {
  return (await invoke<{ items: Item[] }>(page, 'canvas:get', { boardId })).items
}

async function createBoard(page: Page, name: string): Promise<number> {
  await page.getByRole('button', { name: 'New board' }).click()
  await page.getByRole('textbox', { name: 'New board name' }).fill(name)
  await page.getByRole('textbox', { name: 'New board name' }).press('Enter')
  await expect(page.getByTestId('canvas')).toBeVisible()
  const view = await invoke<{ boards: Array<{ id: number; name: string }> }>(
    page,
    'refs:listBoard',
    {
      boardId: null,
      inTrash: false,
      tags: [],
      text: '',
    },
  )
  const board = view.boards.find((entry) => entry.name === name)
  if (!board) throw new Error('board not created')
  return board.id
}

const items = (page: Page) => page.getByTestId('canvas-item')
const viewer = (page: Page) => page.getByRole('dialog', { name: 'Image viewer' })

async function zoomPercent(page: Page): Promise<number> {
  return Number((await page.getByTestId('canvas-zoom').innerText()).replace('%', ''))
}

async function center(page: Page, index: number): Promise<{ x: number; y: number }> {
  const box = await items(page).nth(index).boundingBox()
  if (!box) throw new Error('item not visible')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

test('drop, move, scale, restack, pan, zoom and view on the canvas; layout identical after restart', async () => {
  const { page } = await launchApp()
  const boardId = await createBoard(page, 'Zone 2 forest')
  await expect(page.getByRole('button', { name: 'Canvas', pressed: true })).toBeVisible()

  // Drop three files onto the canvas: they land around the drop point.
  const canvasBox = await page.getByTestId('canvas').boundingBox()
  if (!canvasBox) throw new Error('no canvas')
  const transfer = await makeImageTransfer(page, [
    { index: 1, width: 1600, height: 1000, type: 'image/jpeg' },
    { index: 2, width: 900, height: 1200, type: 'image/jpeg' },
    { index: 3, width: 1200, height: 1200, type: 'image/jpeg' },
  ])
  await page.evaluate(
    ([dataTransfer, x, y]) => {
      const target = document.querySelector('[data-testid="canvas"]')
      if (!target) throw new Error('no canvas')
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer,
            clientX: x,
            clientY: y,
          }),
        )
      }
    },
    [transfer, canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2] as const,
  )
  await expect(items(page)).toHaveCount(3)
  // New images are also in the Library.
  await expect(page.getByTestId('library-item')).toHaveCount(3)

  // Fit all, then work at a known zoom.
  await page.getByTestId('canvas').click({ position: { x: 5, y: canvasBox.height - 40 } })
  await page.keyboard.press('f')
  const fitted = await zoomPercent(page)
  expect(fitted).toBeGreaterThan(0)
  const dataId = await items(page).nth(0).getAttribute('data-ref-id')

  // Move: drag the first item by (120, 80) screen pixels.
  let before = await canvasItems(page, boardId)
  // Exact zoom from the first item's drawn width (the HUD label is rounded).
  const firstStored = before.find((i) => i.referenceId === Number(dataId))
  const drawnWidth = (await items(page).nth(0).boundingBox())?.width ?? 0
  const scale = drawnWidth / ((firstStored?.imageWidth ?? 1) * (firstStored?.scale ?? 1))
  const first = await center(page, 0)
  await page.mouse.move(first.x, first.y)
  await page.mouse.down()
  await page.mouse.move(first.x + 120, first.y + 80, { steps: 8 })
  await page.mouse.up()
  const firstId = Number(dataId)
  await expect
    .poll(async () => (await canvasItems(page, boardId)).find((i) => i.referenceId === firstId)?.x)
    .not.toBe(before.find((i) => i.referenceId === firstId)?.x)
  let after = await canvasItems(page, boardId)
  const moved = after.find((i) => i.referenceId === firstId)
  const original = before.find((i) => i.referenceId === firstId)
  expect(moved?.x).toBeCloseTo((original?.x ?? 0) + 120 / scale, 0)
  expect(moved?.y).toBeCloseTo((original?.y ?? 0) + 80 / scale, 0)

  // Scale: drag the selected item's bottom-right handle outwards; the ratio is kept.
  const handle = items(page).nth(0).locator('[data-handle="se"]')
  const handleBox = await handle.boundingBox()
  if (!handleBox) throw new Error('no handle')
  before = after
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(handleBox.x + 90, handleBox.y + 60, { steps: 8 })
  await page.mouse.up()
  await expect
    .poll(
      async () => (await canvasItems(page, boardId)).find((i) => i.referenceId === firstId)?.scale,
    )
    .toBeGreaterThan(moved?.scale ?? 0)
  after = await canvasItems(page, boardId)
  const scaled = after.find((i) => i.referenceId === firstId)
  expect(scaled?.x).toBeCloseTo(moved?.x ?? 0, 3) // top-left corner stays put
  expect(scaled?.y).toBeCloseTo(moved?.y ?? 0, 3)
  const domBox = await items(page).nth(0).boundingBox()
  expect((domBox?.width ?? 0) / (domBox?.height ?? 1)).toBeCloseTo(
    (scaled?.imageWidth ?? 1) / (scaled?.imageHeight ?? 1),
    2,
  )

  // Send to back with [ and bring to front with ].
  await page.keyboard.press('[')
  await expect
    .poll(async () => {
      const list = await canvasItems(page, boardId)
      return Math.min(...list.map((i) => i.z)) === list.find((i) => i.referenceId === firstId)?.z
    })
    .toBe(true)
  await page.keyboard.press(']')
  await expect
    .poll(async () => {
      const list = await canvasItems(page, boardId)
      return Math.max(...list.map((i) => i.z)) === list.find((i) => i.referenceId === firstId)?.z
    })
    .toBe(true)

  // Space + drag pans the view (items stay put in canvas units), and never opens the viewer.
  const stored = await canvasItems(page, boardId)
  const beforePan = await center(page, 0)
  const empty = { x: canvasBox.x + 20, y: canvasBox.y + canvasBox.height - 30 }
  await page.mouse.move(empty.x, empty.y)
  await page.keyboard.down(' ')
  await page.mouse.down()
  await page.mouse.move(empty.x + 100, empty.y - 50, { steps: 6 })
  await page.mouse.up()
  await page.keyboard.up(' ')
  const afterPan = await center(page, 0)
  expect(afterPan.x - beforePan.x).toBeCloseTo(100, 0)
  expect(afterPan.y - beforePan.y).toBeCloseTo(-50, 0)
  await expect(viewer(page)).toHaveCount(0)
  expect(await canvasItems(page, boardId)).toEqual(stored)

  // Middle-button drag pans too.
  await page.mouse.move(empty.x, empty.y)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(empty.x - 60, empty.y, { steps: 4 })
  await page.mouse.up({ button: 'middle' })
  expect((await center(page, 0)).x - afterPan.x).toBeCloseTo(-60, 0)

  // Wheel zooms around the cursor; F fits everything again.
  const zoomBefore = await zoomPercent(page)
  await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2)
  await page.mouse.wheel(0, -300)
  await expect.poll(() => zoomPercent(page)).toBeGreaterThan(zoomBefore)
  await page.keyboard.press('f')
  // Fit: every item is inside the canvas again.
  await expect
    .poll(() =>
      items(page).evaluateAll(
        (elements, area) =>
          elements.every((element) => {
            const r = element.getBoundingClientRect()
            return (
              r.left >= area.x - 1 &&
              r.top >= area.y - 1 &&
              r.right <= area.x + area.width + 1 &&
              r.bottom <= area.y + area.height + 1
            )
          }),
        canvasBox,
      ),
    )
    .toBe(true)

  // Double-click opens the viewer; Esc closes it.
  await items(page).nth(1).dblclick()
  await expect(viewer(page)).toBeVisible()
  await expect(page.getByTestId('viewer-position')).toHaveText(/\/ 3$/)
  await page.keyboard.press('Escape')
  await expect(viewer(page)).toHaveCount(0)

  // Restart: placements and the on-screen layout are identical.
  const layout = await canvasItems(page, boardId)
  const rects = await items(page).evaluateAll((elements) =>
    elements.map((element) => {
      const r = element.getBoundingClientRect()
      return [
        (element as HTMLElement).dataset['refId'],
        Math.round(r.x),
        Math.round(r.y),
        Math.round(r.width),
        Math.round(r.height),
      ]
    }),
  )
  for (const app of running) await app.close()
  running = []

  const { page: again } = await launchApp()
  await again.getByRole('button', { name: /^Zone 2 forest/ }).click()
  await expect(items(again)).toHaveCount(3)
  expect(await canvasItems(again, boardId)).toEqual(layout)
  await expect
    .poll(() =>
      items(again).evaluateAll((elements) =>
        elements.map((element) => {
          const r = element.getBoundingClientRect()
          return [
            (element as HTMLElement).dataset['refId'],
            Math.round(r.x),
            Math.round(r.y),
            Math.round(r.width),
            Math.round(r.height),
          ]
        }),
      ),
    )
    .toEqual(rects)
})

test('Delete on the canvas removes from the board only; Ctrl+Z puts it back exactly', async () => {
  const { page } = await launchApp()
  await drop(page, await makeImageTransfer(page, [1, 2]))
  await expect(page.getByTestId('ref-card')).toHaveCount(2)
  const boardId = await createBoard(page, 'Silhouettes')
  // Drop the two Library items side by side.
  const area = await page.getByTestId('canvas').boundingBox()
  if (!area) throw new Error('no canvas')
  // The Library panel loads after the board opens; .all() does not wait, so
  // wait for both items first or only the ones already listed get dragged.
  await expect(page.getByTestId('library-item')).toHaveCount(2)
  const cards = await page.getByTestId('library-item').all()
  for (const [index, card] of cards.entries()) {
    await card.dragTo(page.getByTestId('canvas'), {
      targetPosition: { x: area.width * (0.25 + index * 0.5), y: area.height * 0.5 },
    })
  }
  await expect(items(page)).toHaveCount(2)
  const before = await canvasItems(page, boardId)

  await items(page).nth(0).click()
  await page.keyboard.press('Delete')
  await expect(items(page)).toHaveCount(1)
  await expect(page.getByTestId('toast-text')).toHaveText(/still in the Library/)
  const library = await invoke<{ totalCount: number; trashCount: number }>(page, 'refs:listBoard', {
    boardId: null,
    inTrash: false,
    tags: [],
    text: '',
  })
  expect(library).toMatchObject({ totalCount: 2, trashCount: 0 })
  await expect(page.getByTestId('library-item')).toHaveCount(2)

  await page.keyboard.press('Control+z')
  await expect(items(page)).toHaveCount(2)
  expect(await canvasItems(page, boardId)).toEqual(before)

  // A move is undoable too.
  const start = await center(page, 0)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 50, start.y + 50, { steps: 4 })
  await page.mouse.up()
  await expect
    .poll(async () => JSON.stringify(await canvasItems(page, boardId)))
    .not.toBe(JSON.stringify(before))
  await page.keyboard.press('Control+z')
  await expect.poll(async () => canvasItems(page, boardId)).toEqual(before)

  // The Grid view of the same board shows the same members; the toggle is remembered.
  await page.getByRole('button', { name: 'Grid', exact: true }).click()
  await expect(page.getByTestId('ref-card')).toHaveCount(2)
  await page.getByRole('button', { name: /^All references/ }).click()
  await page.getByRole('button', { name: /^Silhouettes/ }).click()
  await expect(page.getByTestId('ref-card')).toHaveCount(2)
  await page.getByRole('button', { name: 'Canvas', exact: true }).click()
  await expect(items(page)).toHaveCount(2)
})

test('Library drag places on the canvas once; paste lands mid-view', async () => {
  const { app, page } = await launchApp()
  await drop(page, await makeImageTransfer(page, [1]))
  await expect(page.getByTestId('ref-card')).toHaveCount(1)
  const boardId = await createBoard(page, 'Paste test')

  const canvasBox = await page.getByTestId('canvas').boundingBox()
  if (!canvasBox) throw new Error('no canvas')
  await page
    .getByTestId('library-item')
    .first()
    .dragTo(page.getByTestId('canvas'), {
      targetPosition: { x: canvasBox.width * 0.3, y: canvasBox.height * 0.4 },
    })
  await expect(items(page)).toHaveCount(1)
  // Dragging the same reference again does not duplicate it.
  await page.getByTestId('library-item').first().dragTo(page.getByTestId('canvas'))
  await expect(items(page)).toHaveCount(1)

  // Paste a screenshot: it enters the Library and lands in the middle of the view.
  await app.evaluate(async ({ clipboard, ClipboardItem, nativeImage }) => {
    const pixels = Buffer.alloc(80 * 60 * 4, 180)
    const png = nativeImage.createFromBitmap(pixels, { width: 80, height: 60 }).toPNG()
    await clipboard.write([
      new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) }),
    ])
  })
  await page.getByTestId('canvas').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+v')
  await expect(items(page)).toHaveCount(2)
  await expect(page.getByTestId('library-item')).toHaveCount(2)
  const pasted = (await canvasItems(page, boardId)).find((i) => i.title.startsWith('Pasted image'))
  if (!pasted) throw new Error('pasted item missing')
  const pastedEl = items(page).and(page.locator(`[data-ref-id="${pasted.referenceId}"]`))
  const box = await pastedEl.boundingBox()
  expect(
    Math.abs((box?.x ?? 0) + (box?.width ?? 0) / 2 - (canvasBox.x + canvasBox.width / 2)),
  ).toBeLessThan(4)
})
