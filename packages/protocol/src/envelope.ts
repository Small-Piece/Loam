import { z } from 'zod'

export const protocolErrorCodes = [
  'UNKNOWN_CHANNEL',
  'INVALID_REQUEST',
  'INVALID_RESPONSE',
  'HANDLER_FAILED',
] as const

export const protocolErrorSchema = z.strictObject({
  code: z.enum(protocolErrorCodes),
  message: z.string(),
  issues: z.array(z.string()).optional(),
})

export type ProtocolError = z.infer<typeof protocolErrorSchema>
export type ProtocolErrorCode = ProtocolError['code']

/** Every reply crossing the boundary is one of these two shapes. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: ProtocolError }

export const envelopeSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), data: z.unknown() }),
  z.strictObject({ ok: z.literal(false), error: protocolErrorSchema }),
])

export function failure(
  code: ProtocolErrorCode,
  message: string,
  issues?: readonly string[],
): Result<never> {
  const error: ProtocolError = issues ? { code, message, issues: [...issues] } : { code, message }
  return { ok: false, error }
}

export function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    return `${path}: ${issue.message}`
  })
}
