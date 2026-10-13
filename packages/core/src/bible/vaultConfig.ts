import { parseFieldDefs, serializeFieldDef } from './fields.ts'
import { slugify, uniqueName } from './slug.ts'
import {
  TRASH_DIR,
  VAULT_FORMAT,
  type ConfigSection,
  type Section,
  type VaultConfig,
} from './types.ts'

export const CONFIG_FILE = 'bible.json'
export const README_FILE = 'README.md'

export class VaultError extends Error {
  override name = 'VaultError'
}

const SECTION_ID = /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u

function readSection(value: unknown): ConfigSection | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const { id, name, fields, ...extra } = value as Record<string, unknown>
  if (typeof id !== 'string' || !SECTION_ID.test(id) || id === TRASH_DIR) return null
  if (typeof name !== 'string') return null
  return { id, name: name.trim() || id, fields: parseFieldDefs(fields), extra }
}

/** True when a section id is usable as a folder name. */
export function isSectionId(id: string): boolean {
  return SECTION_ID.test(id) && id !== TRASH_DIR
}

/** Reads bible.json. Keys the app does not know are kept so they are written back unchanged. */
export function parseVaultConfig(text: string): VaultConfig {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new VaultError('bible.json is not valid JSON')
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new VaultError('bible.json must hold an object')
  }
  const { format, title, kit, sections, ...extra } = raw as Record<string, unknown>
  if (typeof format !== 'number' || !Number.isInteger(format)) {
    throw new VaultError('bible.json has no format version')
  }
  if (format > VAULT_FORMAT) {
    throw new VaultError(
      `This bible uses format ${format}; this version of the app reads up to ${VAULT_FORMAT}`,
    )
  }
  const seen = new Set<string>()
  const list: ConfigSection[] = []
  for (const item of Array.isArray(sections) ? sections : []) {
    const section = readSection(item)
    if (!section || seen.has(section.id)) continue
    seen.add(section.id)
    list.push(section)
  }
  return {
    format,
    title: typeof title === 'string' && title.trim() ? title : 'Bible',
    kit: typeof kit === 'string' ? kit : null,
    sections: list,
    extra,
  }
}

export function serializeVaultConfig(config: VaultConfig): string {
  const { format, title, kit, sections, extra } = config
  const out = {
    format,
    title,
    kit,
    sections: sections.map(({ id, name, fields, extra: sectionExtra }) => ({
      id,
      name,
      ...(fields.length > 0 ? { fields: fields.map(serializeFieldDef) } : {}),
      ...sectionExtra,
    })),
    ...extra,
  }
  return `${JSON.stringify(out, null, 2)}\n`
}

/** A folder name for a new section that no other section uses. */
export function newSectionId(name: string, sections: readonly Section[]): string {
  const taken = new Set(sections.map((section) => section.id.toLowerCase()))
  return uniqueName(
    slugify(name),
    '',
    (candidate) => taken.has(candidate) || candidate === TRASH_DIR,
  )
}

/** README.md written once when a vault is created; explains the format to people and coding agents. */
export function vaultReadme(title: string, sections: readonly Section[]): string {
  const list = sections.map((section) => `- \`${section.id}/\` ${section.name}`).join('\n')
  return `# ${title}

This folder is a creative bible: the living record of what this game is meant to be and why.
It was created by Loam, but it is plain Markdown and belongs to you. Read it, edit it,
version it with git and share it with your team; no export step is needed.

## Layout

- \`bible.json\`: format version, title and the list of sections with their order and names.
- One folder per section, one \`.md\` file per entry. The file name is the entry title as a slug.
- \`.trash/\`: entries and sections deleted in the app (\`.trash/<section>/\` for entries,
  \`.trash/_sections/\` for whole sections; \`.trash/index.json\` records where each came from).
  Restore them from the app's Trash view, or move a file back by hand.

Sections in this bible:

${list}

## Entries

Each entry starts with YAML front matter:

\`\`\`yaml
---
id: k3v9q2m8x1ad        # stable id, generated once; keep it when you rename or move the file
title: Wonder before danger
tags: [tone]
order: 1                # position within its section
created: 2026-10-13T09:00:00.000Z
updated: 2026-10-13T09:00:00.000Z
---
\`\`\`

A section can declare \`fields\` in \`bible.json\` (for example \`threat\` or \`habitat\`). Their values
are plain front-matter keys; an \`entry\` field holds the \`id\` of the entry it points at.

The Markdown body follows. Other front-matter fields and other files are left untouched by the app.

## Links

\`[[Title]]\` links to another entry by its title (\`[[Title|shown text]]\` and \`[[Title#Heading]]\`
work too). When an entry is renamed in the app, links to it are updated across the bible.

## For AI agents

Treat this bible as the source of the game's intent. The Pillars section lists what every
decision should serve; read it before proposing changes. People write this bible; agents read it.
`
}
