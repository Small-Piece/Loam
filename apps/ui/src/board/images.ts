import type { ImageUpload } from '@loam/protocol'

const THUMB_WIDTH = 480
const THUMB_QUALITY = 0.82
const CONCURRENCY = 4

export type PreparedImage =
  { ok: true; upload: ImageUpload } | { ok: false; fileName: string; reason: string }

/**
 * Decodes one image file and renders a WebP thumbnail at most 480 px wide.
 * Decoding in the browser covers PNG, JPEG, GIF, WebP, BMP and AVIF with no
 * extra dependency; the backend re-checks the real format from the bytes.
 */
async function prepareImage(file: File, fileName: string): Promise<PreparedImage> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return { ok: false, fileName, reason: 'Not a readable image' }
  }
  try {
    const { width, height } = bitmap
    const scale = Math.min(1, THUMB_WIDTH / width)
    const thumbWidth = Math.max(1, Math.round(width * scale))
    const thumbHeight = Math.max(1, Math.round(height * scale))
    const canvas = new OffscreenCanvas(thumbWidth, thumbHeight)
    const context = canvas.getContext('2d')
    if (!context) return { ok: false, fileName, reason: 'Could not render a thumbnail' }
    context.drawImage(bitmap, 0, 0, thumbWidth, thumbHeight)
    const thumb = await canvas.convertToBlob({ type: 'image/webp', quality: THUMB_QUALITY })
    const [bytes, thumbBytes] = await Promise.all([file.arrayBuffer(), thumb.arrayBuffer()])
    return {
      ok: true,
      upload: {
        fileName,
        bytes: new Uint8Array(bytes),
        width,
        height,
        thumbnail: { bytes: new Uint8Array(thumbBytes), width: thumbWidth, height: thumbHeight },
      },
    }
  } finally {
    bitmap.close()
  }
}

/** Prepares files a few at a time, keeping their order. */
export async function prepareImages(
  files: ReadonlyArray<{ file: File; fileName: string }>,
): Promise<PreparedImage[]> {
  const results: PreparedImage[] = new Array<PreparedImage>(files.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < files.length) {
      const index = next++
      const entry = files[index]
      if (entry) results[index] = await prepareImage(entry.file, entry.fileName)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker))
  return results
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** File name for a pasted screenshot, e.g. "Pasted image 2026-10-12 14.05.png". */
export function pastedImageName(now: Date, index: number): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}.${pad(now.getMinutes())}`
  const suffix = index > 0 ? ` (${index + 1})` : ''
  return `Pasted image ${date} ${time}${suffix}.png`
}
