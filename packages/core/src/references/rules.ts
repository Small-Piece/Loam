import type { ImageMime } from './types.ts'

export const LIMITS = {
  imageBytes: 64 * 1024 * 1024,
  thumbnailBytes: 2 * 1024 * 1024,
  imagesPerImport: 200,
  dimension: 32_768,
  titleLength: 200,
  noteLength: 20_000,
  sourceLength: 2_000,
  tagLength: 40,
  tagsPerReference: 30,
  boardNameLength: 80,
} as const

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false
  return signature.every((byte, index) => bytes[offset + index] === byte)
}

const ASCII = (text: string): number[] => [...text].map((char) => char.charCodeAt(0))

/** Identifies the image format from its leading bytes; null when it is not a supported image. */
export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, ASCII('GIF87a')) || startsWith(bytes, ASCII('GIF89a'))) return 'image/gif'
  if (startsWith(bytes, ASCII('RIFF')) && startsWith(bytes, ASCII('WEBP'), 8)) return 'image/webp'
  if (startsWith(bytes, ASCII('BM'))) return 'image/bmp'
  if (startsWith(bytes, ASCII('ftyp'), 4)) {
    if (startsWith(bytes, ASCII('avif'), 8) || startsWith(bytes, ASCII('avis'), 8)) {
      return 'image/avif'
    }
  }
  return null
}

/** Tags are trimmed, single-spaced, lowercase, deduplicated and length-limited. */
export function normalizeTags(raw: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const tag of raw) {
    const clean = tag.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, LIMITS.tagLength)
    if (clean.length > 0) seen.add(clean)
  }
  return [...seen].slice(0, LIMITS.tagsPerReference)
}

/** Default title for an import: the file name without its extension. */
export function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '')
  const withoutExtension = base.replace(/\.[^.]+$/, '')
  const title = (withoutExtension || base).trim()
  return (title || 'Untitled image').slice(0, LIMITS.titleLength)
}

/**
 * Turns free text into a safe FTS5 query: every word becomes a quoted
 * prefix term and all terms must match. Returns null when nothing is left.
 */
export function toFtsQuery(text: string): string | null {
  const words = text
    .split(/\s+/)
    .map((word) => word.replace(/"/g, ''))
    .filter((word) => word.length > 0)
  if (words.length === 0) return null
  return words.map((word) => `"${word}"*`).join(' ')
}
