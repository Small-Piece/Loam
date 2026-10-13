import { titleKey } from './slug.ts'

/** [[Title]], [[Title|shown text]] or [[Title#Heading]]; no brackets or line breaks inside. */
const WIKI_LINK = /\[\[([^[\]\r\n]+?)\]\]/g
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const CODE_SPAN = /(`+)(?:(?!\1)[\s\S])*?\1/g

export interface WikiLink {
  /** Offset of the opening [[ in the text. */
  start: number
  end: number
  target: string
  heading: string | null
  alias: string | null
}

export function parseLinkInner(inner: string): Pick<WikiLink, 'target' | 'heading' | 'alias'> {
  const bar = inner.indexOf('|')
  const targetPart = bar === -1 ? inner : inner.slice(0, bar)
  const alias = bar === -1 ? null : inner.slice(bar + 1)
  const hash = targetPart.indexOf('#')
  return {
    target: (hash === -1 ? targetPart : targetPart.slice(0, hash)).trim(),
    heading: hash === -1 ? null : targetPart.slice(hash + 1),
    alias,
  }
}

/** Every wiki link in the text, skipping fenced code blocks and inline code. */
export function findWikiLinks(text: string): WikiLink[] {
  const links: WikiLink[] = []
  let offset = 0
  let fence: string | null = null
  for (const line of text.split('\n')) {
    const fenceMatch = FENCE.exec(line)
    if (fence !== null) {
      const marker = fenceMatch?.[1]
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null
      }
    } else if (fenceMatch?.[1]) {
      fence = fenceMatch[1]
    } else {
      const code: Array<[number, number]> = []
      for (const span of line.matchAll(CODE_SPAN))
        code.push([span.index, span.index + span[0].length])
      for (const match of line.matchAll(WIKI_LINK)) {
        const at = match.index
        if (code.some(([from, to]) => at >= from && at < to)) continue
        const parsed = parseLinkInner(match[1] ?? '')
        if (parsed.target === '') continue
        links.push({ start: offset + at, end: offset + at + match[0].length, ...parsed })
      }
    }
    offset += line.length + 1
  }
  return links
}

/** Lower-cased titles the text links to, once each. */
export function linkTargets(text: string): string[] {
  return [...new Set(findWikiLinks(text).map((link) => titleKey(link.target)))]
}

/**
 * Points every link to `oldTitle` at `newTitle`, keeping headings and shown
 * text. Matching ignores case and extra spaces, like link resolution.
 */
export function rewriteLinks(
  text: string,
  oldTitle: string,
  newTitle: string,
): { text: string; count: number } {
  const key = titleKey(oldTitle)
  const links = findWikiLinks(text).filter((link) => titleKey(link.target) === key)
  let out = text
  // From the end, so earlier offsets stay valid.
  for (const link of [...links].reverse()) {
    const heading = link.heading === null ? '' : `#${link.heading}`
    const alias = link.alias === null ? '' : `|${link.alias}`
    out = `${out.slice(0, link.start)}[[${newTitle}${heading}${alias}]]${out.slice(link.end)}`
  }
  return { text: out, count: links.length }
}
