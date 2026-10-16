/** An existing Library tag and how many references use it. */
export interface TagOption {
  name: string
  count: number
}

/** How the Library compares tags: trimmed, inner spaces collapsed, case-insensitive. */
function tagKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Existing tags to offer for the typed text: not already on the reference, containing
 * the text anywhere (any case). Names that start with the text come first, then the
 * most used, then by name.
 */
export function tagOptions(
  all: readonly TagOption[],
  current: readonly string[],
  text: string,
): TagOption[] {
  const taken = new Set(current.map(tagKey))
  const query = tagKey(text)
  const matches = all.filter((tag) => {
    const key = tagKey(tag.name)
    return !taken.has(key) && key.includes(query)
  })
  const startsWith = (tag: TagOption) => tagKey(tag.name).startsWith(query)
  return matches.sort((a, b) => {
    if (startsWith(a) !== startsWith(b)) return startsWith(a) ? -1 : 1
    if (a.count !== b.count) return b.count - a.count
    return a.name.localeCompare(b.name)
  })
}

/** The existing tag the text names, in any case; null when it names none. */
export function existingTag(all: readonly TagOption[], text: string): TagOption | null {
  const key = tagKey(text)
  if (key === '') return null
  return all.find((tag) => tagKey(tag.name) === key) ?? null
}

/** What to add for typed text: the existing tag's spelling when it names one, else the text. */
export function tagToAdd(all: readonly TagOption[], text: string): string | null {
  const clean = text.trim().replace(/\s+/g, ' ')
  if (clean === '') return null
  return existingTag(all, clean)?.name ?? clean
}

/** Whether to offer creating the typed text: it names no existing tag and is not on the reference. */
export function canCreate(
  all: readonly TagOption[],
  current: readonly string[],
  text: string,
): boolean {
  const key = tagKey(text)
  if (key === '' || existingTag(all, text)) return false
  return !current.some((tag) => tagKey(tag) === key)
}
