import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { drop, makeImageTransfer } from './fixtures.ts'
import { appCommand, assertBuilt, launchApp } from './launch.ts'

let localAppData: string
let app: ElectronApplication | null = null

test.beforeAll(() => {
  assertBuilt()
})

test.beforeEach(() => {
  localAppData = mkdtempSync(join(tmpdir(), 'loam-e2e-single-'))
})

test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = null
  rmSync(localAppData, { recursive: true, force: true })
})

const mainLog = () => readFileSync(join(localAppData, 'Loam', 'logs', 'main.log'), 'utf8')

/** Starts the app as a plain process (no test driver) and waits for it to exit. */
function launchPlain(): Promise<{ code: number | null; ms: number }> {
  const command = appCommand(localAppData)
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const child = spawn(command.executablePath, command.args, {
      env: command.env,
      stdio: 'ignore',
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('the second launch did not exit within 20 s'))
    }, 20_000)
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, ms: Date.now() - started })
    })
  })
}

test('a second launch exits before opening the database and brings the first window back', async () => {
  app = await launchApp(localAppData)
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'All references' })).toBeVisible()
  // Something in the Library, to check the log never names it.
  await drop(page, await makeImageTransfer(page, [{ index: 1, width: 800, height: 600 }]))
  await expect(page.getByTestId('ref-card')).toHaveCount(1)

  const isMinimized = () =>
    app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized())
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize())
  await expect.poll(isMinimized).toBe(true)

  const second = await launchPlain()
  expect(second.code).toBe(0)

  // The running app restored its window and is still the only one with the database.
  await expect.poll(isMinimized).toBe(false)
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  await expect(page.getByTestId('ref-card')).toHaveCount(1)

  await expect.poll(mainLog).toContain('a second launch was handed over to this window')
  const log = mainLog()
  const launches = log.match(/\[startup\] Loam .* launching/g) ?? []
  expect(launches).toHaveLength(2)
  expect(log.match(/\[storage\] database opened/g) ?? []).toHaveLength(1)
  expect(log).toMatch(/\[storage\] database opened in \d+ ms: schema version 0 before, 11 after/)
  expect(log).toContain('already running; handing over to it and exiting')
  // The handing-over process is not the one that opened the database.
  const pidOf = (pattern: RegExp) =>
    log
      .split('\n')
      .find((line) => pattern.test(line))
      ?.match(/\[pid (\d+)\]/)?.[1]
  expect(pidOf(/already running/)).not.toBe(pidOf(/database opened/))
  // No reference names or image paths in the log.
  expect(log).not.toContain('ref-01')
  expect(log).not.toMatch(/\\files\\/)
})

test('main.log records startup timing and the schema before and after opening', async () => {
  app = await launchApp(localAppData)
  await (await app.firstWindow()).getByRole('heading', { name: 'All references' }).waitFor()
  await app.close()
  app = null
  // A restart with nothing to migrate: same version before and after, no backup.
  app = await launchApp(localAppData)
  await (await app.firstWindow()).getByRole('heading', { name: 'All references' }).waitFor()
  const log = mainLog()
  expect(log).toMatch(/schema version 0 before, 11 after migrating/)
  expect(log).toMatch(/schema version 11 before, 11 after migrating/)
  expect(log).not.toContain('backed up the database')
  await expect.poll(mainLog).toMatch(/\[startup\] window shown \d+ ms after launch/)
})
