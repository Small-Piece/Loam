import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { assertBuilt, launchApp, packagedExecutable } from './launch.ts'

let root: string
let app: ElectronApplication | null = null

/** The sample the app ships: next to Loam.exe when packaged, in the repository otherwise. */
const bundledSample = packagedExecutable
  ? join(dirname(packagedExecutable), 'resources', 'samples', 'lantern-coast')
  : fileURLToPath(new URL('../../samples/lantern-coast', import.meta.url))

test.beforeAll(() => {
  assertBuilt()
})

test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'loam-e2e-sample-'))
})

test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = null
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name)
      const stat = lstatSync(path)
      if (stat.isDirectory()) walk(path)
      else
        out[relative(dir, path)] =
          `${stat.mtimeMs}|${createHash('sha256').update(readFileSync(path)).digest('hex')}`
    }
  }
  walk(dir)
  return out
}

test('the sample bible opens from the start screen into a folder the user chooses', async () => {
  const before = tree(bundledSample)
  const chosen = join(root, 'Lantern sample')
  app = await launchApp(join(root, 'appdata'))
  const page = await app.firstWindow()
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [picked],
    })) as unknown as typeof dialog.showOpenDialog
  }, chosen)

  await page.getByRole('button', { name: 'Bible', exact: true }).click()
  await page.getByRole('button', { name: 'Open the sample bible' }).click()

  const sections = page.getByRole('navigation', { name: 'Sections' })
  await expect(
    sections.getByRole('button', { name: 'Light is borrowed', exact: true }),
  ).toBeVisible()
  await expect(sections.getByRole('button', { name: 'Tallow Wife', exact: true })).toBeVisible()
  await expect(
    sections.getByRole('button', { name: 'No map, only the tide table', exact: true }),
  ).toBeVisible()
  // No "What should players feel?" question: the sample already has its pillars.
  await expect(page.getByRole('dialog', { name: 'What should players feel?' })).toHaveCount(0)

  // The copy is in <chosen>/bible, and the bundled sample is unchanged.
  expect(existsSync(join(chosen, 'bible', 'bible.json'))).toBe(true)
  expect(existsSync(join(chosen, 'bible', '_assets', 'CREDITS.md'))).toBe(true)
  const copied = tree(join(chosen, 'bible'))
  for (const path of Object.keys(before)) expect(copied[path], path).toBeDefined()
  expect(tree(bundledSample)).toEqual(before)

  // Asking again for the same folder is refused instead of overwriting the copy.
  await page.getByRole('button', { name: 'Switch bible…' }).click()
  await page.getByRole('button', { name: 'Open the sample bible' }).click()
  await expect(page.getByRole('alert')).toContainText('already exists and is not empty')
})
