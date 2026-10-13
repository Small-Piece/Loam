const HEADING = /^#{1,6}[ \t]+(.+?)[ \t#]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/** A body cut at its headings: the text before the first heading, then each heading's text. */
export function splitByHeadings(body: string): Array<{ heading: string | null; text: string }> {
  const parts: Array<{ heading: string | null; lines: string[] }> = [{ heading: null, lines: [] }]
  let fenced = false
  for (const line of body.split(/\r?\n/)) {
    if (FENCE.test(line)) fenced = !fenced
    const heading = fenced ? null : HEADING.exec(line)
    if (heading?.[1]) parts.push({ heading: heading[1], lines: [] })
    else parts[parts.length - 1]?.lines.push(line)
  }
  return parts.map(({ heading, lines }) => ({ heading, text: lines.join('\n').trim() }))
}

/**
 * The parts a pillar card shows, found by the Pillar template's headings.
 * A pillar written without them shows its whole text as the feeling.
 */
export function pillarParts(body: string): { feeling: string; inPlay: string; rulesOut: string } {
  const parts = splitByHeadings(body)
  const find = (pattern: RegExp) =>
    parts.find((part) => part.heading !== null && pattern.test(part.heading))?.text ?? ''
  const feeling = find(/feel/i)
  const inPlay = find(/in play|looks like/i)
  const rulesOut = find(/rules? out/i)
  if (feeling || inPlay || rulesOut) return { feeling, inPlay, rulesOut }
  return { feeling: body.trim(), inPlay: '', rulesOut: '' }
}

/** Puts `text` under the template's first heading; with no heading, before the template. */
export function fillFirstHeading(template: string, text: string): string {
  const lines = template.split('\n')
  const at = lines.findIndex((line) => HEADING.test(line))
  if (at === -1) return template.trim() === '' ? `${text}\n` : `${text}\n\n${template}`
  let rest = at + 1
  while (rest < lines.length && lines[rest]?.trim() === '') rest++
  const tail = lines.slice(rest).join('\n')
  return [...lines.slice(0, at + 1), '', text, '', tail].join('\n')
}
