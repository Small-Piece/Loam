import type { TagSuggestion } from './provider.ts'

/** At most this many suggestions per image, so the tag list does not explode. */
export const MAX_SUGGESTIONS = 8
const MAX_TAG_LENGTH = 40

/**
 * A small synonym pass: words that mean the same for tagging art references.
 * Keys and values are matching keys (see matchKey), mapped to one form.
 */
const SYNONYMS: Readonly<Record<string, string>> = {
  colour: 'color',
  colours: 'color',
  grey: 'gray',
  'sci fi': 'science fiction',
  scifi: 'science fiction',
  'anime style': 'anime',
  'anime art': 'anime',
  'manga style': 'manga',
  scenery: 'landscape',
  'landscape art': 'landscape',
  'concept artwork': 'concept art',
  'hand drawn': 'hand-drawn',
  'hand painted': 'hand-painted',
  'golden hour': 'golden light',
  dusk: 'sunset',
  'medieval architecture': 'medieval',
  'fantasy art': 'fantasy',
  'fantasy setting': 'fantasy',
}

/** Lower case, single spaces, no surrounding punctuation. */
export function cleanTag(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s_]+/g, ' ')
    .replace(/^[\s"'.,;:!?#*-]+|[\s"'.,;:!?#*-]+$/g, '')
    .slice(0, MAX_TAG_LENGTH)
    .trim()
}

/** One word in its singular form, roughly: "windmills" -> "windmill", "cities" -> "city". */
function singular(word: string): string {
  if (word.length <= 3 || word.endsWith('ss') || word.endsWith('us') || word.endsWith('is'))
    return word
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (/(ches|shes|xes|ses)$/.test(word)) return word.slice(0, -2)
  if (word.endsWith('s')) return word.slice(0, -1)
  return word
}

/**
 * The key two tags share when they mean the same: case, hyphens, plurals,
 * British spelling and the synonyms above do not matter.
 */
export function matchKey(tag: string): string {
  const spaced = cleanTag(tag).replace(/-/g, ' ')
  const mapped = SYNONYMS[spaced] ?? spaced
  return mapped
    .replace(/-/g, ' ')
    .split(' ')
    .map((word) => SYNONYMS[word] ?? word)
    .map(singular)
    .join(' ')
}

/**
 * Turns a provider's raw suggestions into the ones to show: cleaned, mapped
 * onto an existing tag when it means the same, without tags the image has or
 * the user rejected for it, one per meaning (highest confidence wins), most
 * confident first, at most MAX_SUGGESTIONS.
 */
export function preferKnownTags(
  raw: readonly TagSuggestion[],
  knownTags: readonly string[],
  skip: readonly string[] = [],
): TagSuggestion[] {
  const known = new Map<string, string>()
  for (const tag of knownTags) {
    const key = matchKey(tag)
    // An existing tag keeps its own spelling.
    if (key !== '' && !known.has(key)) known.set(key, tag.trim())
  }
  const skipped = new Set(skip.map(matchKey))
  const byKey = new Map<string, TagSuggestion>()
  for (const item of raw) {
    const cleaned = cleanTag(item.tag)
    if (cleaned === '' || cleaned.split(' ').length > 4) continue
    const key = matchKey(cleaned)
    if (skipped.has(key)) continue
    const tag = known.get(key) ?? cleaned
    const confidence = Math.min(
      1,
      Math.max(0, Number.isFinite(item.confidence) ? item.confidence : 0),
    )
    const previous = byKey.get(key)
    if (!previous || confidence > previous.confidence) byKey.set(key, { tag, confidence })
  }
  return [...byKey.values()]
    .sort((a, b) => b.confidence - a.confidence || a.tag.localeCompare(b.tag))
    .slice(0, MAX_SUGGESTIONS)
}
