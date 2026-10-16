/**
 * Image formats Electron decodes into a clipboard image that other apps accept
 * (checked on Windows: PNG and JPEG arrive as a full-size bitmap; WebP, GIF and
 * BMP writes are ignored, so those formats are copied for Loam only).
 */
const SHAREABLE = new Set(['image/png', 'image/jpeg'])

export function isShareable(mime: string): boolean {
  return SHAREABLE.has(mime)
}

/** The system clipboard, as the copy and paste handlers use it. */
export interface ClipboardPort {
  /** Writes the image (when there is one) and the marker in one atomic write. */
  writeCopy(
    image: { bytes: Uint8Array<ArrayBuffer>; mime: string } | null,
    mark: string,
  ): Promise<void>
  /** The marker text, if the clipboard holds one, and whether it holds an image. */
  readMark(): Promise<{ mark: string | null; hasImage: boolean }>
}
