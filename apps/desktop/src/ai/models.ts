import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { totalBytes, type ModelFile, type ModelSpec } from '@loam/agent'
import { bytesOnDisk, ChecksumError, DownloadCancelledError, downloadFile } from './download.ts'

const run = promisify(execFile)
const RUNTIME_DIR = 'runtime'
const SERVER_EXE = 'llama-server.exe'

/**
 * Windows' own tar (bsdtar, which reads zip files). Named in full: a GNU tar
 * earlier on the PATH (Git for Windows ships one) reads C: as a remote host.
 */
function windowsTar(): string {
  return join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe')
}

export type DownloadState = 'idle' | 'downloading' | 'verifying' | 'cancelled' | 'error' | 'done'

export interface DownloadStatus {
  state: DownloadState
  /** Bytes on disk across all files, finished or partial. */
  received: number
  total: number
  error: string | null
}

/**
 * The local model's files in %LOCALAPPDATA%\Loam\models: the
 * llama.cpp runtime (unpacked from its verified zip) and the model weights.
 * Downloading is the only thing here that touches the network, and only when
 * the user asks.
 */
export class ModelManager {
  private readonly dir: string
  private readonly spec: ModelSpec
  private readonly log: (line: string) => void
  private controller: AbortController | null = null
  private status: DownloadStatus

  constructor(deps: { dir: string; spec: ModelSpec; log: (line: string) => void }) {
    this.dir = deps.dir
    this.spec = deps.spec
    this.log = deps.log
    this.status = { state: 'idle', received: 0, total: totalBytes(deps.spec), error: null }
  }

  get model(): ModelSpec {
    return this.spec
  }

  private fileOf(kind: ModelFile['kind']): ModelFile {
    const file = this.spec.files.find((candidate) => candidate.kind === kind)
    if (!file) throw new Error(`The model catalog has no ${kind}`)
    return file
  }

  paths(): { server: string; model: string; projector: string } {
    return {
      server: join(this.dir, RUNTIME_DIR, SERVER_EXE),
      model: join(this.dir, this.fileOf('model').name),
      projector: join(this.dir, this.fileOf('projector').name),
    }
  }

  /** True when the runtime is unpacked and both model files are complete. */
  installed(): boolean {
    const { server, model, projector } = this.paths()
    const complete = (path: string, size: number) =>
      existsSync(path) && statSync(path).size === size
    return (
      existsSync(server) &&
      complete(model, this.fileOf('model').size) &&
      complete(projector, this.fileOf('projector').size)
    )
  }

  /** Bytes on disk so far (a resumed download starts from here). */
  private received(): number {
    if (this.installed()) return totalBytes(this.spec)
    return this.spec.files.reduce((sum, file) => {
      if (file.kind === 'runtime' && existsSync(this.paths().server)) return sum + file.size
      return sum + Math.min(file.size, bytesOnDisk(join(this.dir, file.name)))
    }, 0)
  }

  downloadStatus(): DownloadStatus {
    const state = this.installed() ? 'done' : this.status.state
    return { ...this.status, state, received: this.received() }
  }

  /**
   * Downloads what is missing, one file after another, each checked against
   * its pinned SHA-256; then unpacks the runtime. Resolves with the final
   * status (cancelled and failed downloads resolve too).
   */
  async download(onChange: (status: DownloadStatus) => void): Promise<DownloadStatus> {
    if (this.controller) return this.downloadStatus()
    mkdirSync(this.dir, { recursive: true })
    const controller = new AbortController()
    this.controller = controller
    this.status = { ...this.status, state: 'downloading', error: null }
    onChange(this.downloadStatus())
    this.log('[ai] model download started')
    let last = 0
    try {
      for (const file of this.spec.files) {
        const dest = join(this.dir, file.name)
        if (file.kind === 'runtime' && existsSync(this.paths().server)) continue
        if (file.kind !== 'runtime' && existsSync(dest) && statSync(dest).size === file.size) {
          continue
        }
        await downloadFile({
          url: file.url,
          dest,
          size: file.size,
          sha256: file.sha256,
          signal: controller.signal,
          onProgress: () => {
            // A few updates a second are plenty for a progress bar.
            const now = Date.now()
            if (now - last > 250) {
              last = now
              onChange(this.downloadStatus())
            }
          },
        })
        if (file.kind === 'runtime') await this.unpackRuntime(dest)
      }
      this.status = { ...this.status, state: 'done', error: null }
      this.log('[ai] model download finished')
    } catch (error) {
      if (error instanceof DownloadCancelledError) {
        this.status = { ...this.status, state: 'cancelled', error: null }
        this.log('[ai] model download cancelled')
      } else {
        const message =
          error instanceof ChecksumError
            ? 'A downloaded file did not match its checksum and was deleted. Try again.'
            : 'The download failed. Check the connection and try again.'
        this.status = { ...this.status, state: 'error', error: message }
        this.log(`[ai] model download failed: ${error instanceof Error ? error.name : 'error'}`)
      }
    } finally {
      this.controller = null
    }
    const final = this.downloadStatus()
    onChange(final)
    return final
  }

  /** Unpacks the runtime zip with Windows' own tar, then deletes the zip. */
  private async unpackRuntime(zip: string): Promise<void> {
    const target = join(this.dir, RUNTIME_DIR)
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
    await run(windowsTar(), ['-xf', zip, '-C', target], { windowsHide: true })
    if (!existsSync(join(target, SERVER_EXE))) {
      rmSync(target, { recursive: true, force: true })
      throw new Error('The runtime package has no llama-server.exe')
    }
    unlinkSync(zip)
  }

  cancel(): void {
    this.controller?.abort()
  }

  /** Deletes the model and runtime (and any partial download) to free the disk. */
  remove(): void {
    this.cancel()
    if (!existsSync(this.dir)) return
    for (const name of readdirSync(this.dir)) {
      rmSync(join(this.dir, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
    this.status = { state: 'idle', received: 0, total: totalBytes(this.spec), error: null }
    this.log('[ai] model deleted')
  }
}

/** Names of running executables, from Windows' tasklist. */
export async function runningApps(): Promise<string[]> {
  const { stdout } = await run('tasklist', ['/FO', 'CSV', '/NH'], {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  })
  const names: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const name = /^"([^"]+)"/.exec(line)?.[1]
    if (name) names.push(name)
  }
  return names
}
