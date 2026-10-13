const MAX_QUERY = 100

/** When the caret sits inside an unclosed [[ on its line: where the title starts and what is typed so far. */
export function openLinkQuery(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1
  const before = text.slice(lineStart, caret)
  const open = before.lastIndexOf('[[')
  if (open === -1) return null
  const query = before.slice(open + 2)
  if (query.length > MAX_QUERY || /[[\]|#]/.test(query)) return null
  return { start: lineStart + open + 2, query }
}

/** Puts `title` in place of the typed query and closes the link, stepping over a ]] already there. */
export function completeLink(
  text: string,
  caret: number,
  start: number,
  title: string,
): { text: string; caret: number } {
  const after = text.slice(caret)
  const closing = after.startsWith(']]') ? '' : ']]'
  const next = `${text.slice(0, start)}${title}${closing}${after}`
  return { text: next, caret: start + title.length + 2 }
}

/** Titles matching the query: those starting with it first, then those containing it. */
export function rankTitles(titles: readonly string[], query: string, limit: number): string[] {
  const needle = query.trim().toLowerCase()
  const starts: string[] = []
  const contains: string[] = []
  for (const title of titles) {
    const lower = title.toLowerCase()
    if (lower.startsWith(needle)) starts.push(title)
    else if (lower.includes(needle)) contains.push(title)
  }
  const byName = (a: string, b: string) => a.localeCompare(b)
  return [...starts.sort(byName), ...contains.sort(byName)].slice(0, limit)
}

/**
 * Pixel position of the caret inside a textarea, relative to the textarea's
 * top-left: a hidden copy with the same styles is measured.
 */
export function caretPosition(
  area: HTMLTextAreaElement,
  caret: number,
): { left: number; top: number } {
  const style = getComputedStyle(area)
  const mirror = document.createElement('div')
  for (const property of [
    'boxSizing',
    'width',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'borderTopWidth',
    'borderLeftWidth',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'letterSpacing',
    'tabSize',
    'whiteSpace',
    'wordWrap',
    'overflowWrap',
  ] as const) {
    mirror.style[property] = style[property]
  }
  mirror.style.position = 'absolute'
  mirror.style.visibility = 'hidden'
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.top = '0'
  mirror.style.left = '-9999px'
  mirror.textContent = area.value.slice(0, caret)
  const marker = document.createElement('span')
  marker.textContent = '​'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  const position = {
    left: marker.offsetLeft - area.scrollLeft,
    top: marker.offsetTop - area.scrollTop + marker.offsetHeight,
  }
  mirror.remove()
  return position
}
