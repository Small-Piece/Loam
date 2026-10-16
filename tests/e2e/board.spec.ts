import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { cards, drop, makeImageTransfer, storedFiles } from './fixtures.ts'
import { assertBuilt, launchApp as launch } from './launch.ts'

let localAppData: string
let running: ElectronApplication[] = []

/** Launches the app and remembers it, so cleanup can close it even when a test fails. */
async function launchApp(dataDir: string): Promise<ElectronApplication> {
  const app = await launch(dataDir)
  running.push(app)
  return app
}

test.beforeAll(() => {
  assertBuilt()
})

test.beforeEach(() => {
  localAppData = mkdtempSync(join(tmpdir(), 'loam-e2e-board-'))
})

test.afterEach(async () => {
  for (const app of running) await app.close().catch(() => undefined)
  running = []
  rmSync(localAppData, { recursive: true, force: true })
})

async function addTags(page: Page, title: string, tags: string[]): Promise<void> {
  await page.getByRole('button', { name: title, exact: true }).click()
  const detail = page.getByRole('complementary', { name: 'Reference detail' })
  await expect(detail.getByRole('textbox', { name: 'Title' })).toHaveValue(title)
  for (const tag of tags) {
    await detail.getByRole('combobox', { name: 'Add tag' }).fill(tag)
    await detail.getByRole('combobox', { name: 'Add tag' }).press('Enter')
    await expect(detail.getByRole('button', { name: `Remove tag ${tag}` })).toBeVisible()
  }
}

function countStoredFiles(): number {
  return storedFiles(localAppData).length
}

test('drop 20 images, dedup a re-drop, tag, filter and search; edits survive a restart', async () => {
  const app = await launchApp(localAppData)
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'All references' })).toBeVisible()

  // Drop 20 images: all must be imported and shown within 5 seconds of the drop.
  const indexes = Array.from({ length: 20 }, (_, index) => index + 1)
  const twenty = await makeImageTransfer(page, indexes)
  const started = Date.now()
  await drop(page, twenty)
  await expect(cards(page)).toHaveCount(20, { timeout: 5_000 })
  const importMs = Date.now() - started
  console.log(`[e2e] 20-image drop imported and rendered in ${importMs} ms`)
  expect(importMs).toBeLessThan(5_000)
  await expect(page.getByTestId('toast')).toHaveText('Imported 20')
  expect(countStoredFiles()).toBe(40) // 20 originals + 20 thumbnails

  // Dropping an image that is already stored keeps one copy.
  await drop(page, await makeImageTransfer(page, [3]))
  await expect(page.getByTestId('toast')).toHaveText('Imported 0 · 1 already in library')
  await expect(cards(page)).toHaveCount(20)
  expect(countStoredFiles()).toBe(40)

  // Thumbnails load from the content-addressed store.
  const firstThumb = cards(page).first().locator('img')
  await expect(firstThumb).toHaveJSProperty('complete', true)
  expect(await firstThumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(480)

  // Tag three references and add a note to one.
  await addTags(page, 'ref-01', ['forest', 'zone 2'])
  await addTags(page, 'ref-02', ['forest'])
  await addTags(page, 'ref-03', ['Cave'])
  const detail = page.getByRole('complementary', { name: 'Reference detail' })
  await detail.getByRole('textbox', { name: 'Note' }).fill('Glowing moss on the cave ceiling')
  await detail.getByRole('textbox', { name: 'Title' }).click() // blur the note to save it
  await expect(page.getByRole('button', { name: 'forest 2' })).toBeVisible()

  // Filter by one tag, then two (AND), then clear.
  await page.getByRole('button', { name: 'forest 2' }).click()
  await expect(cards(page)).toHaveCount(2)
  await page.getByRole('button', { name: 'zone 2 1' }).click()
  await expect(cards(page)).toHaveCount(1)
  await expect(cards(page).first()).toHaveAccessibleName('ref-01')
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(cards(page)).toHaveCount(20)

  // Text search covers the note.
  await page.getByRole('searchbox', { name: 'Search title and note' }).fill('moss')
  await expect(cards(page)).toHaveCount(1)
  await expect(cards(page).first()).toHaveAccessibleName('ref-03')
  await page.getByRole('searchbox', { name: 'Search title and note' }).fill('')
  await expect(cards(page)).toHaveCount(20)

  await app.close()

  // Tags and notes persist across a restart.
  const again = await launchApp(localAppData)
  const page2 = await again.firstWindow()
  await expect(cards(page2)).toHaveCount(20)
  await page2.getByRole('button', { name: 'cave 1' }).click()
  await expect(cards(page2)).toHaveCount(1)
  await cards(page2).first().click()
  const detail2 = page2.getByRole('complementary', { name: 'Reference detail' })
  await expect(detail2.getByRole('textbox', { name: 'Note' })).toHaveValue(
    'Glowing moss on the cave ceiling',
  )
  await expect(detail2.getByRole('button', { name: 'Remove tag cave' })).toBeVisible()
  await again.close()

  // The rows are really in SQLite, readable by an independent SQLite reader.
  const db = new DatabaseSync(join(localAppData, 'Loam', 'loam.db'), {
    readOnly: true,
  })
  const refCount = db.prepare('SELECT COUNT(*) AS n FROM refs').get()
  const note = db.prepare("SELECT note FROM refs WHERE title = 'ref-03'").get()
  db.close()
  expect(refCount).toEqual({ n: 20 })
  expect(note).toEqual({ note: 'Glowing moss on the cave ceiling' })
})

test('pasting a screenshot creates a reference', async () => {
  const app = await launchApp(localAppData)
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'All references' })).toBeVisible()

  // Put a real image on the system clipboard, as a screenshot tool would.
  await app.evaluate(async ({ clipboard, ClipboardItem, nativeImage }) => {
    const width = 64
    const height = 48
    const pixels = Buffer.alloc(width * height * 4)
    for (let offset = 0; offset < pixels.length; offset += 4) {
      pixels[offset] = 200 // B
      pixels[offset + 1] = 120 // G
      pixels[offset + 2] = 40 // R
      pixels[offset + 3] = 255 // A
    }
    const png = nativeImage.createFromBitmap(pixels, { width, height }).toPNG()
    await clipboard.write([
      new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) }),
    ])
  })

  await page.locator('body').click()
  await page.keyboard.press('Control+V')

  await expect(cards(page)).toHaveCount(1)
  await expect(cards(page).first()).toHaveAccessibleName(
    /^Pasted image \d{4}-\d{2}-\d{2} \d{2}\.\d{2}$/,
  )
  await expect(page.getByTestId('toast')).toHaveText('Imported 1')
  await app.close()
})
