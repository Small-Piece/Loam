import { describe, expect, it } from 'vitest'
import { normalizeTags, sniffImageMime, titleFromFileName, toFtsQuery } from './rules.ts'

const bytes = (...values: number[]) => Uint8Array.from(values)
const ascii = (text: string) => Uint8Array.from([...text].map((char) => char.charCodeAt(0)))

describe('sniffImageMime', () => {
  it('recognizes supported formats by signature', () => {
    expect(sniffImageMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe(
      'image/png',
    )
    expect(sniffImageMime(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg')
    expect(sniffImageMime(ascii('GIF89a...'))).toBe('image/gif')
    expect(sniffImageMime(ascii('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(sniffImageMime(ascii('BM\0\0\0\0'))).toBe('image/bmp')
    expect(sniffImageMime(ascii('\0\0\0\x1cftypavif'))).toBe('image/avif')
  })

  it('rejects non-images whatever their name', () => {
    expect(sniffImageMime(ascii('%PDF-1.7'))).toBeNull()
    expect(sniffImageMime(ascii('MZ\x90\0'))).toBeNull()
    expect(sniffImageMime(new Uint8Array())).toBeNull()
  })
})

describe('normalizeTags', () => {
  it('trims, lowercases, collapses spaces and removes duplicates', () => {
    expect(normalizeTags(['  Forest ', 'forest', 'Zone   2', '', '  '])).toEqual([
      'forest',
      'zone 2',
    ])
  })

  it('caps tag length and count', () => {
    const many = Array.from({ length: 40 }, (_, index) => `tag${index}`)
    expect(normalizeTags(many)).toHaveLength(30)
    expect(normalizeTags(['x'.repeat(100)])[0]).toHaveLength(40)
  })
})

describe('titleFromFileName', () => {
  it('drops the directory and extension', () => {
    expect(titleFromFileName('C:\\art\\ashfall zone2.final.png')).toBe('ashfall zone2.final')
    expect(titleFromFileName('.png')).toBe('.png')
    expect(titleFromFileName('')).toBe('Untitled image')
  })
})

describe('toFtsQuery', () => {
  it('turns words into quoted prefix terms', () => {
    expect(toFtsQuery('forest  cave')).toBe('"forest"* "cave"*')
  })

  it('neutralizes FTS syntax in user input', () => {
    expect(toFtsQuery('a" OR "b')).toBe('"a"* "OR"* "b"*')
    expect(toFtsQuery('NEAR(x y)')).toBe('"NEAR(x"* "y)"*')
    expect(toFtsQuery('   ')).toBeNull()
  })
})
