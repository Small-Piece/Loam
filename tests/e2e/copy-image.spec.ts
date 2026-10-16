import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { drop, makeImageTransfer } from './fixtures.ts'
import { assertBuilt, launchApp } from './launch.ts'

// Temp data folders only. These tests write the system clipboard while they run.
let localAppData: string
let app: ElectronApplication | null = null

test.beforeAll(() => {
  assertBuilt()
})

test.beforeEach(() => {
  localAppData = mkdtempSync(join(tmpdir(), 'loam-e2e-copy-'))
})

test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = null
  rmSync(localAppData, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

const MARK_FORMAT = 'electron application/osclipboard;format="Loam References"'

async function invoke<T>(page: Page, channel: string, payload: unknown): Promise<T> {
  const reply = (await page.evaluate(([name, body]) => window.loam.invoke(name, body), [
    channel,
    payload,
  ] as const)) as { ok: boolean; data: T; error?: unknown }
  if (!reply.ok) throw new Error(`${channel}: ${JSON.stringify(reply.error)}`)
  return reply.data
}

/** The reference ids in Loam's clipboard marker, or null when there is none. */
async function markedIds(electronApp: ElectronApplication): Promise<number[] | null> {
  const text = await electronApp.evaluate(async ({ clipboard }, format) => {
    for (const item of await clipboard.read()) {
      if (item.types.includes(format)) return ((await item.getType(format)) as Blob).text()
    }
    return null
  }, MARK_FORMAT)
  return text === null
    ? null
    : (JSON.parse(text) as { refs: Array<{ id: number }> }).refs.map((ref) => ref.id)
}

/** Puts plain text on the clipboard, so the next check starts clean. */
async function resetClipboard(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ clipboard }) => clipboard.writeText('reset'))
}

/** What another Windows app sees: the clipboard image's size, read with .NET. */
function outsideImage(): string {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$image = [System.Windows.Forms.Clipboard]::GetImage()',
    'if ($image) { "$($image.Width)x$($image.Height)" } else { "none" }',
  ].join('; ')
  return run(script)
}

/** Another app copies an image of this size (and keeps it after it exits). */
function otherAppCopiesImage(width: number, height: number): void {
  run(
    [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      `$bitmap = New-Object System.Drawing.Bitmap ${width}, ${height}`,
      '[System.Windows.Forms.Clipboard]::SetDataObject($bitmap, $true)',
      '"ok"',
    ].join('; '),
  )
}

function run(script: string): string {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`powershell failed: ${result.stderr}`)
  return result.stdout.trim()
}

async function library(page: Page) {
  return invoke<{ totalCount: number; items: Array<{ id: number; title: string }> }>(
    page,
    'refs:listBoard',
    { boardId: null, inTrash: false, tags: [], text: '' },
  )
}

async function start(images: Array<{ index: number; width: number; height: number }>) {
  app = await launchApp(localAppData)
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'All references' })).toBeVisible()
  await drop(page, await makeImageTransfer(page, images))
  await expect(page.getByTestId('ref-card')).toHaveCount(images.length)
  const byTitle = new Map((await library(page)).items.map((item) => [item.title, item.id]))
  const ids = images.map((image) => byTitle.get(`ref-${String(image.index).padStart(2, '0')}`)!)
  return { electronApp: app, page, ids }
}

/**
 * The right-click menu is only as wide as its content (Slice 9.5: it used to stretch
 * from the pointer to the window's right edge).
 */
async function expectCompactMenu(page: Page): Promise<void> {
  const box = await page.getByRole('menu').boundingBox()
  expect(box).not.toBeNull()
  console.log(`[e2e] context menu ${Math.round(box!.width)} x ${Math.round(box!.height)} px`)
  expect(box!.width).toBeLessThan(300)
}

const toast = (page: Page) => page.getByTestId('toast-text')
const board = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Boards' })
    .getByRole('button', { name: new RegExp(`^${name}`) })

test('Ctrl+C on a Library tile gives other apps the full-size image; Ctrl+C in a text field copies text', async () => {
  const { electronApp, page, ids } = await start([{ index: 1, width: 1600, height: 1000 }])

  await page.getByTestId('ref-card').first().click()
  await page.keyboard.press('Control+c')
  await expect(toast(page)).toHaveText('Copied image')
  expect(await markedIds(electronApp)).toEqual(ids)
  // Another app (here .NET, as Paint and most Windows apps read it) gets the full-size image.
  const size = outsideImage()
  console.log(`[e2e] another app received ${size}`)
  expect(size).toBe('1600x1000')

  // In a text field Ctrl+C copies the selected text, not the selected image.
  await resetClipboard(electronApp)
  const search = page.getByRole('searchbox', { name: 'Search title and note' })
  await search.fill('lantern')
  await search.press('Control+a')
  await search.press('Control+c')
  await expect
    .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe('lantern')
  expect(await markedIds(electronApp)).toBeNull()
  await search.fill('')

  // The detail panel copies its image too.
  await resetClipboard(electronApp)
  await page.getByTestId('ref-card').first().click()
  await page.getByRole('button', { name: 'Copy image' }).click()
  await expect.poll(() => markedIds(electronApp)).toEqual(ids)
})

test('copy three on board A, paste on board B and in the Library; another app’s copy pastes as itself', async () => {
  const { electronApp, page, ids } = await start([
    { index: 1, width: 900, height: 600 },
    { index: 2, width: 700, height: 700 },
    { index: 3, width: 500, height: 800 },
  ])
  const a = (await invoke<{ board: { id: number } }>(page, 'boards:create', { name: 'Board A' }))
    .board.id
  const b = (await invoke<{ board: { id: number } }>(page, 'boards:create', { name: 'Board B' }))
    .board.id
  // One row, in this order: the first image is also the first in reading order.
  await invoke(page, 'boards:addRefs', { boardId: a, ids, at: null })
  await page.reload()

  await board(page, 'Board A').click()
  await expect(page.getByTestId('canvas-item')).toHaveCount(3)
  await page.getByTestId('canvas').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Control+c')
  await expect(toast(page)).toHaveText('Copied 3 images (other apps get the first)')
  expect(await markedIds(electronApp)).toEqual(ids)
  expect(outsideImage()).toBe('900x600')

  // Board B: the same references are placed; nothing new enters the Library.
  await board(page, 'Board B').click()
  await expect(page.getByTestId('canvas')).toBeVisible()
  await page.getByTestId('canvas').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+v')
  await expect(page.getByTestId('canvas-item')).toHaveCount(3)
  await expect(toast(page)).toHaveText('Placed 3 images from the clipboard')
  const placed = await invoke<{ items: Array<{ referenceId: number }> }>(page, 'canvas:get', {
    boardId: b,
  })
  expect(placed.items.map((item) => item.referenceId).sort()).toEqual([...ids].sort())
  expect((await library(page)).totalCount).toBe(3)

  // In the Library nothing is imported either.
  await page.getByRole('button', { name: /^All references/ }).click()
  await page.getByRole('heading', { name: 'All references' }).click()
  await page.keyboard.press('Control+v')
  await expect(toast(page)).toHaveText('3 images already in the Library')
  expect((await library(page)).totalCount).toBe(3)

  // Another app copies an image: Loam's marker is gone, and that image is what pastes.
  otherAppCopiesImage(321, 123)
  expect(await markedIds(electronApp)).toBeNull()
  await board(page, 'Board B').click()
  await expect(page.getByTestId('canvas-item')).toHaveCount(3)
  await page.getByTestId('canvas').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+v')
  await expect(page.getByTestId('canvas-item')).toHaveCount(4)
  const after = await library(page)
  expect(after.totalCount).toBe(4)
  const added = after.items.find((item) => !ids.includes(item.id))
  const detail = await invoke<{ detail: { imageWidth: number; imageHeight: number } }>(
    page,
    'refs:getDetail',
    { id: added?.id },
  )
  expect(detail.detail).toMatchObject({ imageWidth: 321, imageHeight: 123 })
})

test('right-click → Copy image in the Library grid, the viewer, the canvas and the Library panel', async () => {
  const { electronApp, page, ids } = await start([
    { index: 1, width: 800, height: 500 },
    { index: 2, width: 600, height: 600 },
  ])
  const [first, second] = ids as [number, number]
  const menuItem = page.getByRole('menuitem', { name: 'Copy image' })
  const card = (id: number) => page.locator(`[data-testid="ref-card"][data-ref-id="${id}"]`)

  // Library grid.
  await resetClipboard(electronApp)
  await card(second).click({ button: 'right' })
  await expectCompactMenu(page)
  await menuItem.click()
  await expect(toast(page)).toHaveText('Copied image')
  expect(await markedIds(electronApp)).toEqual([second])
  await expect(page.getByRole('menu')).toHaveCount(0)

  // Viewer: right-click, then Ctrl+C on the next image.
  await resetClipboard(electronApp)
  await card(first).dblclick()
  const viewer = page.getByRole('dialog', { name: 'Image viewer' })
  await expect(viewer).toBeVisible()
  const shown = await viewer.locator('.viewer-image').boundingBox()
  if (!shown) throw new Error('no viewer image')
  await page.mouse.click(shown.x + shown.width / 2, shown.y + shown.height / 2, { button: 'right' })
  await expectCompactMenu(page)
  await menuItem.click()
  await expect.poll(() => markedIds(electronApp)).toEqual([first])
  // Escape closes the menu first, the viewer only on the next press.
  await page.mouse.click(shown.x + shown.width / 2, shown.y + shown.height / 2, { button: 'right' })
  await expect(menuItem).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menuItem).toHaveCount(0)
  await expect(viewer).toBeVisible()
  await resetClipboard(electronApp)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Control+c')
  await expect.poll(() => markedIds(electronApp)).not.toBeNull()
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)

  // Canvas.
  const boardId = (
    await invoke<{ board: { id: number } }>(page, 'boards:create', { name: 'Canvas' })
  ).board.id
  await invoke(page, 'boards:addRefs', { boardId, ids: [first], at: null })
  await page.reload()
  await board(page, 'Canvas').click()
  await expect(page.getByTestId('canvas-item')).toHaveCount(1)
  await resetClipboard(electronApp)
  await page.getByTestId('canvas-item').first().click({ button: 'right' })
  await expectCompactMenu(page)
  await menuItem.click()
  await expect.poll(() => markedIds(electronApp)).toEqual([first])

  // Library panel beside the canvas: right-click, and Ctrl+C on its selection, not the canvas's.
  const tile = (id: number) => page.locator(`[data-testid="library-item"][data-ref-id="${id}"]`)
  await resetClipboard(electronApp)
  await tile(second).click({ button: 'right' })
  await expectCompactMenu(page)
  await menuItem.click()
  await expect.poll(() => markedIds(electronApp)).toEqual([second])
  await page.getByTestId('canvas-item').first().click()
  await resetClipboard(electronApp)
  await tile(second).click()
  await page.keyboard.press('Control+c')
  await expect.poll(() => markedIds(electronApp)).toEqual([second])
})
