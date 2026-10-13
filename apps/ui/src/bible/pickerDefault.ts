import { titleKey } from './markdown.ts'

type Sections = ReadonlyArray<{ id: string; entries: ReadonlyArray<{ title: string }> }>

/**
 * The section most entries with a similar title live in: titles sharing a
 * word (or a number) with the new one. Null when nothing is similar.
 */
export function suggestSection(title: string, sections: Sections): string | null {
  const words = (text: string) =>
    new Set(
      titleKey(text)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length >= 3 || /\d/.test(word)),
    )
  const wanted = words(title)
  if (wanted.size === 0) return null
  let best: { id: string; count: number } | null = null
  for (const section of sections) {
    const count = section.entries.filter((entry) =>
      [...words(entry.title)].some((word) => wanted.has(word)),
    ).length
    if (count > 0 && (!best || count > best.count)) best = { id: section.id, count }
  }
  return best?.id ?? null
}

/**
 * Where the picker for a missing link starts: the section last chosen for
 * links from this section, else the section of similar titles, else the
 * section the link is in.
 */
export function linkPickerDefault(
  title: string,
  fromSection: string,
  sections: Sections,
  remembered: Readonly<Record<string, string>>,
): string {
  const last = remembered[fromSection]
  if (last !== undefined && sections.some((section) => section.id === last)) return last
  return suggestSection(title, sections) ?? fromSection
}
