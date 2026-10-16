import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { assertBuilt, launchApp as launch, packagedExecutable } from './launch.ts'

let localAppData: string
let running: ElectronApplication[] = []

test.beforeAll(() => {
  assertBuilt()
})

test.beforeEach(() => {
  localAppData = mkdtempSync(join(tmpdir(), 'loam-e2e-perf-'))
})

test.afterEach(async () => {
  for (const app of running) await app.close().catch(() => undefined)
  running = []
  rmSync(localAppData, { recursive: true, force: true })
})

const COUNT = 300
const BATCH = 50

interface FrameStats {
  fps: number
  p50: number
  p95: number
  max: number
  dropped: number
  frames: number
  refreshMs: number
}

/** Starts recording frame intervals in the page. */
async function startFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = { intervals: [] as number[], running: true, last: 0 }
    ;(window as unknown as { umFrameLog: typeof state }).umFrameLog = state
    const tick = (now: number) => {
      if (state.last) state.intervals.push(now - state.last)
      state.last = now
      if (state.running) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

async function stopFrames(page: Page, refreshMs: number): Promise<FrameStats> {
  const intervals = await page.evaluate(() => {
    const state = (window as unknown as { umFrameLog: { intervals: number[]; running: boolean } })
      .umFrameLog
    state.running = false
    return state.intervals
  })
  const sorted = [...intervals].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
  const total = intervals.reduce((sum, value) => sum + value, 0)
  return {
    fps: Math.round((1000 * intervals.length) / total),
    p50: +at(0.5).toFixed(1),
    p95: +at(0.95).toFixed(1),
    max: +(sorted.at(-1) ?? 0).toFixed(1),
    dropped: intervals.filter((value) => value > refreshMs * 1.5).length,
    frames: intervals.length,
    refreshMs,
  }
}

async function refreshInterval(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const intervals: number[] = []
    let last = await new Promise<number>(requestAnimationFrame)
    for (let i = 0; i < 60; i++) {
      const now = await new Promise<number>(requestAnimationFrame)
      intervals.push(now - last)
      last = now
    }
    intervals.sort((a, b) => a - b)
    return intervals[30] ?? 16.7
  })
}

const variants = [
  { name: '300 images', groups: 0, notes: 0 },
  { name: '300 images, 20 groups and 50 notes', groups: 20, notes: 50 },
]

/** Puts the images into groups of equal size and adds notes, half attached to images. */
async function addGroupsAndNotes(
  page: Page,
  boardId: number,
  groupCount: number,
  noteCount: number,
) {
  await page.evaluate(
    async ({ board, groupTotal, noteTotal }) => {
      const view = (await window.loam.invoke('canvas:get', { boardId: board })) as {
        ok: true
        data: {
          items: Array<
            Record<string, unknown> & {
              id: number
              referenceId: number
              x: number
              y: number
              z: number
            }
          >
        }
      }
      const items = view.data.items
      const per = Math.ceil(items.length / groupTotal)
      const colors = ['blue', 'teal', 'green', 'amber', 'red', 'violet', 'pink', 'slate'] as const
      const groups = Array.from({ length: groupTotal }, (_, index) => ({
        key: `g${index}`,
        title: `Group ${index + 1}`,
        color: colors[index % colors.length]!,
        locked: true,
        z: index,
      }))
      const placed = items.map((item, index) => ({
        id: item.id,
        referenceId: item.referenceId,
        x: item.x,
        y: item.y,
        scale: item['scale'] as number,
        z: item.z,
        groupId: null,
        groupKey: `g${Math.floor(index / per)}`,
      }))
      const notes = Array.from({ length: noteTotal }, (_, index) => {
        const attached = index % 2 === 0
        const item = items[(index * 6) % items.length]!
        return {
          key: `n${index}`,
          text: `Note ${index + 1}
lighting, value and edge study`,
          x: attached ? 20 : item.x + 40,
          y: attached ? 20 : item.y + 40,
          width: index % 3 === 0 ? 260 : null,
          fontSize: (['S', 'M', 'L', 'XL'] as const)[index % 4]!,
          color: index % 5 === 0 ? 'amber' : 'paper',
          background: index % 2 === 1,
          z: 10_000 + index,
          attachedItemId: attached ? item.id : null,
          groupId: null,
        }
      })
      const reply = (await window.loam.invoke('canvas:apply', {
        boardId: board,
        ops: [
          { op: 'putGroups', groups },
          { op: 'putItems', items: placed },
          { op: 'putNotes', notes },
        ],
      })) as { ok: boolean }
      if (!reply.ok) throw new Error('canvas:apply failed')
    },
    { board: boardId, groupTotal: groupCount, noteTotal: noteCount },
  )
}

for (const variant of variants)
  test(`a board with ${variant.name} pans and zooms at 60 fps`, async () => {
    test.setTimeout(240_000)
    const app = await launch(localAppData)
    running.push(app)
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'All references' })).toBeVisible()

    const board = (await page.evaluate(() =>
      window.loam.invoke('boards:create', { name: '300 references' }),
    )) as { ok: true; data: { board: { id: number } } }
    const boardId = board.data.board.id

    // Make 300 distinct photos in the main process and import them onto the board.
    for (let start = 0; start < COUNT; start += BATCH) {
      const batch = await app.evaluate(
        ({ nativeImage }, [first, count]) => {
          const width = 1200
          const height = 800
          const out: Array<{ full: string; thumb: string }> = []
          for (let index = first; index < first + count; index++) {
            const pixels = Buffer.alloc(width * height * 4)
            for (let y = 0; y < height; y++) {
              for (let x = 0; x < width; x++) {
                const offset = (y * width + x) * 4
                pixels[offset] = (x * 3 + index * 17) & 255
                pixels[offset + 1] = (y * 2 + index * 29) & 255
                // The blue channel carries index / 256, so no two of the 300 images repeat.
                pixels[offset + 2] = ((x ^ y) + index * 7 + Math.floor(index / 256) * 101) & 255
                pixels[offset + 3] = 255
              }
            }
            const image = nativeImage.createFromBitmap(pixels, { width, height })
            out.push({
              full: image.toJPEG(85).toString('base64'),
              thumb: image.resize({ width: 480 }).toJPEG(80).toString('base64'),
            })
          }
          return out
        },
        [start, Math.min(BATCH, COUNT - start)] as const,
      )
      await page.evaluate(
        async ({ images, targetBoard, first }) => {
          const bytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
          const items = images.map((image, offset) => ({
            fileName: `perf-${first + offset}.jpg`,
            bytes: bytes(image.full),
            width: 1200,
            height: 800,
            thumbnail: { bytes: bytes(image.thumb), width: 480, height: 320 },
          }))
          const reply = (await window.loam.invoke('refs:import', {
            items,
            boardId: targetBoard,
            at: null,
          })) as { ok: boolean }
          if (!reply.ok) throw new Error('import failed')
        },
        { images: batch, targetBoard: boardId, first: start },
      )
    }

    if (variant.groups > 0) await addGroupsAndNotes(page, boardId, variant.groups, variant.notes)

    await page.reload()
    await page.getByRole('button', { name: /^300 references/ }).click()
    await expect(page.getByTestId('canvas-item')).toHaveCount(COUNT)
    await expect(page.getByTestId('canvas-group')).toHaveCount(variant.groups)
    await expect(page.getByTestId('canvas-note')).toHaveCount(variant.notes)
    await expect
      .poll(
        () =>
          page
            .locator('[data-testid="canvas-item"] img')
            .evaluateAll((images) => images.every((image) => (image as HTMLImageElement).complete)),
        { timeout: 60_000 },
      )
      .toBe(true)

    const canvas = await page.getByTestId('canvas').boundingBox()
    if (!canvas) throw new Error('no canvas')
    const middle = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 }
    await page.mouse.click(canvas.x + 4, canvas.y + canvas.height - 30)
    await page.keyboard.press('f') // all 300 on screen
    const refreshMs = await refreshInterval(page)

    // Pan: a middle-button drag in two loops around the middle, all 300 visible.
    await page.mouse.move(middle.x, middle.y)
    await page.mouse.down({ button: 'middle' })
    await startFrames(page)
    for (let step = 0; step <= 240; step++) {
      const angle = (step / 240) * Math.PI * 4
      await page.mouse.move(
        middle.x + Math.cos(angle) * 220 - 220,
        middle.y + Math.sin(angle) * 140,
      )
    }
    const pan = await stopFrames(page, refreshMs)
    await page.mouse.up({ button: 'middle' })
    await page.keyboard.press('f')

    // Zoom: from fit (all 300) in past 200 % with the wheel, then back out.
    await page.mouse.move(middle.x, middle.y)
    await startFrames(page)
    const zoomIn: number[] = []
    for (let step = 0; step < 40; step++) {
      await page.mouse.wheel(0, -100)
      zoomIn.push(Number((await page.getByTestId('canvas-zoom').innerText()).replace('%', '')))
    }
    for (let step = 0; step < 40; step++) await page.mouse.wheel(0, 100)
    const zoom = await stopFrames(page, refreshMs)
    const peak = Math.max(...zoomIn)

    // How many originals were swapped in at the deepest zoom (LOD).
    const build = packagedExecutable ? 'packaged' : 'unpackaged'
    console.log(`[perf] ${build} build, ${variant.name}, refresh ${refreshMs.toFixed(1)} ms`)
    console.log(
      `[perf] pan:  ${pan.fps} fps · p50 ${pan.p50} ms · p95 ${pan.p95} ms · max ${pan.max} ms · ${pan.dropped}/${pan.frames} dropped`,
    )
    console.log(
      `[perf] zoom: ${zoom.fps} fps · p50 ${zoom.p50} ms · p95 ${zoom.p95} ms · max ${zoom.max} ms · ${zoom.dropped}/${zoom.frames} dropped · peak ${peak}%`,
    )

    expect(peak).toBeGreaterThanOrEqual(200)
    for (const run of [pan, zoom]) {
      expect(run.fps).toBeGreaterThanOrEqual(60)
      // 95 % of frames inside one 60 Hz frame budget (16.7 ms) plus a little slack.
      expect(run.p95).toBeLessThanOrEqual(20)
    }
  })
