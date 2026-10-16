export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface DisplayInfo {
  id: number
  workArea: Rect
}

export interface Placement {
  bounds: Rect
  /** Show without taking focus, so a test run never steals the user's keyboard. */
  inactive: boolean
}

/**
 * Picks the display named by LOAM_WINDOW_DISPLAY: "secondary" means the first
 * display that is not the primary one; a number is an index into the display
 * list. Returns null when unset, malformed, or when that display does not exist.
 */
export function chooseDisplay(
  setting: string | undefined,
  displays: readonly DisplayInfo[],
  primaryId: number,
): DisplayInfo | null {
  const wanted = setting?.trim()
  if (!wanted) return null
  if (wanted === 'secondary') return displays.find((display) => display.id !== primaryId) ?? null
  if (!/^\d+$/.test(wanted)) return null
  return displays[Number(wanted)] ?? null
}

/** Where a placed window sits in the display's work area. */
export type WindowAnchor = 'center' | 'bottom'

/**
 * Reads LOAM_WINDOW_ANCHOR: "bottom" puts the window at the bottom of the work
 * area; unset or anything else keeps it centered.
 */
export function chooseAnchor(setting: string | undefined): WindowAnchor {
  return setting?.trim() === 'bottom' ? 'bottom' : 'center'
}

/**
 * Places a window of the preferred size in the display's work area, shrinking
 * it to fit. It is centered horizontally; vertically it is centered, or with
 * the "bottom" anchor its bottom edge sits on the work area's bottom (above
 * the taskbar).
 */
export function placeOn(
  display: DisplayInfo,
  preferred: { width: number; height: number },
  anchor: WindowAnchor = 'center',
): Placement {
  const area = display.workArea
  const width = Math.min(preferred.width, area.width)
  const height = Math.min(preferred.height, area.height)
  const y =
    anchor === 'bottom' ? area.y + area.height - height : area.y + (area.height - height) / 2
  return {
    bounds: {
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(y),
      width,
      height,
    },
    inactive: true,
  }
}
