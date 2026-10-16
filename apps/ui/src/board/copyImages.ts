import { call } from '../api.ts'
import { copiedMessage } from './copyMessage.ts'

/** Copies references to the clipboard; resolves with the toast text. */
export async function copyImages(ids: readonly number[]): Promise<string> {
  const { ids: copied, sharedId } = await call('refs:copyImages', { ids: [...ids] })
  return copiedMessage(copied, sharedId)
}
