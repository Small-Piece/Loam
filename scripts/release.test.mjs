import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { changelogEntry, checksumLine, expectedTag } from './release.mjs'

const changelog = `# Changelog

Intro.

## 0.2.0 — later

- Newer thing.

## 0.1.0 — first public release

Loam is a desktop app.

### Privacy

- No telemetry.
`

describe('release files', () => {
  it('takes one version entry from the changelog, without its heading', () => {
    expect(changelogEntry(changelog, '0.2.0')).toBe('- Newer thing.')
    expect(changelogEntry(changelog, '0.1.0')).toBe(
      'Loam is a desktop app.\n\n### Privacy\n\n- No telemetry.',
    )
    expect(changelogEntry(changelog, '0.1')).toBeNull()
    expect(changelogEntry(changelog, '9.9.9')).toBeNull()
  })

  it('has a 0.1.0 entry in the real CHANGELOG.md', () => {
    const real = readFileSync(fileURLToPath(new URL('../CHANGELOG.md', import.meta.url)), 'utf8')
    expect(changelogEntry(real, '0.1.0')).toContain('### Privacy')
  })

  it('expects tags of the form v<version> and writes sha256sum lines', () => {
    expect(expectedTag('0.1.0')).toBe('v0.1.0')
    expect(checksumLine('ab'.repeat(32), 'Loam Setup 0.1.0.exe')).toBe(
      `${'ab'.repeat(32)} *Loam Setup 0.1.0.exe\n`,
    )
  })
})
