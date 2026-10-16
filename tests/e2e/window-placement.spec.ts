import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { setWindowContentSize } from '../support/windowSize.ts'
import { assertBuilt, launchApp } from './launch.ts'

// Temp data folder only.
let localAppData: string
let app: ElectronApplication | null = null

test.beforeAll(() => {
  assertBuilt()
})

test.beforeEach(() => {
  localAppData = mkdtempSync(join(tmpdir(), 'loam-e2e-window-'))
})

test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = null
  rmSync(localAppData, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

interface WindowReport {
  displays: number
  display: string
  anchor: string
  onPrimary: boolean
  workArea: { x: number; y: number; width: number; height: number }
  bounds: { x: number; y: number; width: number; height: number }
  content: { width: number; height: number }
}

async function windowReport(electronApp: ElectronApplication): Promise<WindowReport> {
  return electronApp.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) throw new Error('no window')
    const bounds = window.getBounds()
    const display = screen.getDisplayMatching(bounds)
    const [width = 0, height = 0] = window.getContentSize()
    return {
      displays: screen.getAllDisplays().length,
      // Read in the app's own environment: launch.ts always sets the LOAM_ names.
      display: process.env['LOAM_WINDOW_DISPLAY'] ?? '',
      anchor: process.env['LOAM_WINDOW_ANCHOR'] ?? '',
      onPrimary: display.id === screen.getPrimaryDisplay().id,
      workArea: display.workArea,
      bounds,
      content: { width, height },
    }
  })
}

/**
 * How far off, in DIP, a placed window may be. At a fractional scale (175% here) Windows
 * makes a window 1 to 2 DIP larger than asked, even after setting the bounds again; that
 * overshoot lies within the window's invisible resize border.
 */
const SLACK = 3

/**
 * Content sizes are rounded too: a plain setContentSize(900, 640) gives 901 x 637 at 175%.
 */
function expectContentNear(
  content: { width: number; height: number },
  asked: { width: number; height: number },
): void {
  expect(Math.abs(content.width - asked.width)).toBeLessThanOrEqual(SLACK + 1)
  expect(Math.abs(content.height - asked.height)).toBeLessThanOrEqual(SLACK + 1)
}

/** Pixels the window's bottom edge is above the work area's bottom (0 when anchored). */
function gapBelow(report: WindowReport): number {
  return report.workArea.y + report.workArea.height - (report.bounds.y + report.bounds.height)
}

/** Difference between the free space left and right of the window (0 when centered). */
function offCenter(report: WindowReport): number {
  const left = report.bounds.x - report.workArea.x
  const right = report.workArea.x + report.workArea.width - (report.bounds.x + report.bounds.width)
  return left - right
}

test('test windows open at the bottom of the secondary monitor and stay there after a resize', async () => {
  app = await launchApp(localAppData)
  await app.firstWindow()
  // The window is placed before it is shown; wait for ready-to-show.
  await expect
    .poll(() => app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()))
    .toBe(true)
  const opened = await windowReport(app)
  console.log(`[e2e] opened: ${JSON.stringify(opened)}`)
  test.skip(
    opened.display !== 'secondary' || opened.anchor !== 'bottom' || opened.displays < 2,
    'needs a second monitor with LOAM_WINDOW_DISPLAY=secondary and LOAM_WINDOW_ANCHOR=bottom',
  )

  // Opened: on the secondary monitor, bottom edge on the work area's bottom, centered.
  expect(opened.onPrimary).toBe(false)
  expect(Math.abs(gapBelow(opened))).toBeLessThanOrEqual(SLACK)
  expect(Math.abs(offCenter(opened))).toBeLessThanOrEqual(SLACK)
  expect(opened.bounds.y).toBeGreaterThanOrEqual(opened.workArea.y)
  expect(opened.bounds.width).toBeLessThanOrEqual(opened.workArea.width + SLACK)

  // A narrow-window check shrinks it: the size asked for, still at the bottom.
  await setWindowContentSize(app, { width: 900, height: 640 })
  const narrow = await windowReport(app)
  console.log(`[e2e] narrow: ${JSON.stringify(narrow)}`)
  expectContentNear(narrow.content, { width: 900, height: 640 })
  expect(Math.abs(gapBelow(narrow))).toBeLessThanOrEqual(SLACK)
  expect(Math.abs(offCenter(narrow))).toBeLessThanOrEqual(SLACK)
  expect(narrow.onPrimary).toBe(false)

  // Growing it again keeps the bottom edge too, rather than growing past the taskbar.
  await setWindowContentSize(app, { width: 1000, height: 900 })
  const taller = await windowReport(app)
  console.log(`[e2e] taller: ${JSON.stringify(taller)}`)
  expectContentNear(taller.content, { width: 1000, height: 900 })
  expect(Math.abs(gapBelow(taller))).toBeLessThanOrEqual(SLACK)
  expect(taller.bounds.y).toBeGreaterThanOrEqual(taller.workArea.y)
})
