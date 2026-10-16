import { describe, expect, it } from 'vitest'
import { copiedMessage } from './copyMessage.ts'

describe('the copy toast', () => {
  it('names one image or the count, and which one other apps get', () => {
    expect(copiedMessage([7], 7)).toBe('Copied image')
    expect(copiedMessage([7, 8, 9], 7)).toBe('Copied 3 images (other apps get the first)')
    expect(copiedMessage([7, 8, 9], 8)).toBe(
      'Copied 3 images (other apps get the first PNG or JPEG)',
    )
  })

  it('says when no image could go to other apps, or nothing was copied', () => {
    expect(copiedMessage([7], null)).toBe(
      'Copied image for Loam only (other apps take PNG and JPEG images only)',
    )
    expect(copiedMessage([], null)).toMatch(/^Nothing was copied/)
  })
})
