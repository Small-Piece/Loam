import { describe, expect, it } from 'vitest'
import { envSetting } from './env.ts'

describe('envSetting', () => {
  it('reads LOAM_ variables', () => {
    expect(envSetting('WINDOW_DISPLAY', { LOAM_WINDOW_DISPLAY: 'secondary' })).toBe('secondary')
  })

  it('still accepts the old UM_ names', () => {
    expect(envSetting('WINDOW_DISPLAY', { UM_WINDOW_DISPLAY: '1' })).toBe('1')
    expect(envSetting('MODELS_DIR', { UM_MODELS_DIR: 'D:\\models' })).toBe('D:\\models')
  })

  it('prefers the LOAM_ name, even when it is empty', () => {
    expect(envSetting('DEV_SERVER_URL', { LOAM_DEV_SERVER_URL: '', UM_DEV_SERVER_URL: 'x' })).toBe(
      '',
    )
    expect(envSetting('WINDOW_DISPLAY', { LOAM_WINDOW_DISPLAY: '2', UM_WINDOW_DISPLAY: '1' })).toBe(
      '2',
    )
  })

  it('is undefined when neither is set', () => {
    expect(envSetting('AI_FAKE_PROVIDER', {})).toBeUndefined()
  })
})
