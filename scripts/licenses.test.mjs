import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  disallowed,
  isPermissive,
  licenseText,
  packagesFromPnpm,
  renderNotices,
} from './licenses.mjs'

let dir = null

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

describe('isPermissive', () => {
  it('accepts the listed permissive licenses', () => {
    for (const id of ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD']) {
      expect(isPermissive(id)).toBe(true)
    }
    expect(isPermissive('Python-2.0')).toBe(true)
  })

  it('refuses copyleft, unknown and missing licenses', () => {
    expect(isPermissive('GPL-3.0-only')).toBe(false)
    expect(isPermissive('LGPL-2.1')).toBe(false)
    expect(isPermissive('UNLICENSED')).toBe(false)
    expect(isPermissive('')).toBe(false)
    expect(isPermissive(undefined)).toBe(false)
  })

  it('reads SPDX OR and AND expressions', () => {
    expect(isPermissive('(MIT OR GPL-3.0-only)')).toBe(true)
    expect(isPermissive('(MIT AND GPL-3.0-only)')).toBe(false)
    expect(isPermissive('(MIT AND Apache-2.0)')).toBe(true)
  })
})

const report = {
  MIT: [
    {
      name: 'zod',
      versions: ['4.6.5'],
      paths: ['/x/zod'],
      license: 'MIT',
    },
    { name: '@loam/core', versions: ['0.1.0'], paths: ['/x/core'], license: 'MIT' },
  ],
  'GPL-3.0-only': [
    {
      name: 'gpl-fixture',
      versions: ['1.0.0', '2.0.0'],
      paths: ['/x/gpl1', '/x/gpl2'],
      license: 'GPL-3.0-only',
    },
  ],
}

describe('the release gate', () => {
  it('lists every package version and leaves out the workspace packages', () => {
    expect(packagesFromPnpm(report).map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual([
      'gpl-fixture@1.0.0',
      'gpl-fixture@2.0.0',
      'zod@4.6.5',
    ])
  })

  it('fails on a deliberately added non-permissive dependency', () => {
    const refused = disallowed(packagesFromPnpm(report))
    expect(refused.map((pkg) => pkg.name)).toEqual(['gpl-fixture', 'gpl-fixture'])
    expect(disallowed(packagesFromPnpm({ MIT: report.MIT }))).toEqual([])
  })
})

describe('the notices file', () => {
  it('reads a package license file, whatever its spelling', () => {
    dir = mkdtempSync(join(tmpdir(), 'loam-licenses-'))
    mkdirSync(join(dir, 'pkg'))
    writeFileSync(join(dir, 'pkg', 'LICENSE.md'), 'The MIT License\r\n\r\nCopyright (c) x\r\n')
    expect(licenseText(join(dir, 'pkg'))).toBe('The MIT License\n\nCopyright (c) x')
    mkdirSync(join(dir, 'bare'))
    expect(licenseText(join(dir, 'bare'))).toBeNull()
  })

  it('lists bundled packages with their texts and the downloads apart, without local paths', () => {
    const text = renderNotices(
      [
        { name: 'zod', version: '4.6.5', license: 'MIT', path: 'C:\\x\\zod', text: 'MIT text' },
        { name: 'bare', version: '1.0.0', license: 'ISC', path: null, text: null },
      ],
      [{ name: 'Model', version: 'v1', license: 'Apache-2.0', source: 'https://example.org' }],
    )
    expect(text).toContain('| zod | 4.6.5 | MIT |')
    expect(text).toContain('MIT text')
    expect(text).toContain('its declared license is ISC')
    expect(text).toContain('## Downloaded only at your request (not included)')
    expect(text).toContain('| Model | v1 | Apache-2.0 | https://example.org |')
    expect(text).not.toContain('C:\\x')
  })
})
