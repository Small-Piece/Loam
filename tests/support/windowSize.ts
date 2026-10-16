import type { ElectronApplication } from '@playwright/test'

/**
 * Resizes the app's first window to this content size, the way tests and the
 * release tools shrink or grow it, and keeps the anchor the app was placed
 * with. When LOAM_WINDOW_DISPLAY placed the window and LOAM_WINDOW_ANCHOR is
 * "bottom", the window goes to the bottom of its display's work area, centered
 * horizontally, instead of keeping its top edge (and so ending higher up, or
 * growing past the taskbar). The content size is the one asked for, as with
 * setContentSize, since tests and screenshots depend on it; a window taller
 * than the work area keeps its top edge on the work area's top. Otherwise this
 * is a plain setContentSize.
 */
export async function setWindowContentSize(
  app: ElectronApplication,
  size: { width: number; height: number },
): Promise<void> {
  await app.evaluate(({ BrowserWindow, screen }, wanted) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) throw new Error('no window to resize')
    // Read in the app's own environment, with the same UM_ fallback as the app.
    const setting = (name: string) =>
      (process.env[`LOAM_${name}`] ?? process.env[`UM_${name}`] ?? '').trim()
    if (!setting('WINDOW_DISPLAY') || setting('WINDOW_ANCHOR') !== 'bottom') {
      window.setContentSize(wanted.width, wanted.height)
      return
    }
    // Size and position in one call: at a fractional scale every extra call
    // makes Windows round the window by another pixel or two.
    const frame = window.getBounds()
    const inner = window.getContentBounds()
    const left = inner.x - frame.x
    const top = inner.y - frame.y
    const frameWidth = frame.width - inner.width + wanted.width
    const frameHeight = frame.height - inner.height + wanted.height
    const area = screen.getDisplayMatching(frame).workArea
    const x = Math.round(area.x + (area.width - frameWidth) / 2)
    const y = Math.max(area.y, area.y + area.height - frameHeight)
    window.setContentBounds({ x: x + left, y: y + top, width: wanted.width, height: wanted.height })
  }, size)
}
