import type { FieldDef } from './fields.ts'
import type { ConfigSection, StarterKit, VaultConfig } from './types.ts'

/** What a vault's kit has that the vault does not: whole sections, and fields of sections it has. */
export interface KitUpdate {
  sections: Array<{ id: string; name: string; fields: FieldDef[] }>
  fields: Array<{ section: string; sectionName: string; field: FieldDef }>
}

/** A short fingerprint of a kit's sections and fields; it changes when the kit does. */
export function kitFingerprint(kit: StarterKit): string {
  const text = JSON.stringify(kit.sections.map(({ id, name, fields }) => ({ id, name, fields })))
  // FNV-1a, 32 bits: enough to notice that a shipped kit changed.
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** The sections and fields the kit would add. Things the vault has (by id or key) are never offered. */
export function kitUpdate(kit: StarterKit, config: VaultConfig): KitUpdate {
  const update: KitUpdate = { sections: [], fields: [] }
  for (const section of kit.sections) {
    const existing = config.sections.find((candidate) => candidate.id === section.id)
    if (!existing) {
      update.sections.push({ id: section.id, name: section.name, fields: section.fields })
      continue
    }
    const keys = new Set(existing.fields.map((field) => field.key))
    for (const field of section.fields) {
      if (!keys.has(field.key)) {
        update.fields.push({ section: section.id, sectionName: existing.name, field })
      }
    }
  }
  return update
}

export function isEmptyUpdate(update: KitUpdate): boolean {
  return update.sections.length === 0 && update.fields.length === 0
}

/**
 * The config with the chosen parts of the update added: new sections at the
 * end, new fields after a section's own. Nothing is removed, renamed or moved.
 */
export function applyKitUpdate(
  config: VaultConfig,
  update: KitUpdate,
  chosen: { sections: readonly string[]; fields: ReadonlyArray<{ section: string; key: string }> },
): VaultConfig {
  const sections: ConfigSection[] = config.sections.map((section) => {
    const added = update.fields
      .filter(
        (item) =>
          item.section === section.id &&
          chosen.fields.some((pick) => pick.section === section.id && pick.key === item.field.key),
      )
      .map((item) => item.field)
    return added.length > 0 ? { ...section, fields: [...section.fields, ...added] } : section
  })
  for (const section of update.sections) {
    if (!chosen.sections.includes(section.id)) continue
    sections.push({ id: section.id, name: section.name, fields: section.fields, extra: {} })
  }
  return { ...config, sections }
}
