import { describeIssues, envelopeSchema, failure, type Result } from './envelope.ts'
import { messages, type Channel, type RequestOf, type ResponseOf } from './messages.ts'
import type { BridgeApi } from './bridge.ts'
import { events, type EventName, type EventOf } from './events.ts'

export interface ProtocolClient {
  invoke<C extends Channel>(channel: C, request: RequestOf<C>): Promise<Result<ResponseOf<C>>>
  /** Calls the handler for each valid event of this name; returns a function that stops it. */
  on<E extends EventName>(name: E, handler: (payload: EventOf<E>) => void): () => void
}

/**
 * UI side of the boundary. Validates the request before sending and the
 * reply after receiving, so both sides check every message.
 */
export function createClient(bridge: BridgeApi): ProtocolClient {
  return {
    on(name, handler) {
      return bridge.subscribe((eventName, payload) => {
        if (eventName !== name) return
        const parsed = events[name].safeParse(payload)
        // An event that does not match its schema is dropped, like an invalid reply.
        if (parsed.success) handler(parsed.data as EventOf<typeof name>)
      })
    },
    async invoke(channel, request) {
      const schema = messages[channel]
      const parsedRequest = schema.request.safeParse(request)
      if (!parsedRequest.success) {
        return failure(
          'INVALID_REQUEST',
          `Invalid request for ${channel}`,
          describeIssues(parsedRequest.error),
        )
      }
      const envelope = envelopeSchema.safeParse(await bridge.invoke(channel, parsedRequest.data))
      if (!envelope.success) {
        return failure(
          'INVALID_RESPONSE',
          `Malformed reply for ${channel}`,
          describeIssues(envelope.error),
        )
      }
      if (!envelope.data.ok) {
        return { ok: false, error: envelope.data.error }
      }
      const parsedResponse = schema.response.safeParse(envelope.data.data)
      if (!parsedResponse.success) {
        return failure(
          'INVALID_RESPONSE',
          `Invalid response for ${channel}`,
          describeIssues(parsedResponse.error),
        )
      }
      // The schema for channel C produced this value, so it is ResponseOf<C>.
      return { ok: true, data: parsedResponse.data as ResponseOf<typeof channel> }
    },
  }
}
