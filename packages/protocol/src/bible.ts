import { z } from 'zod'

const id = z.number().int().positive()
/** A vault-relative entry path such as "world/the-ashfall.md"; the backend checks it further. */
const entryPath = z.string().min(4).max(400)
const trashPath = z.string().min(8).max(400)
const title = z.string().min(1).max(200)
const sectionId = z.string().min(1).max(100)
const folder = z.string().min(1).max(1000)
/** An entry body; generous, but bounded. */
const body = z.string().max(5_000_000)

const fieldType = z.enum([
  'text',
  'number',
  'select',
  'multi-select',
  'entry',
  'entries',
  'date',
  'checkbox',
  'list',
])

/** A section's property, as bible.json declares it. */
export const fieldDefSchema = z.strictObject({
  key: z.string().min(1).max(40),
  label: z.string().min(1).max(100),
  type: fieldType,
  options: z.array(z.string().max(100)).max(100).optional(),
  section: z.string().max(100).optional(),
  builtIn: z.boolean().optional(),
})

/** A property value: text, number, checkbox, one choice or entry id, or a list. */
const fieldValue = z.union([
  z.string().max(10_000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(1000)).max(500),
  z.null(),
])

const propertySchema = fieldDefSchema.extend({
  value: fieldValue,
  /** For entry fields: each stored value and the entry it points at, if any. */
  refs: z.array(
    z.strictObject({
      value: z.string(),
      path: z.string().nullable(),
      title: z.string().nullable(),
    }),
  ),
  /** Set when the stored value does not fit the field; the file keeps it. */
  warning: z.string().nullable(),
  raw: z.string().nullable(),
})

const vaultSummarySchema = z.strictObject({ id, path: z.string(), title: z.string() })
const entrySummarySchema = z.strictObject({ path: z.string(), title: z.string() })
const sectionSchema = z.strictObject({ id: z.string(), name: z.string() })

export const vaultViewSchema = z.strictObject({
  vault: vaultSummarySchema,
  sections: z.array(
    sectionSchema.extend({
      fields: z.array(fieldDefSchema),
      entries: z.array(
        entrySummarySchema.extend({ id: z.string(), stale: z.boolean(), noPillar: z.boolean() }),
      ),
    }),
  ),
  lastEntry: z.string().nullable(),
  kitUpdate: z
    .strictObject({
      sections: z.array(
        z.strictObject({ id: z.string(), name: z.string(), fields: z.array(fieldDefSchema) }),
      ),
      fields: z.array(
        z.strictObject({ section: z.string(), sectionName: z.string(), field: fieldDefSchema }),
      ),
    })
    .nullable(),
  settings: z.strictObject({ copyOriginals: z.boolean() }),
  role: z.enum(['bible', 'journal']),
  /** The section last chosen for entries created from missing links, by the link's section. */
  linkSections: z.record(z.string(), z.string()),
})

export const entryViewSchema = z.strictObject({
  path: z.string(),
  id: z.string(),
  section: z.string(),
  title: z.string(),
  body: z.string(),
  version: z.string(),
  backlinks: z.array(entrySummarySchema),
  tags: z.array(z.string()),
  properties: z.array(propertySchema),
  stale: z.boolean(),
  noPillar: z.boolean().nullable(),
  promotedFrom: entrySummarySchema.nullable(),
  promotedTo: entrySummarySchema.nullable(),
  servedBy: z
    .strictObject({ decisions: z.array(entrySummarySchema), ideas: z.array(entrySummarySchema) })
    .nullable(),
  references: z.array(z.string()),
})

export const saveResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('saved'), entry: entryViewSchema }),
  z.strictObject({ status: z.literal('conflict'), theirs: entryViewSchema }),
])

const trashItemSchema = z.strictObject({
  trashPath: z.string(),
  kind: z.enum(['entry', 'section']),
  name: z.string(),
  from: z.string(),
  sectionName: z.string().nullable(),
  deletedAt: z.string().nullable(),
  entryCount: z.number().int().nonnegative(),
})

const pillarCardSchema = z.strictObject({
  path: z.string(),
  title: z.string(),
  feeling: z.string(),
  inPlay: z.string(),
  rulesOut: z.string(),
  decisions: z.number().int().nonnegative(),
  ideas: z.number().int().nonnegative(),
})

const timelineItemSchema = z.strictObject({
  path: z.string(),
  title: z.string(),
  date: z.string().nullable(),
  status: z.string().nullable(),
  pillars: z.array(entrySummarySchema),
  noPillar: z.boolean(),
})

const ideaCardSchema = z.strictObject({
  path: z.string(),
  title: z.string(),
  status: z.string(),
  pillars: z.array(entrySummarySchema),
  noPillar: z.boolean(),
  promotedTo: entrySummarySchema.nullable(),
})

const kitSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  sections: z.array(sectionSchema),
})

const searchHitSchema = z.strictObject({
  path: z.string(),
  title: z.string(),
  section: z.string(),
  snippet: z.string(),
})

/** Creative Bible messages. A vault is a folder of Markdown files; the index mirrors it. */
export const bibleMessages = {
  /** What the Bible screen needs first: the open vault (reopening the last one), recent vaults and kits. */
  'bible:home': {
    request: z.strictObject({}),
    response: z.strictObject({
      current: vaultViewSchema.nullable(),
      recent: z.array(vaultSummarySchema.extend({ exists: z.boolean() })),
      kits: z.array(kitSchema),
      /** Why the last vault could not be reopened, if it could not. */
      problem: z.string().nullable(),
    }),
  },
  /** Shows the system folder picker. */
  'bible:pickFolder': {
    request: z.strictObject({ purpose: z.enum(['create', 'open', 'sample']) }),
    response: z.strictObject({ path: z.string().nullable() }),
  },
  /** Copies the bundled sample bible into <folder>/bible and opens the copy; the bundled one is never edited. */
  'bible:openSample': {
    request: z.strictObject({ folder }),
    response: vaultViewSchema,
  },
  /** Creates <folder>/bible from a starter kit and opens it. */
  'bible:create': {
    request: z.strictObject({ folder, kitId: z.string().min(1).max(100), title }),
    response: vaultViewSchema,
  },
  'bible:open': {
    request: z.strictObject({ path: folder }),
    response: vaultViewSchema,
  },
  'bible:view': {
    request: z.strictObject({ vaultId: id }),
    response: vaultViewSchema,
  },
  /** Opens one entry; also remembers it as the vault's last entry. */
  'bible:entry': {
    request: z.strictObject({ vaultId: id, path: entryPath }),
    response: entryViewSchema,
  },
  /**
   * body null starts from the section's starter-kit template; intro then goes
   * under its first heading (the first pillar's full answer).
   */
  'bible:createEntry': {
    request: z.strictObject({
      vaultId: id,
      section: sectionId,
      title,
      body: body.nullable(),
      intro: z.string().max(10_000).nullable().optional(),
      /** Set when created from a missing [[link]]: the section the link is in, so the choice is remembered. */
      linkFrom: sectionId.nullable().optional(),
    }),
    response: z.strictObject({ entry: entryViewSchema, vault: vaultViewSchema }),
  },
  /** Saves a body; refused with the file's current version when it changed on disk, unless forced. */
  'bible:saveEntry': {
    request: z.strictObject({
      vaultId: id,
      path: entryPath,
      body,
      baseVersion: z.string().max(100),
      force: z.boolean(),
    }),
    response: saveResultSchema,
  },
  /** Sets property values (key "tags" for tags); refused like a save when the file changed on disk. */
  'bible:setProperties': {
    request: z.strictObject({
      vaultId: id,
      path: entryPath,
      changes: z
        .array(z.strictObject({ key: z.string().min(1).max(40), value: fieldValue }))
        .min(1)
        .max(100),
      baseVersion: z.string().max(100),
    }),
    response: saveResultSchema,
  },
  /** Tag suggestions: tags used in the vault and in the Library. */
  'bible:tagOptions': {
    request: z.strictObject({ vaultId: id }),
    response: z.strictObject({ tags: z.array(z.string()) }),
  },
  /** Copies an entry as "<title> copy" with a new id. */
  'bible:duplicateEntry': {
    request: z.strictObject({ vaultId: id, path: entryPath }),
    response: z.strictObject({ entry: entryViewSchema, vault: vaultViewSchema }),
  },
  /** Moves an entry's file to another section. */
  'bible:moveEntry': {
    request: z.strictObject({ vaultId: id, path: entryPath, section: sectionId }),
    response: z.strictObject({
      path: z.string(),
      vault: vaultViewSchema,
      /** The body is still the old section's untouched template: offer the new one. */
      templateSwap: z.boolean(),
    }),
  },
  /** Replaces a still-untouched template with the entry's own section template. */
  'bible:swapTemplate': {
    request: z.strictObject({
      vaultId: id,
      path: entryPath,
      fromSection: sectionId,
      baseVersion: z.string().max(100),
    }),
    response: saveResultSchema,
  },
  /** Every decision, newest first. */
  'bible:timeline': {
    request: z.strictObject({ vaultId: id }),
    response: z.strictObject({ items: z.array(timelineItemSchema) }),
  },
  /** Every idea, for the board. */
  'bible:ideas': {
    request: z.strictObject({ vaultId: id }),
    response: z.strictObject({ cards: z.array(ideaCardSchema) }),
  },
  /** Decisions and ideas that name no pillar. */
  'bible:review': {
    request: z.strictObject({ vaultId: id }),
    response: z.strictObject({
      items: z.array(entrySummarySchema.extend({ section: z.string() })),
    }),
  },
  /** Promotes an idea into a decision or another section's entry, linked both ways. */
  'bible:promote': {
    request: z.strictObject({ vaultId: id, path: entryPath, section: sectionId, title }),
    response: z.strictObject({
      entry: entryViewSchema,
      vault: vaultViewSchema,
      undo: z.string(),
    }),
  },
  'bible:undoPromote': {
    request: z.strictObject({ vaultId: id, undo: z.string().min(1).max(100) }),
    response: vaultViewSchema,
  },
  /** Copies Library images into the vault and lists them in the entry's references. */
  'bible:addReferences': {
    request: z.strictObject({
      vaultId: id,
      path: entryPath,
      referenceIds: z.array(id).min(1).max(100),
      baseVersion: z.string().max(100),
    }),
    response: z.strictObject({
      result: saveResultSchema,
      images: z.array(z.strictObject({ alt: z.string(), link: z.string() })),
    }),
  },
  'bible:setSettings': {
    request: z.strictObject({ vaultId: id, copyOriginals: z.boolean() }),
    response: vaultViewSchema,
  },
  /** Adds the chosen sections and fields from the vault's starter kit to bible.json. */
  'bible:applyKitUpdate': {
    request: z.strictObject({
      vaultId: id,
      sections: z.array(sectionId).max(100),
      fields: z
        .array(z.strictObject({ section: sectionId, key: z.string().min(1).max(40) }))
        .max(500),
    }),
    response: vaultViewSchema,
  },
  'bible:dismissKitUpdate': {
    request: z.strictObject({ vaultId: id }),
    response: vaultViewSchema,
  },
  /** A section's entries in their new order after "moved" was dragged. */
  'bible:reorderEntries': {
    request: z.strictObject({
      vaultId: id,
      section: sectionId,
      paths: z.array(entryPath).min(1).max(10_000),
      moved: entryPath,
    }),
    response: vaultViewSchema,
  },
  /** Everything in the vault's .trash folder, newest first. */
  'bible:trash': {
    request: z.strictObject({ vaultId: id }),
    response: z.strictObject({ items: z.array(trashItemSchema) }),
  },
  /** Puts a trashed entry or section back where it came from. */
  'bible:restoreTrash': {
    request: z.strictObject({ vaultId: id, trashPath }),
    response: z.strictObject({ path: z.string().nullable(), vault: vaultViewSchema }),
  },
  /** Deletes a trashed entry or section for good. */
  'bible:purgeTrash': {
    request: z.strictObject({ vaultId: id, trashPath }),
    response: z.strictObject({ items: z.array(trashItemSchema) }),
  },
  /** The Pillars section as cards, in order. */
  'bible:pillars': {
    request: z.strictObject({ vaultId: id }),
    response: z.strictObject({ cards: z.array(pillarCardSchema) }),
  },
  /** A section's fields: labels, order, new ones (key null) and removals. */
  'bible:setSectionFields': {
    request: z.strictObject({
      vaultId: id,
      sectionId,
      fields: z
        .array(
          z.strictObject({
            key: z.string().min(1).max(40).nullable(),
            label: z.string().min(1).max(100),
            type: fieldType,
            options: z.array(z.string().max(100)).max(100).optional(),
            section: z.string().max(100).optional(),
          }),
        )
        .max(50),
    }),
    response: vaultViewSchema,
  },
  /** Renames an entry and rewrites every [[link]] to it. */
  'bible:renameEntry': {
    request: z.strictObject({ vaultId: id, path: entryPath, title }),
    response: z.strictObject({
      entry: entryViewSchema,
      vault: vaultViewSchema,
      rewritten: z.number().int().nonnegative(),
    }),
  },
  /** Moves an entry into <vault>/.trash; trashPath is what Undo hands back. */
  'bible:deleteEntry': {
    request: z.strictObject({ vaultId: id, path: entryPath }),
    response: z.strictObject({ trashPath: z.string(), vault: vaultViewSchema }),
  },
  'bible:restoreEntry': {
    request: z.strictObject({ vaultId: id, trashPath, path: entryPath }),
    response: z.strictObject({ path: z.string(), vault: vaultViewSchema }),
  },
  'bible:search': {
    request: z.strictObject({ vaultId: id, text: z.string().max(500) }),
    response: z.strictObject({ hits: z.array(searchHitSchema), ms: z.number().nonnegative() }),
  },
  /** Names and order of all sections; id null adds a section. */
  'bible:setSections': {
    request: z.strictObject({
      vaultId: id,
      sections: z
        .array(z.strictObject({ id: sectionId.nullable(), name: z.string().min(1).max(100) }))
        .max(200),
    }),
    response: vaultViewSchema,
  },
  /** Moves a section's folder into .trash; the reply holds what Undo needs. */
  'bible:removeSection': {
    request: z.strictObject({ vaultId: id, sectionId }),
    response: z.strictObject({
      trashPath: z.string(),
      section: sectionSchema,
      position: z.number().int().nonnegative(),
      vault: vaultViewSchema,
    }),
  },
  'bible:restoreSection': {
    request: z.strictObject({
      vaultId: id,
      trashPath,
      section: z.strictObject({ id: sectionId, name: z.string().min(1).max(100) }),
      position: z.number().int().nonnegative(),
    }),
    response: vaultViewSchema,
  },
} as const

export type VaultViewData = z.infer<typeof vaultViewSchema>
export type EntryViewData = z.infer<typeof entryViewSchema>
export type SaveResultData = z.infer<typeof saveResultSchema>
export type FieldDefData = z.infer<typeof fieldDefSchema>
export type PropertyData = z.infer<typeof propertySchema>
export type FieldValueData = z.infer<typeof fieldValue>
export type TrashItemData = z.infer<typeof trashItemSchema>
export type TimelineItemData = z.infer<typeof timelineItemSchema>
export type IdeaCardData = z.infer<typeof ideaCardSchema>
export type PillarCardData = z.infer<typeof pillarCardSchema>
