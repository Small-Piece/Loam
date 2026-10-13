import { describeIssues, failure, type Result } from './envelope.ts'
import { isChannel, messages, type Channel, type RequestOf, type ResponseOf } from './messages.ts'

export type Handler<C extends Channel> = (
  request: RequestOf<C>,
) => Promise<ResponseOf<C>> | ResponseOf<C>

export type Handlers = { [C in Channel]: Handler<C> }

/** Reads one channel's handler; TypeScript cannot correlate handlers[channel] with its request type. */
function handlerFor<C extends Channel>(handlers: Handlers, channel: C): Handler<C> {
  return handlers[channel] as Handler<C>
}

/**
 * Backend side of the boundary. Validates the channel and the payload,
 * runs the handler, and validates its response before it leaves.
 */
export async function dispatch(
  handlers: Handlers,
  channel: unknown,
  payload: unknown,
): Promise<Result<unknown>> {
  if (!isChannel(channel)) {
    return failure('UNKNOWN_CHANNEL', `Unknown channel: ${String(channel)}`)
  }
  const schema = messages[channel]
  const request = schema.request.safeParse(payload)
  if (!request.success) {
    return failure(
      'INVALID_REQUEST',
      `Invalid request for ${channel}`,
      describeIssues(request.error),
    )
  }
  let raw: unknown
  try {
    raw = await handlerFor(handlers, channel)(request.data)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return failure('HANDLER_FAILED', `Handler for ${channel} failed: ${message}`)
  }
  const response = schema.response.safeParse(raw)
  if (!response.success) {
    return failure(
      'INVALID_RESPONSE',
      `Invalid response for ${channel}`,
      describeIssues(response.error),
    )
  }
  return { ok: true, data: response.data }
}
