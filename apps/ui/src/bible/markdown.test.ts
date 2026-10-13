import { describe, expect, it } from 'vitest'
import { parseWikiLink, renderMarkdown, titleKey } from './markdown.ts'

const titles = new Map([[titleKey('The Ashfall'), 'world/the-ashfall.md']])
const resolve = (title: string) => titles.get(titleKey(title)) ?? null

describe('renderMarkdown', () => {
  it('renders Markdown with wiki links resolved and missing ones marked', () => {
    const html = renderMarkdown(
      '# Rowan\n\nGoes to [[the ashfall|the pit]] and [[Nowhere]].',
      resolve,
    )
    expect(html).toContain('<h1>Rowan</h1>')
    expect(html).toContain(
      '<a href="#" class="wiki-link" data-path="world/the-ashfall.md" title="the ashfall">the pit</a>',
    )
    expect(html).toContain('class="wiki-link missing" data-create="Nowhere"')
  })

  it('never renders raw HTML', () => {
    const html = renderMarkdown(
      '<script>alert(1)</script>\n\nHi <b onclick="x()">there</b>',
      resolve,
    )
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<b ')
    expect(html).toContain('&lt;script&gt;')
  })

  it('drops dangerous link targets and never loads remote images', () => {
    const html = renderMarkdown(
      '[a](javascript:alert(1)) [b](https://example.com) [c](notes.md) ![pic](https://x.test/p.png)',
      resolve,
      'creatures/thing.md',
    )
    expect(html).not.toContain('javascript:')
    // http(s) links carry their URL for the open-in-browser prompt (Slice 5c).
    expect(html).toContain(
      '<a href="https://example.com" class="external-link" data-external="https://example.com">b</a>',
    )
    expect(html).toContain('href="notes.md" class="external-link">c</a>')
    expect(html).not.toContain('<img')
    expect(html).toContain('[image: pic]')
  })

  it('loads images inside the vault through the app scheme, relative to the entry', () => {
    const hash = 'a'.repeat(64)
    const html = renderMarkdown(
      `![Moss](../_assets/${hash}.webp) ![sketch](sketch%201.png) ![out](../../secret.png) ![abs](/world/map.png)`,
      resolve,
      'creatures/thing.md',
    )
    expect(html).toContain(
      `<img class="md-local-image" src="loam-asset://vault/_assets/${hash}.webp" alt="Moss" data-vault-path="_assets/${hash}.webp">`,
    )
    expect(html).toContain('src="loam-asset://vault/creatures/sketch%201.png"')
    expect(html).toContain('src="loam-asset://vault/world/map.png"')
    // Leaving the vault never loads.
    expect(html).toContain('[image: out]')
    expect(html).not.toMatch(/src="[^"]*secret\.png"/)
  })

  it('leaves wiki links in code alone', () => {
    const html = renderMarkdown('`[[The Ashfall]]`\n\n```\n[[The Ashfall]]\n```', resolve)
    expect(html).not.toContain('wiki-link')
  })

  it('escapes link text and attributes', () => {
    const html = renderMarkdown('[[A "quoted" <title>]]', resolve)
    expect(html).toContain('data-create="A &quot;quoted&quot; &lt;title&gt;"')
  })

  it('parses headings and shown text', () => {
    expect(parseWikiLink('Zone 2#Forest|the forest')).toEqual({
      target: 'Zone 2',
      heading: 'Forest',
      alias: 'the forest',
    })
  })
})
