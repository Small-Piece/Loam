import { cpSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { VAULT_FOLDER, VaultError } from '@loam/core'

/** The sample bible shipped with the app, relative to its resources: "The Lantern Coast". */
export const SAMPLE_BIBLE = join('samples', 'lantern-coast')

/**
 * Copies the bundled sample bible into <folder>/bible, where a new bible would
 * go, and returns that path for opening. The bundled copy is only ever read.
 * A non-empty target is refused, so nothing of the user's is overwritten.
 */
export function copySampleBible(sampleDir: string, folder: string): string {
  if (!existsSync(join(sampleDir, 'bible.json'))) {
    throw new VaultError(`The sample bible is missing from ${sampleDir}.`)
  }
  const target = join(folder, VAULT_FOLDER)
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new VaultError(`${target} already exists and is not empty. Pick another folder.`)
  }
  cpSync(sampleDir, target, { recursive: true, errorOnExist: true, force: false })
  return target
}
