import { z } from 'zod'
import { entryViewSchema, saveResultSchema, vaultViewSchema } from './bible.ts'
import { imageUploadSchema } from './references.ts'

const id = z.number().int().positive()
const entryPath = z.string().min(4).max(400)
const folder = z.string().min(1).max(1000)
const entrySummarySchema = z.strictObject({ path: z.string(), title: z.string() })

const sessionSummarySchema = z.strictObject({
  path: z.string(),
  title: z.string(),
  date: z.string().nullable(),
})

const todayViewSchema = z.strictObject({
  today: z.string(),
  sessions: z.array(sessionSummarySchema),
  previous: sessionSummarySchema.extend({ nextTime: z.string().nullable() }).nullable(),
})

const resourceItemSchema = z.strictObject({
  path: z.string(),
  title: z.string(),
  status: z.string().nullable(),
  url: z.string().nullable(),
  rating: z.string().nullable(),
  topics: z.array(entrySummarySchema),
})

const topicProgressSchema = z.strictObject({
  images: z.array(z.strictObject({ asset: z.string(), session: sessionSummarySchema })),
  sessions: z.array(sessionSummarySchema.extend({ minutes: z.number().nullable() })),
  resources: z.array(resourceItemSchema),
  minutes: z.number().nullable(),
})

/**
 * Study journal messages. The journal is a vault made from the Journal kit:
 * every bible:* message works on it too (by its vaultId); these add what only
 * the journal has.
 */
export const journalMessages = {
  /** The journal (reopened when there is one), why it could not be reopened, and where a new one could go. */
  'journal:home': {
    request: z.strictObject({}),
    response: z.strictObject({
      current: vaultViewSchema.nullable(),
      problem: z.string().nullable(),
      /** The suggested folder for a new journal: Documents/Loam Journal. */
      suggestedFolder: z.string(),
    }),
  },
  /** Creates the journal in this folder (empty or new) from the Journal kit and opens it. */
  'journal:create': {
    request: z.strictObject({ folder }),
    response: vaultViewSchema,
  },
  'journal:open': {
    request: z.strictObject({ path: folder }),
    response: vaultViewSchema,
  },
  /** Today's sessions and the previous session's "Next time". */
  'journal:today': {
    request: z.strictObject({ vaultId: id }),
    response: todayViewSchema,
  },
  /** A session for today, titled with the date, from the Session template. */
  'journal:newSession': {
    request: z.strictObject({ vaultId: id }),
    response: z.strictObject({ entry: entryViewSchema, vault: vaultViewSchema }),
  },
  /** The days of a year that have sessions. */
  'journal:calendar': {
    request: z.strictObject({ vaultId: id, year: z.number().int().min(1900).max(9999) }),
    response: z.strictObject({
      days: z.array(z.strictObject({ date: z.string(), sessions: z.array(entrySummarySchema) })),
    }),
  },
  /** A topic's practice images over time, its sessions and its resources. */
  'journal:topic': {
    request: z.strictObject({ vaultId: id, path: entryPath }),
    response: topicProgressSchema,
  },
  'journal:resources': {
    request: z.strictObject({ vaultId: id }),
    response: z.strictObject({ items: z.array(resourceItemSchema) }),
  },
  /**
   * Images dropped or pasted on an entry: stored in the journal's _assets and
   * listed in the entry. With alsoLibrary they are imported into the Library
   * too, tagged practice and with the entry's topic names.
   */
  'journal:addImages': {
    request: z.strictObject({
      vaultId: id,
      path: entryPath,
      items: z.array(imageUploadSchema).min(1).max(50),
      alsoLibrary: z.boolean(),
      baseVersion: z.string().max(100),
    }),
    response: z.strictObject({
      result: saveResultSchema,
      images: z.array(z.strictObject({ alt: z.string(), link: z.string() })),
      /** Library outcome when alsoLibrary was set: how many images are there now, and the tags given. */
      library: z
        .strictObject({ ids: z.array(id), tags: z.array(z.string()), rejected: z.number() })
        .nullable(),
    }),
  },
} as const

export type TodayViewData = z.infer<typeof todayViewSchema>
export type TopicProgressData = z.infer<typeof topicProgressSchema>
export type ResourceItemData = z.infer<typeof resourceItemSchema>
