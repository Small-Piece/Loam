import { z } from 'zod'
import { aiMessages } from './ai.ts'
import { bibleMessages } from './bible.ts'
import { journalMessages } from './journal.ts'
import { referenceMessages } from './references.ts'

/**
 * The request/response map: every message the UI can send to the backend.
 * Each entry is one round trip per user action (view-model sized).
 */
export const messages = {
  'app:ping': {
    request: z.strictObject({
      message: z.string().min(1).max(200),
    }),
    response: z.strictObject({
      reply: z.string(),
      receivedAt: z.iso.datetime(),
    }),
  },
  /** The About dialog: version, license, links, data folder, and the copy from UnrealManager if there was one. */
  'app:about': {
    request: z.strictObject({}),
    response: z.strictObject({
      name: z.string(),
      version: z.string(),
      license: z.string(),
      repositoryUrl: z.url(),
      websiteUrl: z.url(),
      dataFolder: z.string(),
      migration: z
        .strictObject({
          from: z.string(),
          migratedAt: z.iso.datetime(),
          references: z.number().int().nonnegative(),
          oldFolderExists: z.boolean(),
        })
        .nullable(),
    }),
  },
  /** The third-party notices shipped with the app (THIRD_PARTY_NOTICES.md), shown from About. */
  'app:notices': {
    request: z.strictObject({}),
    response: z.strictObject({ text: z.string() }),
  },
  /** Opens an http(s) link in the system browser; the UI has asked first. */
  'app:openExternal': {
    request: z.strictObject({ url: z.string().min(1).max(4000) }),
    response: z.strictObject({ opened: z.boolean() }),
  },
  /** Where a Library reference is used in bibles the app knows. */
  'refs:bibleUses': {
    request: z.strictObject({ id: z.number().int().positive() }),
    response: z.strictObject({
      uses: z.array(
        z.strictObject({
          vaultTitle: z.string(),
          vaultPath: z.string(),
          path: z.string(),
          title: z.string(),
        }),
      ),
    }),
  },
  ...referenceMessages,
  ...bibleMessages,
  ...journalMessages,
  ...aiMessages,
} as const

export type Channel = keyof typeof messages
export type RequestOf<C extends Channel> = z.infer<(typeof messages)[C]['request']>
export type ResponseOf<C extends Channel> = z.infer<(typeof messages)[C]['response']>

export function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && Object.hasOwn(messages, value)
}
