import { z } from 'zod'
import { entryViewSchema, vaultViewSchema } from './bible.ts'
import { referenceDetailSchema } from './references.ts'

const id = z.number().int().positive()

const suggestionSchema = z.strictObject({ tag: z.string(), confidence: z.number() })

export const aiStatusSchema = z.strictObject({
  /** The master switch, off by default. */
  enabled: z.boolean(),
  model: z.strictObject({
    name: z.string(),
    license: z.string(),
    runtimeLicense: z.string(),
    totalBytes: z.number().int().nonnegative(),
    installed: z.boolean(),
    /** Exactly what Download fetches, shown before it starts. */
    files: z.array(z.strictObject({ name: z.string(), url: z.string(), size: z.number() })),
    download: z.strictObject({
      state: z.enum(['idle', 'downloading', 'verifying', 'cancelled', 'error', 'done']),
      received: z.number().nonnegative(),
      total: z.number().nonnegative(),
      error: z.string().nullable(),
    }),
  }),
  /** Apps that pause AI while they run, as the user wrote them. */
  pauseApps: z.array(z.string()),
  /** The manual pause. */
  paused: z.boolean(),
  queue: z.strictObject({
    state: z.enum(['off', 'running', 'idle', 'paused', 'blocked', 'error']),
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    blockedBy: z.string().nullable(),
    error: z.string().nullable(),
  }),
})

const appName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^\\/:*?"<>|]+$/, 'A program file name such as UnrealEditor.exe')

/** Local AI helpers: settings, the model download, tag suggestions and journal recaps. */
export const aiMessages = {
  'ai:status': {
    request: z.strictObject({}),
    response: aiStatusSchema,
  },
  'ai:setEnabled': {
    request: z.strictObject({ enabled: z.boolean() }),
    response: aiStatusSchema,
  },
  'ai:setPauseApps': {
    request: z.strictObject({ apps: z.array(appName).max(50) }),
    response: aiStatusSchema,
  },
  'ai:setPaused': {
    request: z.strictObject({ paused: z.boolean() }),
    response: aiStatusSchema,
  },
  /** Starts (or resumes) the model download. The UI has shown the URLs first. */
  'ai:download': {
    request: z.strictObject({}),
    response: aiStatusSchema,
  },
  'ai:cancelDownload': {
    request: z.strictObject({}),
    response: aiStatusSchema,
  },
  /** Deletes the model and runtime files. */
  'ai:deleteModel': {
    request: z.strictObject({}),
    response: aiStatusSchema,
  },
  /** Makes suggested tags real tags. */
  'refs:acceptSuggestions': {
    request: z.strictObject({ id, tags: z.array(z.string().max(100)).min(1).max(50) }),
    response: z.strictObject({
      detail: referenceDetailSchema.nullable(),
      suggestions: z.array(suggestionSchema),
    }),
  },
  /** Rejects a suggestion; it is not suggested again for that image. */
  'refs:rejectSuggestion': {
    request: z.strictObject({ id, tag: z.string().max(100) }),
    response: z.strictObject({ suggestions: z.array(suggestionSchema) }),
  },
  /** A recap draft from the user's own session text; nothing is written. */
  'journal:recap': {
    request: z.strictObject({
      vaultId: id,
      scope: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('week') }),
        z.strictObject({ kind: z.literal('topic'), path: z.string().min(4).max(400) }),
      ]),
    }),
    response: z.strictObject({
      draft: z.string(),
      title: z.string(),
      sources: z.array(
        z.strictObject({
          id: z.string(),
          path: z.string(),
          title: z.string(),
          date: z.string().nullable(),
        }),
      ),
    }),
  },
  /** Saves a recap draft as a new Session: ai_generated, with its source sessions. */
  'journal:saveRecap': {
    request: z.strictObject({
      vaultId: id,
      title: z.string().min(1).max(200),
      text: z.string().min(1).max(100_000),
      sourceIds: z.array(z.string().max(100)).max(500),
    }),
    response: z.strictObject({ entry: entryViewSchema, vault: vaultViewSchema }),
  },
} as const

export type AiStatusData = z.infer<typeof aiStatusSchema>
export type TagSuggestionData = z.infer<typeof suggestionSchema>
