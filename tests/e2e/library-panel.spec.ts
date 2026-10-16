import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { setWindowContentSize } from '../support/windowSize.ts'
import { assertBuilt, launchApp } from './launch.ts'

// Temp data folder only: 250 generated references, as in daily use with a large library.
const REFERENCES = 250
const MIN_TILE_HEIGHT = 60

let root: string
let app: ElectronApplication | null = null

test.beforeAll(() => {
  assertBuilt()
})

test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'loam-e2e-panel-'))
})

test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = null
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

async function invoke<T>(page: Page, channel: string, payload: unknown): Promise<T> {
  const reply = (await page.evaluate(([name, body]) => window.loam.invoke(name, body), [
    channel,
    payload,
  ] as const)) as { ok: boolean; data: T; error?: unknown }
  if (!reply.ok) throw new Error(`${channel}: ${JSON.stringify(reply.error)}`)
  return reply.data
}

/** Imports `total` small generated JPEG references through the protocol, 50 at a time. */
async function seedReferences(page: Page, total: number): Promise<number[]> {
  return page.evaluate(async (count) => {
    async function jpeg(width: number, height: number, index: number): Promise<Uint8Array> {
      const canvas = new OffscreenCanvas(width, height)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('no 2d context')
      context.fillStyle = `hsl(${(index * 37) % 360} 50% 40%)`
      context.fillRect(0, 0, width, height)
      context.fillStyle = `hsl(${(index * 91) % 360} 60% 70%)`
      context.fillRect(width * 0.2, height * 0.2, width * 0.3, height * 0.4)
      const blob = await canvas.convertToBlob({ type: 'image/jpeg' })
      return new Uint8Array(await blob.arrayBuffer())
    }
    const ids: number[] = []
    for (let start = 0; start < count; start += 50) {
      const items = []
      for (let index = start; index < Math.min(count, start + 50); index++) {
        const [width, height] = index % 3 === 0 ? [600, 800] : [800, 500]
        items.push({
          fileName: `reference-${index}.jpg`,
          bytes: await jpeg(width, height, index),
          width,
          height,
          thumbnail: {
            bytes: await jpeg(width / 2, height / 2, index),
            width: width / 2,
            height: height / 2,
          },
        })
      }
      const reply = (await window.loam.invoke('refs:import', {
        items,
        boardId: null,
        at: null,
      })) as {
        ok: boolean
        data: { results: Array<{ id: number }> }
      }
      if (!reply.ok) throw new Error('import failed')
      ids.push(...reply.data.results.map((result) => result.id))
    }
    return ids
  }, total)
}

async function heightOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox()
  return box?.height ?? 0
}

/** The first and last tile (and their thumbnails) are drawn at full height; the last one loads. */
async function expectTilesVisible(tiles: Locator) {
  await expect(tiles).toHaveCount(REFERENCES)
  const first = tiles.first()
  const last = tiles.last()
  expect(await heightOf(first)).toBeGreaterThanOrEqual(MIN_TILE_HEIGHT)
  expect(await heightOf(first.locator('img'))).toBeGreaterThanOrEqual(MIN_TILE_HEIGHT)
  // Scroll the panel to the bottom: the lazy thumbnail there loads and is drawn.
  await last.scrollIntoViewIfNeeded()
  await expect
    .poll(() =>
      last.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true)
  expect(await heightOf(last)).toBeGreaterThanOrEqual(MIN_TILE_HEIGHT)
  expect(await heightOf(last.locator('img'))).toBeGreaterThanOrEqual(MIN_TILE_HEIGHT)
}

test('with 250 references the canvas Library panel shows every tile at full height', async () => {
  app = await launchApp(join(root, 'appdata'))
  const page = await app.firstWindow()
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible()
  const ids = await seedReferences(page, REFERENCES)
  const { board } = await invoke<{ board: { id: number } }>(page, 'boards:create', {
    name: 'Large library',
  })
  await invoke(page, 'boards:addRefs', { boardId: board.id, ids: ids.slice(0, 3), at: null })
  await invoke(page, 'boards:setViewMode', { boardId: board.id, mode: 'canvas' })
  await page.reload()

  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await page.getByRole('button', { name: /^Large library/ }).click()
  const tiles = page.locator('.library-panel').getByTestId('library-item')
  await expectTilesVisible(tiles)

  // A narrow window too.
  await setWindowContentSize(app, { width: 900, height: 640 })
  await tiles.first().scrollIntoViewIfNeeded()
  await expectTilesVisible(tiles)
})

test('with 250 references the Bible library panel shows every tile at full height', async () => {
  app = await launchApp(join(root, 'appdata'))
  const page = await app.firstWindow()
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible()
  await seedReferences(page, REFERENCES)
  const game = join(root, 'Game')
  mkdirSync(game, { recursive: true })
  const view = await invoke<{ vault: { id: number } }>(page, 'bible:create', {
    folder: game,
    kitId: 'blank',
    title: 'Large library',
  })
  await invoke(page, 'bible:createEntry', {
    vaultId: view.vault.id,
    section: 'pillars',
    title: 'First pillar',
    body: 'Text.\n',
  })
  await page.reload()

  await page.getByRole('button', { name: 'Bible', exact: true }).click()
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: 'First pillar', exact: true })
    .click()
  await page.getByRole('button', { name: 'References' }).click()
  const tiles = page.getByRole('complementary', { name: 'References' }).getByTestId('library-item')
  await expectTilesVisible(tiles)
})
