import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { cards, drop, makeImageTransfer } from './fixtures.ts'
import { assertBuilt, launchApp as launch } from './launch.ts'

let localAppData: string
let running: ElectronApplication[] = []

async function launchApp(): Promise<Page> {
  const app = await launch(localAppData)
  running.push(app)
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'All references' })).toBeVisible()
  return page
}

test.beforeAll(() => {
  assertBuilt()
})

test.beforeEach(() => {
  localAppData = mkdtempSync(join(tmpdir(), 'loam-e2e-viewer-'))
})

test.afterEach(async () => {
  for (const app of running) await app.close().catch(() => undefined)
  running = []
  rmSync(localAppData, { recursive: true, force: true })
})

const viewer = (page: Page) => page.getByRole('dialog', { name: 'Image viewer' })
const position = (page: Page) => page.getByTestId('viewer-position')
const zoom = (page: Page) => page.getByTestId('viewer-zoom')

async function zoomPercent(page: Page): Promise<number> {
  return Number((await zoom(page).innerText()).replace('%', ''))
}

async function transformOf(page: Page): Promise<string> {
  return page.locator('.viewer-image').evaluate((image) => (image as HTMLElement).style.transform)
}

test('viewer keys: open, 1, 0, wheel, drag, arrows within the filter, Esc and Space', async () => {
  const page = await launchApp()
  await drop(
    page,
    await makeImageTransfer(page, [
      { index: 1, width: 1920, height: 1080, type: 'image/jpeg' },
      { index: 2, width: 800, height: 1200, type: 'image/jpeg' },
      { index: 3, width: 3000, height: 2000, type: 'image/jpeg' },
    ]),
  )
  await expect(cards(page)).toHaveCount(3)

  // Double-click opens the viewer on that card; newest import is first.
  await cards(page).nth(0).dblclick()
  await expect(viewer(page)).toBeVisible()
  await expect(viewer(page)).toHaveAttribute('data-ready', 'true')
  await expect(position(page)).toHaveText('1 / 3')
  await expect(viewer(page).getByText('ref-03', { exact: true })).toBeVisible()
  const fit = await zoomPercent(page)
  expect(fit).toBeLessThan(100) // 3000x2000 does not fit the window at 100 %

  await page.keyboard.press('1')
  await expect(zoom(page)).toHaveText('100%')
  await page.keyboard.press('0')
  await expect(zoom(page)).toHaveText(`${fit}%`)

  // Wheel zooms in around the cursor.
  const stage = await page.locator('.viewer-stage').boundingBox()
  if (!stage) throw new Error('no stage')
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2)
  await page.mouse.wheel(0, -400)
  await expect.poll(() => zoomPercent(page)).toBeGreaterThan(fit)

  // Dragging pans.
  const before = await transformOf(page)
  await page.mouse.down()
  await page.mouse.move(stage.x + stage.width / 2 + 120, stage.y + stage.height / 2 + 60, {
    steps: 6,
  })
  await page.mouse.up()
  await expect.poll(() => transformOf(page)).not.toBe(before)

  // Arrows step through the list and stop at the ends.
  await page.keyboard.press('ArrowRight')
  await expect(position(page)).toHaveText('2 / 3')
  await page.keyboard.press('ArrowRight')
  await expect(position(page)).toHaveText('3 / 3')
  await page.keyboard.press('ArrowRight')
  await expect(position(page)).toHaveText('3 / 3')
  await page.keyboard.press('ArrowLeft')
  await expect(position(page)).toHaveText('2 / 3')
  // A new image opens fitted (not at the zoom of the previous one): 0 changes nothing.
  const fitted = await zoom(page).innerText()
  expect(Number(fitted.replace('%', ''))).toBeLessThanOrEqual(100)
  await page.keyboard.press('1')
  await expect(zoom(page)).toHaveText('100%')
  await page.keyboard.press('0')
  await expect(zoom(page)).toHaveText(fitted)

  // Esc closes and leaves the last viewed card selected.
  await page.keyboard.press('Escape')
  await expect(viewer(page)).toHaveCount(0)
  await expect(cards(page).nth(1)).toHaveAttribute('aria-pressed', 'true')

  // Space opens the selected card; Space again closes.
  await page.keyboard.press(' ')
  await expect(viewer(page)).toBeVisible()
  await expect(position(page)).toHaveText('2 / 3')
  await page.keyboard.press(' ')
  await expect(viewer(page)).toHaveCount(0)

  // Arrows follow the current filter: only matching references are in the list.
  await page.getByRole('searchbox', { name: 'Search title and note' }).fill('ref-01')
  await expect(cards(page)).toHaveCount(1)
  await cards(page).nth(0).dblclick()
  await expect(position(page)).toHaveText('1 / 1')
  await page.keyboard.press('ArrowRight')
  await expect(position(page)).toHaveText('1 / 1')
  await page.keyboard.press('Escape')
  await expect(viewer(page)).toHaveCount(0)
})

test('a 6000 px image opens in under 300 ms and zooms smoothly to 800 %', async () => {
  const page = await launchApp()
  await drop(
    page,
    await makeImageTransfer(page, [
      { index: 1, width: 6000, height: 4000, type: 'image/jpeg', grain: true },
    ]),
  )
  await expect(cards(page)).toHaveCount(1, { timeout: 20_000 })
  const detail = page.getByRole('complementary', { name: 'Reference detail' })
  await expect(detail.getByText(/6000 × 4000/)).toBeVisible()
  const sizeText = await detail.getByText(/JPEG/).innerText()

  // Open with Space, three times: the first open reads the file from disk.
  const openTimes: number[] = []
  for (let attempt = 0; attempt < 3; attempt++) {
    await cards(page).nth(0).click()
    await page.keyboard.press(' ')
    await expect(viewer(page)).toHaveAttribute('data-ready', 'true')
    await expect(viewer(page)).toHaveAttribute('data-open-ms', /\d/)
    openTimes.push(Number(await viewer(page).getAttribute('data-open-ms')))
    if (attempt < 2) {
      await page.keyboard.press('Escape')
      await expect(viewer(page)).toHaveCount(0)
    }
  }
  console.log(`[e2e] 6000x4000 JPEG (${sizeText}) open times: ${openTimes.join(', ')} ms`)
  for (const ms of openTimes) expect(ms).toBeLessThan(300)

  // Zoom from fit to 800 % with one wheel step per frame, timing every frame.
  const run = await page.evaluate(async () => {
    const stage = document.querySelector('.viewer-stage')
    const label = document.querySelector('[data-testid="viewer-zoom"]')
    if (!stage || !label) throw new Error('viewer missing')
    const rect = stage.getBoundingClientRect()
    const x = rect.left + rect.width * 0.6
    const y = rect.top + rect.height * 0.4
    const percent = () => Number(label.textContent?.replace('%', '') ?? '0')
    const intervals: number[] = []
    let last = performance.now()
    let frames = 0
    while (percent() < 800 && frames < 400) {
      stage.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: -60,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      )
      await new Promise<number>((resolve) => requestAnimationFrame(resolve))
      const now = performance.now()
      intervals.push(now - last)
      last = now
      frames++
    }
    // Hold at the final zoom for a few frames to catch late raster work.
    for (let hold = 0; hold < 10; hold++) {
      await new Promise<number>((resolve) => requestAnimationFrame(resolve))
      const now = performance.now()
      intervals.push(now - last)
      last = now
    }
    const sorted = [...intervals].sort((a, b) => a - b)
    const at = (q: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
    return { frames, finalPercent: percent(), p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0 }
  })
  console.log(
    `[e2e] zoom to ${run.finalPercent}% over ${run.frames} frames: ` +
      `p50 ${run.p50.toFixed(1)} ms, p95 ${run.p95.toFixed(1)} ms, max ${run.max.toFixed(1)} ms`,
  )
  expect(run.finalPercent).toBeGreaterThanOrEqual(800)
  // Smooth: 95 % of frames inside two 60 Hz frames, and no visible hitch.
  expect(run.p95).toBeLessThan(34)
  expect(run.max).toBeLessThan(100)
})
