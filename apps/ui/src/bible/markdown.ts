import { Marked, type Tokens, type TokenizerAndRendererExtension } from 'marked'
import { ASSET_SCHEME } from '@loam/protocol/bridge'

/** [[Title]], [[Title|shown text]] or [[Title#Heading]], the same grammar the backend indexes. */
const WIKI_LINK = /^\[\[([^[\]\r\n]+?)\]\]/

export interface WikiTarget {
  target: string
  heading: string | null
  alias: string | null
}

export function parseWikiLink(inner: string): WikiTarget {
  const bar = inner.indexOf('|')
  const targetPart = bar === -1 ? inner : inner.slice(0, bar)
  const hash = targetPart.indexOf('#')
  return {
    target: (hash === -1 ? targetPart : targetPart.slice(0, hash)).trim(),
    heading: hash === -1 ? null : targetPart.slice(hash + 1),
    alias: bar === -1 ? null : inner.slice(bar + 1),
  }
}

/** The key links match titles on: trimmed, single-spaced, lower case. */
export function titleKey(title: string): string {
  return title.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Links the preview may show as links; anything else (javascript:, data:, file:) becomes text. */
function safeHref(href: string): string | null {
  const trimmed = href.trim()
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) return null
  return trimmed
}

interface WikiToken extends Tokens.Generic, WikiTarget {
  type: 'wikiLink'
}

/** Resolves a link target to an entry path, or null when no entry has that title. */
export type ResolveTitle = (title: string) => string | null

let resolve: ResolveTitle = () => null
/** Vault-relative path of the entry being rendered; relative image links resolve from it. */
let entryPath = ''
/** Which open vault the entry is in, so its images load from there. */
let assetHost: AssetHost = 'vault'

/**
 * A link in an entry resolved to a vault-relative path (relative to the
 * entry's folder, or to the vault with a leading "/"); null when it is
 * remote or would leave the vault. The backend checks the path again.
 */
export function resolveVaultLink(fromEntry: string, href: string): string | null {
  const clean = href.trim().split(/[?#]/)[0] ?? ''
  if (clean === '' || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//')) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(clean)
  } catch {
    return null
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null
  const parts = decoded.startsWith('/') ? [] : fromEntry.split('/').slice(0, -1)
  for (const part of decoded.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  return parts.length === 0 ? null : parts.join('/')
}

/** The URL the preview loads a vault image from. */
/** Which open vault serves an image: the bible ("vault") or the journal. */
export type AssetHost = 'vault' | 'journal'

export function vaultImageUrl(vaultPath: string, host: AssetHost = 'vault'): string {
  return `${ASSET_SCHEME}://${host}/${vaultPath.split('/').map(encodeURIComponent).join('/')}`
}

const wikiLink: TokenizerAndRendererExtension = {
  name: 'wikiLink',
  level: 'inline',
  start(src) {
    const at = src.indexOf('[[')
    return at === -1 ? undefined : at
  },
  tokenizer(src) {
    const match = WIKI_LINK.exec(src)
    if (!match?.[1]) return undefined
    const parsed = parseWikiLink(match[1])
    if (parsed.target === '') return undefined
    const token: WikiToken = { type: 'wikiLink', raw: match[0], ...parsed }
    return token
  },
  renderer(token) {
    const { target, heading, alias } = token as WikiToken
    const shown = escapeHtml(alias ?? (heading ? `${target} › ${heading}` : target))
    const path = resolve(target)
    if (path === null) {
      return `<a href="#" class="wiki-link missing" data-create="${escapeHtml(target)}" title="Create “${escapeHtml(target)}”">${shown}</a>`
    }
    return `<a href="#" class="wiki-link" data-path="${escapeHtml(path)}" title="${escapeHtml(target)}">${shown}</a>`
  },
}

const markdown = new Marked({ gfm: true, breaks: false, async: false })
markdown.use({
  extensions: [wikiLink],
  renderer: {
    // Raw HTML is shown as text, never rendered.
    html(token) {
      return escapeHtml(token.text)
    },
    link(token) {
      const text = this.parser.parseInline(token.tokens)
      const href = safeHref(token.href)
      if (href === null) return text
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
      // The preview never navigates; an http(s) link opens in the browser after a prompt.
      const external = /^https?:/i.test(href) ? ` data-external="${escapeHtml(href)}"` : ''
      return `<a href="${escapeHtml(href)}" class="external-link"${external}${title}>${text}</a>`
    },
    // Images inside the vault load through the app's own scheme; anything
    // else (the network, other folders) shows as a label and never loads.
    image(token) {
      const local = resolveVaultLink(entryPath, token.href)
      if (local !== null) {
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
        return `<img class="md-local-image" src="${escapeHtml(vaultImageUrl(local, assetHost))}" alt="${escapeHtml(token.text)}"${title} data-vault-path="${escapeHtml(local)}">`
      }
      return `<span class="md-image" title="${escapeHtml(token.href)}">[image: ${escapeHtml(token.text || token.href)}]</span>`
    },
  },
})

/** Renders an entry body to HTML; raw HTML in the source is escaped. */
export function renderMarkdown(
  text: string,
  resolveTitle: ResolveTitle,
  fromEntry = '',
  host: AssetHost = 'vault',
): string {
  resolve = resolveTitle
  entryPath = fromEntry
  assetHost = host
  try {
    return markdown.parse(text) as string
  } finally {
    resolve = () => null
    entryPath = ''
    assetHost = 'vault'
  }
}
