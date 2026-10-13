const MAX_SLUG_LENGTH = 80
// Names Windows reserves for devices, with or without an extension.
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/

/**
 * File-name slug of a title: lower case, letters and digits of any script
 * kept, everything else turned into single dashes. Safe on Windows.
 */
export function slugify(title: string): string {
  const words = title
    .normalize('NFC')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  let slug = Array.from(words).slice(0, MAX_SLUG_LENGTH).join('').replace(/-+$/, '')
  if (slug === '') slug = 'untitled'
  if (RESERVED_NAME.test(slug)) slug = `${slug}-entry`
  return slug
}

/** The first of slug, slug-2, slug-3... that `taken` does not contain. */
export function uniqueName(
  base: string,
  extension: string,
  taken: (name: string) => boolean,
): string {
  for (let index = 1; ; index++) {
    const name = index === 1 ? `${base}${extension}` : `${base}-${index}${extension}`
    if (!taken(name)) return name
  }
}

/** The key [[links]] match on: trimmed, single-spaced, lower case. */
export function titleKey(title: string): string {
  return title.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
}
