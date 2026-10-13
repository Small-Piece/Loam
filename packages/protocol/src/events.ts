import { z } from 'zod'
import { aiStatusSchema } from './ai.ts'

/**
 * Events the backend pushes to the UI, one way. Like messages, each payload
 * is a zod schema, checked before it is sent and again when it arrives.
 */
export const events = {
  /** Files in the open vault changed on disk (outside edits or the app's own saves); the index is up to date. */
  'bible:changed': z.strictObject({
    vaultId: z.number().int().positive(),
    paths: z.array(z.string().max(1000)).max(10_000),
  }),
  /** The local AI helpers changed: switch, download progress, queue progress. */
  'ai:status': aiStatusSchema,
} as const

export type EventName = keyof typeof events
export type EventOf<E extends EventName> = z.infer<(typeof events)[E]>

export function isEventName(value: unknown): value is EventName {
  return typeof value === 'string' && Object.hasOwn(events, value)
}

/** Validates an event before the backend sends it; returns null when it does not match. */
export function checkEvent<E extends EventName>(name: E, payload: unknown): EventOf<E> | null {
  const parsed = events[name].safeParse(payload)
  return parsed.success ? (parsed.data as EventOf<E>) : null
}
