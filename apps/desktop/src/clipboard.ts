import { clipboard, ClipboardItem } from 'electron'
import type { ClipboardPort } from './clipboardPort.ts'

/**
 * Loam's private clipboard format, written in the same atomic write as the image.
 * Any other app that copies replaces the whole clipboard, so the marker is gone then.
 */
const MARK_FORMAT = 'electron application/osclipboard;format="Loam References"'

export const systemClipboard: ClipboardPort = {
  async writeCopy(image, mark) {
    const entries: Record<string, Blob> = { [MARK_FORMAT]: new Blob([mark]) }
    // Blob copies the bytes, so the caller's buffer may be reused afterwards.
    if (image) entries[image.mime] = new Blob([image.bytes], { type: image.mime })
    await clipboard.write([new ClipboardItem(entries)])
  },
  async readMark() {
    const items = await clipboard.read()
    let mark: string | null = null
    let hasImage = false
    for (const item of items) {
      if (item.types.some((type) => type.startsWith('image/'))) hasImage = true
      if (mark === null && item.types.includes(MARK_FORMAT)) {
        mark = await (await item.getType(MARK_FORMAT)).text()
      }
    }
    return { mark, hasImage }
  },
}
