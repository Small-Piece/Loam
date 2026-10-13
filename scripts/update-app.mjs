// pnpm update-app (the maintainer's machine): close the installed app, build the installer,
// install over it and start it. After the first successful start of Loam, it uninstalls the
// old UnrealManager program (the app's name before 0.1.0). Neither data folder,
// %LOCALAPPDATA%\Loam nor %LOCALAPPDATA%\UnrealManager, is ever deleted or changed by this
// script; it checks that around every step that runs an installer.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const localAppData = process.env['LOCALAPPDATA']
if (process.platform !== 'win32' || !localAppData)
  fail('update-app is for Windows (needs %LOCALAPPDATA%).')

const loam = {
  name: 'Loam',
  exe: 'Loam.exe',
  uninstaller: 'Uninstall Loam.exe',
  dataDir: join(localAppData, 'Loam'),
  defaultInstallDir: join(localAppData, 'Programs', 'Loam'),
}
const old = {
  name: 'UnrealManager',
  exe: 'UnrealManager.exe',
  uninstaller: 'Uninstall UnrealManager.exe',
  dataDir: join(localAppData, 'UnrealManager'),
}
const MIGRATION_MARKER = 'migrated-from-unrealmanager.json'
const MIGRATION_ERROR_LOG = join(localAppData, 'Loam-migration-error.log')
/** How long the first start may take: it copies the UnrealManager data first. */
const FIRST_START_TIMEOUT_MS = 5 * 60_000

function fail(message) {
  console.error(`update-app: ${message}`)
  process.exit(1)
}

function step(message) {
  console.log(`\n[update-app] ${message}`)
}

function powershell(command) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    {
      encoding: 'utf8',
    },
  )
  if (result.status !== 0) fail(`PowerShell failed: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/*
 * Installers, uninstallers and registry reads run OUTSIDE this script's process
 * tree, through Win32_Process.Create. A terminal that belongs to a packaged
 * (MSIX) app, such as a terminal installed from the Microsoft Store, gives its child processes a
 * private copy of HKCU and of new folders in %LOCALAPPDATA%: an installer run
 * as a child would write its uninstall entry only into that copy, where
 * Windows' "Installed apps" never sees it.
 */
let outsideRuns = 0

/** Starts a command line outside this process tree and returns its process id. */
function startOutside(commandLine) {
  const quoted = commandLine.replace(/'/g, "''")
  const pid = powershell(
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${quoted}' }; ` +
      'if ($r.ReturnValue -ne 0) { [Console]::Error.WriteLine("Win32_Process.Create returned " + $r.ReturnValue); exit 1 }; ' +
      '$r.ProcessId',
  )
  return Number(pid)
}

/** Runs a command line outside this process tree and waits until it exits. */
async function runOutside(commandLine, timeoutMs = 10 * 60_000) {
  const pid = startOutside(commandLine)
  for (let waited = 0; isAlive(pid); waited += 250) {
    if (waited > timeoutMs) fail(`${commandLine} did not finish in ${timeoutMs / 1000} s.`)
    await sleep(250)
  }
}

/** Runs a PowerShell command outside this process tree and returns what it printed. */
async function outsidePowerShell(command) {
  outsideRuns += 1
  const out = join(tmpdir(), `loam-update-app-${process.pid}-${outsideRuns}.txt`)
  const script =
    `$text = (& { ${command} }) -join [Environment]::NewLine; ` +
    `[IO.File]::WriteAllText('${out.replace(/'/g, "''")}', [string]$text)`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  await runOutside(`powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`, 60_000)
  if (!existsSync(out)) fail(`PowerShell (outside this terminal) gave no answer to: ${command}`)
  const text = readFileSync(out, 'utf8').trim()
  rmSync(out, { force: true })
  return text
}

/** The per-user uninstall entries of an app ("<name>" or "<name> <version>"), as Windows sees them. */
async function installEntries(app) {
  const json = await outsidePowerShell(
    "@(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' " +
      `-ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^${app.name}( |$)' } | ` +
      'Select-Object PSChildName, DisplayName, InstallLocation, UninstallString, QuietUninstallString) | ' +
      'ConvertTo-Json -Compress',
  )
  if (!json) return []
  const parsed = JSON.parse(json)
  return Array.isArray(parsed) ? parsed : [parsed]
}

/** Install folder of an entry; electron-builder records it only in the uninstaller path. */
function installDirOf(entry, app) {
  if (entry.InstallLocation) return entry.InstallLocation
  const pattern = new RegExp(`^"([^"]+)\\\\${escapeRegExp(app.uninstaller)}"`, 'i')
  const match = pattern.exec(entry.UninstallString ?? '')
  return match ? match[1] : null
}

function isInside(child, parent) {
  const path = relative(resolve(parent), resolve(child))
  return path === '' || (!path.startsWith('..') && !path.includes(':'))
}

/** File list with sizes and modification times: any change shows up as a difference. */
function fingerprint(dir) {
  const entries = []
  function walk(current) {
    for (const name of readdirSync(current)) {
      const path = join(current, name)
      const stat = statSync(path)
      if (stat.isDirectory()) walk(path)
      else entries.push(`${relative(dir, path)}|${stat.size}|${stat.mtimeMs}`)
    }
  }
  if (existsSync(dir)) walk(dir)
  return entries.sort().join('\n')
}

/** Both data folders, so a step that must not touch them can be checked. */
function dataFingerprints() {
  return { loam: fingerprint(loam.dataDir), old: fingerprint(old.dataDir) }
}

function checkDataUntouched(before, during) {
  const after = dataFingerprints()
  if (after.loam !== before.loam) fail(`user data in ${loam.dataDir} changed during ${during}.`)
  if (after.old !== before.old) fail(`user data in ${old.dataDir} changed during ${during}.`)
  console.log(`User data in ${loam.dataDir} and ${old.dataDir} untouched.`)
}

/** Running processes of an app started from its install folder (not dev or test builds). */
function runningFrom(app, installDir) {
  const json = powershell(
    `@(Get-CimInstance Win32_Process -Filter "Name='${app.exe}'" | ` +
      'Select-Object ProcessId, ExecutablePath, CommandLine) | ConvertTo-Json -Compress',
  )
  if (!json) return []
  const list = JSON.parse(json)
  return (Array.isArray(list) ? list : [list]).filter(
    (proc) => proc.ExecutablePath && isInside(proc.ExecutablePath, installDir),
  )
}

/** Main processes from the install folder (not Chromium helpers). */
function mainProcesses(app, installDir) {
  return runningFrom(app, installDir).filter((proc) => !/--type=/.test(proc.CommandLine ?? ''))
}

/** Parents that mean "started from this terminal", which may run inside an app package. */
const SESSION_PROCESSES =
  /^(node|bash|sh|cmd|pwsh|powershell|windowsterminal|openconsole|conhost)\.exe$/i

/** The chain of parent processes, nearest first, as far as Windows still knows them. */
function ancestorsOf(pid) {
  const json = powershell(
    '@(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name) | ' +
      'ConvertTo-Json -Compress',
  )
  const all = new Map(JSON.parse(json).map((proc) => [proc.ProcessId, proc]))
  const chain = []
  let current = all.get(pid)
  while (current && chain.length < 32) {
    const parent = all.get(current.ParentProcessId)
    // Windows reuses ids: a "parent" that is the process itself or already seen ends the chain.
    if (!parent || parent === current || chain.includes(parent)) break
    chain.push(parent)
    current = parent
  }
  return chain
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

async function closeApp(app, installDir) {
  const running = runningFrom(app, installDir)
  if (running.length === 0) {
    console.log(`${app.name} is not running.`)
    return
  }
  // Ask the main process politely (WM_CLOSE to its window), so the app shuts down the
  // normal way and closes its database. Chromium helper processes (--type=...) have no
  // window and exit with it.
  for (const proc of mainProcesses(app, installDir))
    spawnSync('taskkill', ['/PID', String(proc.ProcessId)], { stdio: 'ignore' })
  for (let waited = 0; waited < 10_000 && runningFrom(app, installDir).length > 0; waited += 250) {
    await sleep(250)
  }
  const left = runningFrom(app, installDir)
  if (left.length > 0) {
    console.log(`${app.name} did not close in 10 s; ending it.`)
    for (const proc of left)
      spawnSync('taskkill', ['/PID', String(proc.ProcessId), '/T', '/F'], { stdio: 'ignore' })
    await sleep(500)
  }
  if (runningFrom(app, installDir).length > 0) fail(`could not close the running ${app.name}.`)
  console.log(`Closed ${app.name} (${running.length} processes).`)
}

/**
 * Packaged (MSIX) apps such as some terminals keep a private, merged copy of
 * folders created inside them under %LOCALAPPDATA%\Packages\<app>\LocalCache.
 * A private Loam folder there would hide the real one from this script.
 */
function privateLoamCopies() {
  const packages = join(localAppData, 'Packages')
  if (!existsSync(packages)) return []
  const found = []
  for (const name of readdirSync(packages)) {
    const copy = join(packages, name, 'LocalCache', 'Local', loam.name)
    if (existsSync(copy)) found.push(copy)
  }
  return found
}

/** One install entry at most; returns its folder, or null when the app is not installed. */
async function installedDir(app) {
  const entries = await installEntries(app)
  if (entries.length > 1) {
    fail(
      `found ${entries.length} ${app.name} installs; uninstall the extras first:\n` +
        entries.map((entry) => `  ${entry.DisplayName}: ${installDirOf(entry, app)}`).join('\n'),
    )
  }
  return entries[0] ? (installDirOf(entries[0], app) ?? null) : null
}

/** Waits until this start of Loam has opened its database and shown its window. */
async function waitForFirstStart(pid, launchedAt) {
  const log = join(loam.dataDir, 'logs', 'main.log')
  const shown = `[pid ${pid}] [startup] window shown`
  for (let waited = 0; waited < FIRST_START_TIMEOUT_MS; waited += 500) {
    if (existsSync(log) && readFileSync(log, 'utf8').includes(shown)) return
    if (existsSync(MIGRATION_ERROR_LOG) && statSync(MIGRATION_ERROR_LOG).mtimeMs >= launchedAt) {
      fail(
        `Loam could not copy the UnrealManager data (see ${MIGRATION_ERROR_LOG}). ` +
          'The old program stays installed and both data folders are as they were.',
      )
    }
    if (!isAlive(pid)) fail(`Loam (pid ${pid}) exited before its window was shown; see ${log}.`)
    await sleep(500)
  }
  fail(`Loam (pid ${pid}) did not show its window within ${FIRST_START_TIMEOUT_MS / 1000} s.`)
}

const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'

/**
 * Removes the old program: runs its silent uninstaller, or, when its files are
 * already gone, removes the uninstall entry it left behind (after exporting it
 * to a .reg file). Only the old data folder is checked here: Loam is running
 * and writes to its own folder.
 */
async function uninstallOld(oldInstallDir) {
  const [entry] = await installEntries(old)
  if (!entry) {
    console.log('UnrealManager has no uninstall entry; nothing to remove.')
    return
  }
  const before = fingerprint(old.dataDir)
  const uninstaller = join(oldInstallDir, old.uninstaller)
  if (existsSync(uninstaller)) {
    await runOutside(entry.QuietUninstallString || `"${uninstaller}" /currentuser /S`)
    // The NSIS uninstaller copies itself to %TEMP% and goes on from there; wait for the result.
    for (let waited = 0; waited < 60_000; waited += 1000) {
      if ((await installEntries(old)).length === 0 && !existsSync(uninstaller)) break
      await sleep(1000)
    }
  } else {
    const guid = entry.PSChildName
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(guid ?? '')) {
      fail(`unexpected UnrealManager uninstall entry name: ${guid}`)
    }
    const backup = join(tmpdir(), `UnrealManager-uninstall-entry-${guid}.reg`)
    console.log(
      `The UnrealManager program files are already gone; removing its leftover uninstall entry.`,
    )
    await runOutside(`reg.exe export "${UNINSTALL_KEY}\\${guid}" "${backup}" /y`)
    if (!existsSync(backup)) fail(`could not back up the uninstall entry to ${backup}.`)
    console.log(`Backed up the entry to ${backup}.`)
    await runOutside(`reg.exe delete "${UNINSTALL_KEY}\\${guid}" /f`)
    await runOutside(`reg.exe delete "HKCU\\Software\\${guid}" /f`)
  }
  if ((await installEntries(old)).length > 0) fail('UnrealManager is still listed as installed.')
  if (fingerprint(old.dataDir) !== before) {
    fail(`user data in ${old.dataDir} changed during the uninstall of UnrealManager.`)
  }
  console.log(`User data in ${old.dataDir} untouched.`)
}

// Where to install: over the existing per-user install, or the default location.
const installDir = (await installedDir(loam)) || loam.defaultInstallDir
const oldInstallDir = await installedDir(old)
for (const dataDir of [loam.dataDir, old.dataDir]) {
  if (isInside(installDir, dataDir) || isInside(dataDir, installDir)) {
    fail(`install folder ${installDir} overlaps the data folder ${dataDir}; refusing.`)
  }
}
const copies = privateLoamCopies()
if (copies.length > 0) {
  fail(
    `found a private copy of the Loam data folder that a packaged app keeps:\n  ${copies.join('\n  ')}\n` +
      'It would hide the real folder from this script. Move it out of the way by hand, then run update-app again.',
  )
}

// 1. Close the installed apps first, and cleanly. electron-builder force-kills running
// copies while packaging, which would skip the app's own shutdown. The old app must not
// run while Loam copies its data.
step(`Closing Loam running from ${installDir}`)
await closeApp(loam, installDir)
if (oldInstallDir) {
  step(`Closing UnrealManager running from ${oldInstallDir}`)
  await closeApp(old, oldInstallDir)
}

// 2. Build the installer, exactly like pnpm build.
step('Building the installer (pnpm build)')
const build = spawnSync('pnpm', ['build'], { cwd: repo, stdio: 'inherit', shell: true })
if (build.status !== 0) fail('pnpm build failed.')
const { version } = JSON.parse(readFileSync(join(repo, 'apps/desktop/package.json'), 'utf8'))
const installer = join(repo, 'apps/desktop/release', `Loam Setup ${version}.exe`)
if (!existsSync(installer)) fail(`installer not found: ${installer}`)
// In case one was started again during the build.
await closeApp(loam, installDir)
if (oldInstallDir) await closeApp(old, oldInstallDir)

// 3. Install silently, per user, into the same folder. User data is outside it.
const beforeInstall = dataFingerprints()
step(`Installing Loam ${version} silently into ${installDir}`)
// NSIS: /D must be last and unquoted, even when the path has spaces. Run outside this
// process tree, so its uninstall entry lands in the real registry (see startOutside).
await runOutside(`"${installer}" /S /currentuser /D=${installDir}`)
const exe = join(installDir, loam.exe)
if (!existsSync(exe)) fail(`install finished but ${exe} is missing.`)
const installed = await installEntries(loam)
if (installed.length !== 1)
  fail(`expected exactly one Loam install after updating, found ${installed.length}.`)
console.log(`Windows lists ${installed[0].DisplayName} as installed.`)
checkDataUntouched(beforeInstall, 'the install')

// 4. Launch the installed app through Explorer, never as a child of this script.
// When this script runs in a terminal that belongs to a packaged app (for example one
// installed from the Microsoft Store), its child processes see a private copy
// of %LOCALAPPDATA%, not the real data folder. Explorer hands the start to the desktop
// shell, so the app runs outside that package and keeps running after the terminal closes.
step('Launching Loam through Explorer')
const hadOldData = existsSync(join(old.dataDir, 'unrealmanager.db'))
const firstStart = !existsSync(loam.dataDir)
const previous = new Set(mainProcesses(loam, installDir).map((proc) => proc.ProcessId))
const launchedAt = Date.now()
// explorer.exe exits with code 1 even when it started the program, so the check is below.
spawnSync('explorer.exe', [exe], { stdio: 'ignore' })
let started = null
for (let waited = 0; waited < 15_000 && !started; waited += 250) {
  await sleep(250)
  started = mainProcesses(loam, installDir).find((proc) => !previous.has(proc.ProcessId)) ?? null
}
if (!started) fail(`Explorer did not start ${exe}. Start Loam from the Start menu.`)
const inside = ancestorsOf(started.ProcessId).find((proc) => SESSION_PROCESSES.test(proc.Name))
if (inside) {
  spawnSync('taskkill', ['/PID', String(started.ProcessId), '/T', '/F'], { stdio: 'ignore' })
  fail(
    `Loam started under ${inside.Name} (pid ${inside.ProcessId}), so it may not use ` +
      'the real data folder; it was closed again. Start Loam from the Start menu.',
  )
}
console.log(`Started Loam (pid ${started.ProcessId}) outside this terminal.`)
if (firstStart && hadOldData) console.log('This first start copies the UnrealManager data.')
await waitForFirstStart(started.ProcessId, launchedAt)
console.log(
  `Loam opened its database and showed its window ("[pid ${started.ProcessId}] [startup] window shown" in ${join(loam.dataDir, 'logs', 'main.log')}).`,
)

// 5. Once Loam has started successfully, the old program is no longer needed.
if (oldInstallDir) {
  const marker = join(loam.dataDir, MIGRATION_MARKER)
  if (hadOldData && !existsSync(marker)) {
    fail(
      `Loam started, but ${marker} is missing, so the UnrealManager data was not copied. ` +
        'The old program stays installed.',
    )
  }
  step(`Uninstalling the old UnrealManager program from ${oldInstallDir} (its data folder stays)`)
  await uninstallOld(oldInstallDir)
  console.log('UnrealManager uninstalled.')
}

console.log(`\nLoam ${version} installed at: ${installDir}`)
console.log(`Data folder: ${loam.dataDir}`)
if (existsSync(old.dataDir)) {
  console.log(
    `The old data folder ${old.dataDir} was left as it was; delete it by hand once everything looks right.`,
  )
}
