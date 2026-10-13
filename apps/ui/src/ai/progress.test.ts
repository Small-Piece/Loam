import { describe, expect, it } from 'vitest'
import { formatBytes, progressText } from './progress.ts'

const queue = (state: Parameters<typeof progressText>[0]['state'], extra = {}) => ({
  state,
  done: 120,
  total: 400,
  blockedBy: null,
  error: null,
  ...extra,
})

describe('AI progress line', () => {
  it('says what the queue does, and nothing while AI is off', () => {
    expect(progressText(queue('off'))).toBeNull()
    expect(progressText(queue('running'))).toBe('Suggesting tags: 120 of 400')
    expect(progressText(queue('blocked', { blockedBy: 'UnrealEditor.exe' }))).toBe(
      'Suggesting tags: 120 of 400, paused while UnrealEditor.exe runs',
    )
    expect(progressText(queue('paused'))).toBe('Suggesting tags: 120 of 400, paused')
    expect(progressText(queue('idle'))).toBe('Tag suggestions: all 400 images looked at')
    expect(progressText(queue('error', { error: 'boom' }))).toBe('Tag suggestions stopped: boom')
  })

  it('formats sizes', () => {
    expect(formatBytes(2_983_368_041)).toBe('2.78 GB')
    expect(formatBytes(32_112_073)).toBe('31 MB')
  })
})
