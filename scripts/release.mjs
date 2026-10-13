// pnpm release:assets: after pnpm build, writes the release files for the version in
// apps/desktop/package.json: "Loam Setup <version>.exe.sha256" next to the installer and
// release-notes.md (that version's CHANGELOG entry). With a tag (GITHUB_REF_NAME or --tag),
// it first checks that the tag is v<version>. Used by .github/workflows/release.yml and for
// local dry runs.
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The CHANGELOG section for a version: everything under "## <version>" up to the next "## ". */
export function changelogEntry(changelog, version) {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((line) =>
    new RegExp(`^## ${version.replace(/\./g, '\\.')}(\\s|$)`).test(line),
  )
  if (start < 0) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('## '))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim()
}

/** The tag a release of this version must have. */
export function expectedTag(version) {
  return `v${version}`
}

/** One line in the format sha256sum writes and checks: "<hash> *<file name>". */
export function checksumLine(hash, fileName) {
  return `${hash} *${fileName}\n`
}

function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

async function main() {
  const repo = fileURLToPath(new URL('..', import.meta.url))
  const fail = (message) => {
    console.error(`release: ${message}`)
    process.exit(1)
  }
  const { version } = JSON.parse(readFileSync(join(repo, 'apps/desktop/package.json'), 'utf8'))
  const tagArg = process.argv.indexOf('--tag')
  const tag = tagArg > 0 ? process.argv[tagArg + 1] : process.env['GITHUB_REF_NAME']
  if (tag && tag !== expectedTag(version)) {
    fail(`tag ${tag} does not match the app version ${version} (expected ${expectedTag(version)}).`)
  }
  const installer = join(repo, 'apps/desktop/release', `Loam Setup ${version}.exe`)
  if (!existsSync(installer)) fail(`${installer} not found; run pnpm build first.`)
  const hash = await sha256(installer)
  writeFileSync(`${installer}.sha256`, checksumLine(hash, basename(installer)))
  const notes = changelogEntry(readFileSync(join(repo, 'CHANGELOG.md'), 'utf8'), version)
  if (!notes) fail(`CHANGELOG.md has no "## ${version}" entry.`)
  writeFileSync(join(repo, 'apps/desktop/release', 'release-notes.md'), `${notes}\n`)
  console.log(`${basename(installer)}\nSHA-256 ${hash}`)
  console.log(`Wrote ${basename(installer)}.sha256 and release-notes.md in apps/desktop/release.`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main()
