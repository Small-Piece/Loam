import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFieldDefs, type StarterKit, type StarterKits } from '@loam/core'

interface KitFile {
  id?: unknown
  name?: unknown
  description?: unknown
  order?: unknown
  role?: unknown
  sections?: unknown
}

const ID = /^[a-z0-9][a-z0-9-]*$/

function readKit(dir: string): (StarterKit & { order: number }) | null {
  let raw: KitFile
  try {
    raw = JSON.parse(readFileSync(join(dir, 'kit.json'), 'utf8')) as KitFile
  } catch {
    return null
  }
  if (typeof raw.id !== 'string' || !ID.test(raw.id) || typeof raw.name !== 'string') return null
  if (!Array.isArray(raw.sections)) return null
  const sections: StarterKit['sections'] = []
  for (const item of raw.sections as unknown[]) {
    const section = item as { id?: unknown; name?: unknown; template?: unknown; fields?: unknown }
    if (
      typeof section.id !== 'string' ||
      !ID.test(section.id) ||
      typeof section.name !== 'string'
    ) {
      return null
    }
    let template = ''
    if (typeof section.template === 'string') {
      const file = join(dir, section.template)
      if (!file.startsWith(dir) || !existsSync(file)) return null
      // A Windows git checkout may give the template CRLF line endings; new
      // entries are written with LF throughout, so normalize here.
      template = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    }
    sections.push({
      id: section.id,
      name: section.name,
      template,
      fields: parseFieldDefs(section.fields),
    })
  }
  return {
    id: raw.id,
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description : '',
    role: raw.role === 'journal' ? 'journal' : 'bible',
    order: typeof raw.order === 'number' ? raw.order : Number.MAX_SAFE_INTEGER,
    sections,
  }
}

/**
 * Starter kits shipped as plain folders: starter-kits/<id>/kit.json plus the
 * template files it names. Folders that do not parse are skipped.
 */
export class FolderStarterKits implements StarterKits {
  private readonly dir: string
  private cache: StarterKit[] | null = null

  constructor(dir: string) {
    this.dir = dir
  }

  list(): StarterKit[] {
    if (this.cache) return this.cache
    const kits: Array<StarterKit & { order: number }> = []
    for (const entry of existsSync(this.dir)
      ? readdirSync(this.dir, { withFileTypes: true })
      : []) {
      if (!entry.isDirectory()) continue
      const kit = readKit(join(this.dir, entry.name))
      if (kit && kit.id === entry.name) kits.push(kit)
    }
    kits.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    this.cache = kits.map(({ order: _order, ...kit }) => kit)
    return this.cache
  }
}
