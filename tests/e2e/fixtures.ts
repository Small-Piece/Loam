import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { JSHandle, Page } from '@playwright/test'

export interface ImageSpec {
  index: number
  width?: number
  height?: number
  /** PNG by default; JPEG for photo-sized images, which is what references usually are. */
  type?: 'image/png' | 'image/jpeg'
  /** Adds per-pixel grain, so the file is as large and slow to decode as a real photo. */
  grain?: boolean
}

/**
 * Builds images in the page inside a DataTransfer, as Explorer would hand them
 * over. Each index gives distinct content, so each file has its own hash.
 */
export function makeImageTransfer(
  page: Page,
  images: ReadonlyArray<number | ImageSpec>,
): Promise<JSHandle<DataTransfer>> {
  const specs = images.map((image) => (typeof image === 'number' ? { index: image } : image))
  return page.evaluateHandle(async (list) => {
    async function render(spec: ImageSpec): Promise<File> {
      const width = spec.width ?? 1920
      const height = spec.height ?? 1080
      const type = spec.type ?? 'image/png'
      const index = spec.index
      const canvas = new OffscreenCanvas(width, height)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('no 2d context')
      const gradient = context.createLinearGradient(0, 0, width, height)
      gradient.addColorStop(0, `hsl(${(index * 37) % 360} 60% 35%)`)
      gradient.addColorStop(1, `hsl(${(index * 37 + 120) % 360} 50% 20%)`)
      context.fillStyle = gradient
      context.fillRect(0, 0, width, height)
      const cell = Math.max(60, Math.round(width / 16))
      for (let shape = 0; shape < 60; shape++) {
        context.fillStyle = `hsl(${(index * 13 + shape * 29) % 360} 70% 60% / 0.5)`
        context.fillRect(
          (shape * 97 + index * 31) % Math.max(1, width - cell),
          (shape * 53 + index * 17) % Math.max(1, height - cell),
          cell,
          Math.round(cell * 0.66),
        )
      }
      if (spec.grain) {
        const pixels = context.getImageData(0, 0, width, height)
        let seed = index * 7919 + 1
        for (let offset = 0; offset < pixels.data.length; offset += 4) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff
          const noise = (seed & 31) - 16
          pixels.data[offset] = (pixels.data[offset] ?? 0) + noise
          pixels.data[offset + 1] = (pixels.data[offset + 1] ?? 0) + noise
          pixels.data[offset + 2] = (pixels.data[offset + 2] ?? 0) + noise
        }
        context.putImageData(pixels, 0, 0)
      }
      context.fillStyle = 'white'
      context.font = `${Math.round(height / 11)}px sans-serif`
      context.fillText(`Reference ${index}`, width / 16, height / 2)
      const blob = await canvas.convertToBlob({ type, quality: 0.9 })
      const extension = type === 'image/png' ? 'png' : 'jpg'
      const name = `ref-${String(index).padStart(2, '0')}.${extension}`
      return new File([blob], name, { type })
    }
    // Encode in parallel: this is test setup, not part of anything measured.
    const files = await Promise.all(list.map(render))
    const transfer = new DataTransfer()
    for (const file of files) transfer.items.add(file)
    return transfer
  }, specs)
}

/** Drops the files on the board the way Explorer does: dragenter, dragover, drop. */
export async function drop(page: Page, transfer: JSHandle<DataTransfer>): Promise<void> {
  await page.evaluate((dataTransfer) => {
    const target = document.querySelector('.board-scroll') ?? document.body
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }))
    }
  }, transfer)
}

export const cards = (page: Page) => page.getByTestId('ref-card')

/** Files in the content-addressed store under the given %LOCALAPPDATA%. */
export function storedFiles(localAppData: string): string[] {
  const root = join(localAppData, 'Loam', 'files')
  if (!existsSync(root)) return []
  return readdirSync(root).flatMap((shard) => readdirSync(join(root, shard)))
}
