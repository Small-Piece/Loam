import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from '@playwright/test'
import { assertBuilt, launchApp, packagedExecutable } from './launch.ts'

// 0001_init through 0005_groups_notes.
const LATEST_SCHEMA_VERSION = '11'

let localAppData: string

test.beforeAll(() => {
  assertBuilt()
  localAppData = mkdtempSync(join(tmpdir(), 'loam-e2e-'))
})

test.afterAll(() => {
  rmSync(localAppData, { recursive: true, force: true })
})

test('shell loads and app:ping round-trips with typed rejection of bad input', async () => {
  const started = Date.now()
  const app = await launchApp(localAppData)
  const page = await app.firstWindow()
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await expect(page.getByRole('heading', { name: 'All references' })).toBeVisible()
  expect(Date.now() - started).toBeLessThan(3_000)
  // Proves which build ran: LOAM_E2E_EXECUTABLE selects the packaged app.
  expect(await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(
    packagedExecutable !== undefined,
  )

  // LOAM_WINDOW_DISPLAY=secondary keeps the test window off the primary monitor, without focus.
  // The page renders before the window is shown, so wait for ready-to-show first.
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()))
    .toBe(true)
  const placement = await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) throw new Error('no window')
    const bounds = window.getBounds()
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
    const primary = screen.getPrimaryDisplay()
    return {
      displays: screen.getAllDisplays().length,
      onPrimary: screen.getDisplayNearestPoint(center).id === primary.id,
      visible: window.isVisible(),
      focused: window.isFocused(),
      // Read in the app's own environment: launch.ts always sets the LOAM_ name.
      setting: process.env['LOAM_WINDOW_DISPLAY'] ?? '',
    }
  })
  expect(placement.visible).toBe(true)
  if (placement.setting === 'secondary' && placement.displays > 1) {
    expect(placement.onPrimary).toBe(false)
    expect(placement.focused).toBe(false)
  }
  console.log(`[e2e] window placement: ${JSON.stringify(placement)}`)

  // The Slice 0 ping buttons are gone; the same round trip goes through the preload bridge.
  const ping = await page.evaluate(() => window.loam.invoke('app:ping', { message: 'hello' }))
  expect(ping).toMatchObject({ ok: true, data: { reply: 'pong: hello' } })
  const malformed = await page.evaluate(() => window.loam.invoke('app:ping', { msg: 42 }))
  expect(malformed).toMatchObject({
    ok: false,
    error: { code: 'INVALID_REQUEST', message: 'Invalid request for app:ping' },
  })

  // The renderer is sandboxed: no Node globals leak into the page.
  expect(await page.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe(
    'undefined',
  )
  // The strict CSP meta tag is present and nothing on the page violated it.
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
    'content',
    /script-src 'self';/,
  )
  expect(consoleErrors).toEqual([])

  await app.close()
})

test('database is created and keeps the latest schema version after restart', async () => {
  const dbPath = join(localAppData, 'Loam', 'loam.db')

  const first = await launchApp(localAppData)
  await first.firstWindow()
  await first.close()
  expect(existsSync(dbPath)).toBe(true)

  const second = await launchApp(localAppData)
  await second.firstWindow()
  await second.close()

  // Read with Node's built-in SQLite, not the app's driver: the file is language-neutral.
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
  db.close()
  expect(row).toEqual({ value: LATEST_SCHEMA_VERSION })
})
