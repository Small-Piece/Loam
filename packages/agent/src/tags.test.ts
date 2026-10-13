import { describe, expect, it } from 'vitest'
import { MAX_SUGGESTIONS, cleanTag, matchKey, preferKnownTags } from './tags.ts'

const s = (tag: string, confidence = 0.5) => ({ tag, confidence })

describe('tag suggestions prefer existing tags', () => {
  it('cleans case, spacing and punctuation', () => {
    expect(cleanTag('  Golden_Light. ')).toBe('golden light')
    expect(cleanTag('"Anime  Style"')).toBe('anime style')
  })

  it('treats plurals, hyphens, British spelling and synonyms as the same tag', () => {
    expect(matchKey('Windmills')).toBe(matchKey('windmill'))
    expect(matchKey('hand drawn')).toBe(matchKey('Hand-drawn'))
    expect(matchKey('warm colours')).toBe(matchKey('warm color'))
    expect(matchKey('anime style')).toBe(matchKey('Anime'))
    expect(matchKey('sci-fi')).toBe(matchKey('science fiction'))
    expect(matchKey('grass')).toBe('grass')
  })

  it('maps a suggestion onto the existing tag that means the same', () => {
    const result = preferKnownTags(
      [s('Windmills', 0.9), s('anime style', 0.8), s('ruins', 0.7)],
      ['windmill', 'Anime', 'entrance'],
    )
    // The existing tag keeps its own spelling.
    expect(result.map((item) => item.tag)).toEqual(['windmill', 'Anime', 'ruins'])
  })

  it('drops tags the image has or the user rejected, and keeps one per meaning', () => {
    const result = preferKnownTags(
      [s('ruins', 0.4), s('Ruin', 0.9), s('sunset', 0.8), s('dusk', 0.6), s('stone', 0.5)],
      [],
      ['stone', 'sunset'],
    )
    expect(result).toEqual([s('ruin', 0.9)])
  })

  it('orders by confidence, clamps it, skips empty and long phrases, and caps the count', () => {
    const many = Array.from({ length: 20 }, (_, index) => s(`tag ${index}`, index / 20))
    const result = preferKnownTags(
      [...many, s('', 1), s('one two three four five', 1), s('sky', 7)],
      [],
    )
    expect(result).toHaveLength(MAX_SUGGESTIONS)
    expect(result[0]).toEqual(s('sky', 1))
    expect(result[1]?.tag).toBe('tag 19')
  })
})
