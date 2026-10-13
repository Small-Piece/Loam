import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { drop, makeImageTransfer } from './fixtures.ts'
import { assertBuilt, launchApp as launch } from './launch.ts'

// Temp folders only: a fake %LOCALAPPDATA% with an old UnrealManager data folder in it.
let root: string
let running: ElectronApplication[] = []

test.beforeAll(() => {
  assertBuilt()
})

test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'loam-e2e-migrate-'))
})

test.afterEach(async () => {
  for (const app of running) await app.close().catch(() => undefined)
  running = []
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

async function launchApp(appData: string) {
  const app = await launch(appData)
  running.push(app)
  const page = await app.firstWindow()
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible()
  return { app, page }
}

async function closeApp(app: ElectronApplication) {
  await app.close()
  running = running.filter((other) => other !== app)
}

async function invoke<T>(page: Page, channel: string, payload: unknown): Promise<T> {
  const reply = (await page.evaluate(([name, body]) => window.loam.invoke(name, body), [
    channel,
    payload,
  ] as const)) as { ok: boolean; data: T; error?: unknown }
  if (!reply.ok) throw new Error(`${channel}: ${JSON.stringify(reply.error)}`)
  return reply.data
}

const rail = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name, exact: true })

/** Every file under a folder: size, modification time and SHA-256. */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name)
      const stat = lstatSync(path)
      if (stat.isDirectory()) walk(path)
      else {
        const hash = createHash('sha256').update(readFileSync(path)).digest('hex')
        out[relative(dir, path)] = `${stat.size}|${stat.mtimeMs}|${hash}`
      }
    }
  }
  walk(dir)
  return out
}

/**
 * Builds a realistic data folder with the app itself (references, a board, a
 * bible and a journal), then gives it the names it had before the rename.
 */
async function makeOldDataFolder(appData: string): Promise<string> {
  mkdirSync(appData, { recursive: true })
  const { app, page } = await launchApp(appData)
  await rail(page, 'Library').click()
  await drop(
    page,
    await makeImageTransfer(
      page,
      Array.from({ length: 4 }, (_, index) => ({ index: index + 1, width: 640, height: 400 })),
    ),
  )
  await expect(page.getByTestId('ref-card')).toHaveCount(4)
  await invoke(page, 'boards:create', { name: 'Moodboard' })
  await invoke(page, 'bible:create', {
    folder: join(root, 'Game'),
    kitId: 'atmospheric-horror',
    title: 'Harbour Night',
  })
  await invoke(page, 'journal:create', { folder: join(root, 'Journal') })
  await closeApp(app)

  const old = join(appData, 'UnrealManager')
  renameSync(join(appData, 'Loam'), old)
  for (const name of readdirSync(old)) {
    if (name.startsWith('loam.db')) {
      renameSync(join(old, name), join(old, name.replace('loam.db', 'unrealmanager.db')))
    }
  }
  mkdirSync(join(old, 'backups'), { recursive: true })
  copyFileSync(
    join(old, 'unrealmanager.db'),
    join(old, 'backups', 'unrealmanager-9-20261013T054031317Z.db'),
  )
  return old
}

test('the first start copies an UnrealManager data folder and leaves it byte-identical', async () => {
  const appData = join(root, 'appdata')
  const old = await makeOldDataFolder(appData)
  expect(readdirSync(appData)).toEqual(['UnrealManager'])
  const before = fingerprint(old)
  expect(Object.keys(before).some((path) => path.startsWith('files'))).toBe(true)

  const { app, page } = await launchApp(appData)

  // Everything is there.
  await rail(page, 'Library').click()
  await expect(page.getByTestId('ref-card')).toHaveCount(4)
  await expect(page.getByRole('button', { name: /^Moodboard/ })).toBeVisible()
  const bible = await invoke<{ current: { vault: { title: string } } | null }>(
    page,
    'bible:home',
    {},
  )
  expect(bible.current?.vault.title).toBe('Harbour Night')
  const journal = await invoke<{ current: unknown }>(page, 'journal:home', {})
  expect(journal.current).not.toBeNull()

  // The copy is recorded, and About says where the old folder is.
  const marker = JSON.parse(
    readFileSync(join(appData, 'Loam', 'migrated-from-unrealmanager.json'), 'utf8'),
  ) as { references: number; backups: { count: number } }
  expect(marker.references).toBe(4)
  expect(marker.backups.count).toBe(1)
  expect(readdirSync(join(appData, 'Loam', 'backups'))).toEqual(['loam-9-20261013T054031317Z.db'])
  await page.getByRole('button', { name: 'About Loam' }).click()
  const about = page.getByRole('dialog', { name: 'About Loam' })
  await expect(about.getByTestId('about-data-folder')).toHaveText(join(appData, 'Loam'))
  await expect(about.getByTestId('about-migration')).toContainText(old)
  await expect(about.getByTestId('about-migration')).toContainText('4 references')
  await expect(about.getByTestId('about-migration')).toContainText('delete it by hand')
  await about.getByRole('button', { name: 'Close' }).click()
  await closeApp(app)

  // The old folder is untouched, and nothing was left behind.
  expect(fingerprint(old)).toEqual(before)
  expect(readdirSync(appData).sort()).toEqual(['Loam', 'UnrealManager'])
  const mainLog = readFileSync(join(appData, 'Loam', 'logs', 'main.log'), 'utf8')
  expect(mainLog).toMatch(/\[migration\] copied .* 4 references/)

  // The next start uses the Loam folder and copies nothing again.
  const again = await launchApp(appData)
  await rail(again.page, 'Library').click()
  await expect(again.page.getByTestId('ref-card')).toHaveCount(4)
  await closeApp(again.app)
  expect(fingerprint(old)).toEqual(before)
  expect(
    readFileSync(join(appData, 'Loam', 'logs', 'main.log'), 'utf8').match(/\[migration\] copied/g),
  ).toHaveLength(1)
})

test('a fresh install starts empty and shows no migration note', async () => {
  const appData = join(root, 'appdata')
  mkdirSync(appData, { recursive: true })
  const { app, page } = await launchApp(appData)
  await page.getByRole('button', { name: 'About Loam' }).click()
  const about = page.getByRole('dialog', { name: 'About Loam' })
  await expect(about.getByTestId('about-data-folder')).toHaveText(join(appData, 'Loam'))
  await expect(about.getByTestId('about-migration')).toHaveCount(0)
  await closeApp(app)
  expect(existsSync(join(appData, 'UnrealManager'))).toBe(false)
  expect(existsSync(join(appData, 'Loam', 'migrated-from-unrealmanager.json'))).toBe(false)
})
