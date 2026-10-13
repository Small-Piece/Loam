import {
  createClient,
  type Channel,
  type ProtocolClient,
  type RequestOf,
  type ResponseOf,
} from '@loam/protocol'

const client = createClient(window.loam)

export class ApiError extends Error {
  override name = 'ApiError'
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** Sends one protocol message and returns its data, or throws ApiError with the typed code. */
export async function call<C extends Channel>(
  channel: C,
  request: RequestOf<C>,
): Promise<ResponseOf<C>> {
  const result = await client.invoke(channel, request)
  if (!result.ok) throw new ApiError(result.error.code, result.error.message)
  return result.data
}

/** Listens for one kind of event the backend pushes; returns a function that stops listening. */
export const onEvent: ProtocolClient['on'] = (name, handler) => client.on(name, handler)
