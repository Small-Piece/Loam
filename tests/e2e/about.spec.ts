import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { assertBuilt, launchApp } from './launch.ts'

let localAppData: string
let app: ElectronApplication | null = null

test.beforeAll(() => {
  assertBuilt()
})

test.beforeEach(() => {
  localAppData = mkdtempSync(join(tmpdir(), 'loam-e2e-about-'))
})

test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = null
  rmSync(localAppData, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

test('About shows the version, the MIT license, the links and the third-party notices', async () => {
  app = await launchApp(localAppData)
  const page = await app.firstWindow()
  await expect(page).toHaveTitle('Loam')
  expect(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle()),
  ).toBe('Loam')

  await page.getByRole('button', { name: 'About Loam' }).click()
  const about = page.getByRole('dialog', { name: 'About Loam' })
  await expect(about.getByRole('heading', { name: 'Loam 0.1.1' })).toBeVisible()
  // The public repository is "Loam" with a capital L; GitHub Pages paths are case-sensitive.
  const reply = (await page.evaluate(() => window.loam.invoke('app:about', {}))) as {
    data: { websiteUrl: string; repositoryUrl: string }
  }
  expect(reply.data.websiteUrl).toBe('https://small-piece.github.io/Loam/')
  expect(reply.data.repositoryUrl).toBe('https://github.com/Small-Piece/Loam')
  await expect(about.getByTestId('about-license')).toContainText('MIT License')
  await expect(about.getByRole('button', { name: 'Website' })).toBeVisible()
  await expect(about.getByRole('button', { name: 'Source code' })).toBeVisible()

  await about.getByRole('button', { name: 'Third-party notices' }).click()
  const notices = about.getByTestId('about-notices')
  await expect(notices).toContainText('# Third-party notices')
  await expect(notices).toContainText('| zod |')
  await expect(notices).toContainText('### better-sqlite3')
  await expect(notices).toContainText('Downloaded only at your request (not included)')
  await expect(notices).toContainText('Qwen3-VL 4B Instruct')
  await about.getByRole('button', { name: 'Back' }).click()
  await expect(about.getByTestId('about-license')).toBeVisible()
  await about.getByRole('button', { name: 'Close' }).click()
  await expect(about).toHaveCount(0)
})
