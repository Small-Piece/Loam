import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** main.log is rotated to main.log.1 before it would grow past this many bytes. */
export const LOG_SIZE_LIMIT = 1024 * 1024

export interface MainLog {
  readonly file: string
  info(message: string): void
  error(message: string, error: unknown): void
}

export interface MainLogOptions {
  /** Paths under these folders may appear in the log (the app's own folders). */
  allowedRoots: readonly string[]
  /** Paths under these folders never appear, even inside an allowed root (stored images). */
  blockedRoots: readonly string[]
  limit?: number
  now?: () => Date
  /** Also print each line to the console (dev runs, E2E output). */
  echo?: boolean
}

// A Windows path: a drive or UNC root, then everything up to a quote, a line
// break or the end. Quoted paths may hold spaces; unquoted ones end at a space.
const QUOTED_PATH = /(['"`])((?:[A-Za-z]:[\\/]|\\\\)[^'"`\r\n]*)\1/g
const BARE_PATH = /(?:[A-Za-z]:[\\/]|\\\\)[^\s'"`<>|]*/g

function normalize(path: string): string {
  return path.replaceAll('/', '\\').toLowerCase()
}

function isUnder(path: string, root: string): boolean {
  const base = normalize(root).replace(/\\+$/, '')
  const target = normalize(path)
  return target === base || target.startsWith(base + '\\')
}

/**
 * Replaces every absolute path that is not inside one of the app's own folders
 * with <path>, so a user's image paths never reach the log.
 */
export function redactPaths(
  text: string,
  allowedRoots: readonly string[],
  blockedRoots: readonly string[],
): string {
  const keep = (path: string) =>
    allowedRoots.some((root) => isUnder(path, root)) &&
    !blockedRoots.some((root) => isUnder(path, root))
  return text
    .replace(QUOTED_PATH, (match, quote: string, path: string) =>
      keep(path) ? match : `${quote}<path>${quote}`,
    )
    .replace(BARE_PATH, (path) => (path === '<path>' || keep(path) ? path : '<path>'))
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  return String(error)
}

/**
 * The main process log in <dir>/main.log, kept under the size limit with one
 * rotated file. Writing never throws: a full disk must not stop the app.
 */
export function createMainLog(dir: string, options: MainLogOptions): MainLog {
  const file = join(dir, 'main.log')
  const limit = options.limit ?? LOG_SIZE_LIMIT
  const now = options.now ?? (() => new Date())

  function sizeOf(path: string): number {
    try {
      return statSync(path).size
    } catch {
      return 0
    }
  }

  function write(level: 'info' | 'error', message: string): void {
    const text = redactPaths(message, options.allowedRoots, options.blockedRoots)
    const line = `${now().toISOString()} ${level.padEnd(5)} [pid ${process.pid}] ${text}\n`
    if (options.echo) {
      if (level === 'error') console.error(text)
      else console.log(text)
    }
    try {
      mkdirSync(dir, { recursive: true })
      if (sizeOf(file) + Buffer.byteLength(line) > limit) renameSync(file, `${file}.1`)
      appendFileSync(file, line)
    } catch {
      // Logging is best effort.
    }
  }

  return {
    file,
    info: (message) => write('info', message),
    error: (message, error) => write('error', `${message}: ${describeError(error)}`),
  }
}
