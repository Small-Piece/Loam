import { dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron'
import { readFileSync } from 'node:fs'
import { DEFAULT_MODEL, FakeAgentProvider, parseModelSpec } from '@loam/agent'
import { BibleService, ReferenceService, SuggestionService } from '@loam/core'
import {
  checkEvent,
  dispatch,
  EVENT_CHANNEL,
  INVOKE_CHANNEL,
  type EventName,
  type EventOf,
} from '@loam/protocol'
import {
  ChokidarVaultWatcher,
  FileBlobStore,
  FolderStarterKits,
  newEntryId,
  NodeVaultFiles,
  openDatabase,
  sha256Hasher,
  SqliteBibleIndex,
  SqliteReferenceRepository,
  SqliteSettings,
  SqliteSuggestionStore,
} from '@loam/storage'
import { AiController } from './ai/controller.ts'
import { ModelManager, runningApps } from './ai/models.ts'
import { registerAssetScheme, serveAssets } from './assets.ts'
import {
  DataMigrationError,
  describeMigration,
  migrateDataFolder,
  type MigrationOutcome,
} from './dataMigration.ts'
import { envSetting } from './env.ts'
import { createHandlers } from './handlers.ts'
import { createMainLog, type MainLog } from './mainLog.ts'
import { copySampleBible, SAMPLE_BIBLE } from './sample.ts'
import {
  browserDataDir,
  databasePath,
  dataDir,
  filesDir,
  logsDir,
  modelsDir,
  bundledFile,
  oldDataDir,
  starterKitsDir,
} from './paths.ts'
import { chooseDisplay, placeOn, type Placement } from './windowPlacement.ts'

// The dev server URL is honoured only in an unpackaged build, so an installed
// app can never be pointed at another origin through the environment.
const devServerUrl = app.isPackaged ? undefined : envSetting('DEV_SERVER_URL')

function migrationsDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'migrations')
    : join(app.getAppPath(), '..', '..', 'migrations')
}

/** Where the app's own code lives: the install folder, or the repository in dev. */
function codeRoot(): string {
  return app.isPackaged ? dirname(process.execPath) : join(app.getAppPath(), '..', '..')
}

const WINDOW_SIZE = { width: 1280, height: 820 }
const REPOSITORY_URL = 'https://github.com/Small-Piece/loam'
const WEBSITE_URL = 'https://small-piece.github.io/loam/'

let log: MainLog | null = null
let mainWindow: BrowserWindow | null = null
let showsInactive = false

/**
 * LOAM_WINDOW_DISPLAY ("secondary" or a display index; the old UM_WINDOW_DISPLAY
 * also works) puts the window on another monitor and shows it without focus, so
 * test runs stay off the main screen. Unset, or naming a display that does not
 * exist, keeps the normal behavior.
 */
function placementFromEnvironment(): Placement | null {
  const display = chooseDisplay(
    envSetting('WINDOW_DISPLAY'),
    screen.getAllDisplays(),
    screen.getPrimaryDisplay().id,
  )
  return display ? placeOn(display, WINDOW_SIZE) : null
}

function createWindow(): BrowserWindow {
  const placement = placementFromEnvironment()
  showsInactive = placement?.inactive ?? false
  const window = new BrowserWindow({
    ...(placement ? placement.bounds : WINDOW_SIZE),
    show: false,
    backgroundColor: '#1e1e1e',
    title: 'Loam',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  // A file dropped outside the drop zone must not navigate the window away.
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.once('ready-to-show', () => {
    if (placement?.inactive) window.showInactive()
    else window.show()
    log?.info(`[startup] window shown ${Math.round(process.uptime() * 1000)} ms after launch`)
  })
  if (devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, 'renderer', 'index.html'))
  }
  return window
}

/** Pushes a validated event to the window; an event that fails its schema is not sent. */
function sendEvent<E extends EventName>(name: E, payload: EventOf<E>): void {
  const checked = checkEvent(name, payload)
  const window = mainWindow
  if (checked === null || !window || window.isDestroyed()) return
  window.webContents.send(EVENT_CHANNEL, name, checked)
}

/** The system folder picker, over the main window. */
const PICKER_TEXT = {
  create: { title: 'Choose your game project folder', buttonLabel: 'Create bible here' },
  open: { title: 'Open a bible folder', buttonLabel: 'Open bible' },
  sample: { title: 'Choose where to put the sample bible', buttonLabel: 'Copy sample here' },
} as const

async function pickFolder(purpose: keyof typeof PICKER_TEXT): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    ...PICKER_TEXT[purpose],
    properties: ['openDirectory', 'createDirectory'],
  }
  const window = mainWindow
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

/** Opens a link in the system browser: http and https only, never files or other schemes. */
async function openExternal(url: string): Promise<boolean> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  await shell.openExternal(parsed.toString())
  return true
}

/** A second launch hands over to this window: restore it and bring it forward. */
function bringToFront(): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  // Test runs (LOAM_WINDOW_DISPLAY) keep the window out of the keyboard focus;
  // showInactive also restores a minimized window without activating it.
  if (showsInactive) {
    window.showInactive()
    return
  }
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

/**
 * The first start after the rename copies %LOCALAPPDATA%\UnrealManager to
 * %LOCALAPPDATA%\Loam (dataMigration.ts). It runs before anything creates the
 * Loam folder. If the copy fails, Loam says why and quits rather than start
 * with an empty library; the old folder is unchanged and the next start retries.
 */
function migrateOldData(): MigrationOutcome | null {
  try {
    return migrateDataFolder({ localAppData: dirname(dataDir()) })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const logPath = error instanceof DataMigrationError ? error.logPath : null
    dialog.showErrorBox(
      'Loam could not copy your data',
      `${reason}\n\nYour UnrealManager data was not changed, and Loam was not started with an empty library. ` +
        'Start Loam again to retry.' +
        (logPath ? `\n\nDetails: ${logPath}` : ''),
    )
    return null
  }
}

async function start(): Promise<void> {
  const migration = migrateOldData()
  if (!migration) {
    app.exit(1)
    return
  }
  // Chromium profile data (local storage, caches) lives with the rest of the app data,
  // not in %APPDATA%, so one LOCALAPPDATA folder holds everything (and isolates test runs).
  // The single-instance lock is keyed on this folder, so it must be set first.
  app.setPath('userData', browserDataDir())
  log = createMainLog(logsDir(), {
    allowedRoots: [dataDir(), oldDataDir(), codeRoot()],
    blockedRoots: [filesDir()],
    echo: true,
  })
  log.info(
    `[startup] Loam ${app.getVersion()} (${app.isPackaged ? 'packaged' : 'unpackaged'}) launching`,
  )
  if (migration.status === 'migrated') {
    const { marker } = migration
    log.info(
      // No colon right after a path: the log's path filter would take it as part of the path.
      `[migration] copied ${marker.from} to ${marker.to} (schema version ${marker.schemaVersion}, ${marker.references} references, ${marker.files.count} files, ${marker.backups.count} backups); the old folder was left as it was`,
    )
  } else if (migration.reason === 'migrated-by-another-start') {
    log.info('[migration] another start copied the UnrealManager data first; using its copy')
  }

  // One running app per data folder: a second launch exits before it touches
  // the database, and the first one comes to the front instead.
  if (!app.requestSingleInstanceLock()) {
    log.info('[startup] Loam is already running; handing over to it and exiting')
    app.exit(0)
    return
  }
  app.on('second-instance', () => {
    log?.info('[startup] a second launch was handed over to this window')
    bringToFront()
  })

  registerAssetScheme()
  await app.whenReady()
  const opening = performance.now()
  const { db, previousVersion, schemaVersion, backupPath } = openDatabase({
    filePath: databasePath(),
    migrationsDir: migrationsDir(),
  })
  if (backupPath) log.info(`[storage] backed up the database to ${backupPath} before migrating`)
  log.info(
    `[storage] database opened in ${Math.round(performance.now() - opening)} ms: schema version ${previousVersion} before, ${schemaVersion} after migrating`,
  )
  app.on('will-quit', () => db.close())

  const clock = { now: () => new Date() }
  const blobs = new FileBlobStore(filesDir())
  const references = new ReferenceService({
    repository: new SqliteReferenceRepository(db),
    blobs,
    hasher: sha256Hasher,
    clock,
  })
  // The bible and the study journal are the same vault machinery: one
  // service each, so both can be open at once. They share the index.
  const vaultDeps = {
    files: new NodeVaultFiles(),
    index: new SqliteBibleIndex(db),
    kits: new FolderStarterKits(
      starterKitsDir(process.resourcesPath, app.isPackaged, app.getAppPath()),
    ),
    clock: { now: () => new Date(), monotonicMs: () => performance.now() },
    newId: newEntryId,
    onChanged: (event: { vaultId: number; paths: string[] }) => sendEvent('bible:changed', event),
    library: {
      describe: (ids: readonly number[]) => references.assetInfo(ids),
      read: async (hash: string) => new Uint8Array(await blobs.read(hash)),
    },
    hasher: sha256Hasher,
  }
  const bible = new BibleService({ ...vaultDeps, watcher: new ChokidarVaultWatcher() })
  const journal = new BibleService({
    ...vaultDeps,
    watcher: new ChokidarVaultWatcher(),
    role: 'journal',
  })
  serveAssets(blobs, (host, relativePath) =>
    host === 'journal' ? journal.vaultFile(relativePath) : bible.vaultFile(relativePath),
  )
  app.on('will-quit', () => {
    void bible.close()
    void journal.close()
  })

  // Local AI helpers: off by default. While off, nothing below touches the
  // network or loads a model. Test-only switches: LOAM_MODEL_CATALOG (a local
  // catalog to download from) and LOAM_AI_FAKE_PROVIDER (no model at all).
  const catalog = envSetting('MODEL_CATALOG')
  const models = new ModelManager({
    dir: modelsDir(),
    spec: catalog ? parseModelSpec(JSON.parse(readFileSync(catalog, 'utf8'))) : DEFAULT_MODEL,
    log: (line) => log?.info(line),
  })
  const suggestionStore = new SqliteSuggestionStore(db)
  const fakeDelay = Number(envSetting('AI_FAKE_DELAY_MS') ?? '0')
  const ai = new AiController({
    settings: new SqliteSettings(db),
    models,
    store: suggestionStore,
    knownTags: () => [
      ...references.tagNames(),
      ...bible.openVaultTags(),
      ...journal.openVaultTags(),
    ],
    readImage: async (hash) => new Uint8Array(await blobs.read(hash)),
    runningApps,
    log: (line) => log?.info(line),
    emit: (status) => sendEvent('ai:status', status),
    clock,
    fakeProvider: envSetting('AI_FAKE_PROVIDER') ? new FakeAgentProvider(fakeDelay) : null,
  })
  app.on('will-quit', () => void ai.dispose())

  const handlers = createHandlers({
    clock,
    references,
    bible,
    journal,
    suggestedJournalFolder: join(app.getPath('documents'), 'Loam Journal'),
    about: () => ({
      name: 'Loam',
      version: app.getVersion(),
      license: 'MIT',
      repositoryUrl: REPOSITORY_URL,
      websiteUrl: WEBSITE_URL,
      dataFolder: dataDir(),
      migration: describeMigration(dataDir(), oldDataDir()),
    }),
    notices: () =>
      readFileSync(
        bundledFile(
          'THIRD_PARTY_NOTICES.md',
          process.resourcesPath,
          app.isPackaged,
          app.getAppPath(),
        ),
        'utf8',
      ),
    pickFolder,
    copySample: (folder) =>
      copySampleBible(
        bundledFile(SAMPLE_BIBLE, process.resourcesPath, app.isPackaged, app.getAppPath()),
        folder,
      ),
    openExternal,
    suggestions: new SuggestionService({ references, suggestions: suggestionStore }),
    ai,
  })
  ipcMain.handle(INVOKE_CHANNEL, (_event, channel: unknown, payload: unknown) =>
    dispatch(handlers, channel, payload),
  )

  mainWindow = createWindow()
}

app.on('window-all-closed', () => app.quit())

// Records crashes without changing how Electron handles them.
process.on('uncaughtExceptionMonitor', (error, origin) => {
  log?.error(`[main] ${origin}`, error)
})

start().catch((error: unknown) => {
  if (log) log.error('[startup] failed', error)
  else console.error('[startup] failed', error)
  app.exit(1)
})
