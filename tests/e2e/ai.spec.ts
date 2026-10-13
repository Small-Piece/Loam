import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { drop, makeImageTransfer } from './fixtures.ts'
import { assertBuilt, launchApp as launch, testSetting } from './launch.ts'

// Temp folders only; the only server is a local one on 127.0.0.1.
let root: string
let running: ElectronApplication[] = []
let blocker: ChildProcess | null = null

test.beforeAll(() => {
  assertBuilt()
})

test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'loam-e2e-ai-'))
})

test.afterEach(async () => {
  blocker?.kill()
  blocker = null
  for (const app of running) await app.close().catch(() => undefined)
  running = []
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

async function launchApp(appData: string, env: Record<string, string> = {}) {
  mkdirSync(appData, { recursive: true })
  const app = await launch(appData, env)
  running.push(app)
  const page = await app.firstWindow()
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible()
  return { app, page }
}

/** Records every outbound connection the main process opens and every request the page makes. */
async function recordNetwork(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ session }) => {
    const seen: string[] = []
    ;(globalThis as { loamNetwork?: string[] }).loamNetwork = seen
    const net = process.getBuiltinModule('node:net') as typeof import('node:net')
    const connect = net.Socket.prototype.connect
    net.Socket.prototype.connect = function (this: import('node:net').Socket, ...args: unknown[]) {
      seen.push(`socket ${JSON.stringify(args[0]).slice(0, 200)}`)
      return (connect as (...rest: unknown[]) => import('node:net').Socket).apply(this, args)
    } as typeof connect
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(`fetch ${String(input instanceof Request ? input.url : input)}`)
      return realFetch(input, init)
    }) as typeof fetch
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (details, callback) => {
        seen.push(`page ${details.url}`)
        callback({})
      },
    )
  })
}

const networkLog = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as { loamNetwork?: string[] }).loamNetwork ?? [])

function llamaServerRunning(): boolean {
  return String(execFileSync('tasklist', ['/FI', 'IMAGENAME eq llama-server.exe'])).includes(
    'llama-server.exe',
  )
}

const mainLog = (appData: string) => {
  const file = join(appData, 'Loam', 'logs', 'main.log')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

const rail = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name, exact: true })
const aiSwitch = (page: Page) => page.getByRole('switch', { name: 'Local AI helpers' })
// The status text only (the line also holds a Pause button).
const progress = (page: Page) => page.getByTestId('ai-progress').first().getByRole('status')

async function importImages(page: Page, count: number) {
  await rail(page, 'Library').click()
  await expect(page.getByRole('heading', { name: 'All references' })).toBeVisible()
  await drop(
    page,
    await makeImageTransfer(
      page,
      Array.from({ length: count }, (_, index) => ({ index: index + 1, width: 640, height: 400 })),
    ),
  )
  await expect(page.getByTestId('ref-card')).toHaveCount(count)
}

test('with AI off (the default) the app makes no network calls and loads no model', async () => {
  const appData = join(root, 'appdata')
  const { app, page } = await launchApp(appData)
  await recordNetwork(app)
  await importImages(page, 2)
  await page.getByTestId('ref-card').first().click()
  await expect(page.getByRole('complementary', { name: 'Reference detail' })).toBeVisible()
  await rail(page, 'Bible').click()
  await rail(page, 'Journal').click()
  await rail(page, 'Settings').click()
  await expect(aiSwitch(page)).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByTestId('model-status')).toHaveText('Not downloaded')
  // Download shows the exact source URLs before anything happens; cancelling sends nothing.
  await page.getByRole('button', { name: 'Download', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Download the model' })
  await expect(dialog.getByTestId('download-urls')).toContainText(
    'https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/1cd86afb9a95c410a6038ab3b40d8b578c892266/Qwen3VL-4B-Instruct-Q4_K_M.gguf',
  )
  await expect(dialog.getByTestId('download-urls')).toContainText(
    'https://github.com/ggml-org/llama.cpp/releases/download/b11577/llama-b11577-bin-win-vulkan-x64.zip',
  )
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await rail(page, 'Library').click()
  await expect(page.getByTestId('ai-progress')).toHaveCount(0)
  // Give any background work time to show itself.
  await page.waitForTimeout(3000)
  expect(await networkLog(app)).toEqual([])
  expect(llamaServerRunning()).toBe(false)
  const log = mainLog(appData)
  expect(log).not.toContain('[ai] model loading')
  expect(log).not.toContain('[ai] queue started')
  expect(log).not.toContain('[ai] model download')
  expect(existsSync(join(appData, 'Loam', 'models'))).toBe(false)
})

/** A local stand-in for the model's download servers. */
function modelServer(files: Record<string, Buffer>) {
  const state = { corrupt: new Set<string>(), slow: true, ranges: [] as Array<[string, string]> }
  const server: Server = createServer((request, response) => {
    const name = (request.url ?? '').slice(1)
    const body = files[name]
    if (!body) {
      response.writeHead(404).end()
      return
    }
    const sent = state.corrupt.has(name) ? Buffer.from(body).fill(1, 100, 200) : body
    const match = /^bytes=(\d+)-$/.exec(request.headers.range ?? '')
    if (match) state.ranges.push([name, request.headers.range ?? ''])
    const start = match ? Number(match[1]) : 0
    response.writeHead(start > 0 ? 206 : 200, { 'content-length': String(sent.length - start) })
    let at = start
    const step = () => {
      if (response.destroyed) return
      if (at >= sent.length) {
        response.end()
        return
      }
      const next = Math.min(sent.length, at + 64 * 1024)
      response.write(sent.subarray(at, next))
      at = next
      setTimeout(step, state.slow ? 15 : 0)
    }
    step()
  })
  return { server, state }
}

test('the model download shows its URLs, verifies checksums, cancels, resumes and rejects a bad file', async () => {
  // A runtime zip (with a stand-in llama-server.exe) and two "model" files.
  const stage = join(root, 'stage')
  mkdirSync(stage)
  writeFileSync(join(stage, 'llama-server.exe'), 'not a real program')
  execFileSync(join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe'), [
    '-a',
    '-cf',
    join(root, 'runtime.zip'),
    '-C',
    stage,
    'llama-server.exe',
  ])
  const files: Record<string, Buffer> = {
    'runtime.zip': readFileSync(join(root, 'runtime.zip')),
    'model.gguf': Buffer.alloc(6 * 1024 * 1024, 7),
    'projector.gguf': Buffer.alloc(2 * 1024 * 1024, 9),
  }
  const { server, state } = modelServer(files)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  const kinds = { 'runtime.zip': 'runtime', 'model.gguf': 'model', 'projector.gguf': 'projector' }
  const catalog = join(root, 'catalog.json')
  writeFileSync(
    catalog,
    JSON.stringify({
      id: 'test-model',
      name: 'Test model',
      license: 'Apache-2.0',
      runtimeLicense: 'MIT',
      files: Object.entries(files).map(([name, bytes]) => ({
        kind: kinds[name as keyof typeof kinds],
        name,
        url: `${base}/${name}`,
        size: bytes.length,
        sha256: sha(bytes),
      })),
    }),
  )
  try {
    const appData = join(root, 'appdata')
    const models = join(appData, 'Loam', 'models')
    const { app, page } = await launchApp(appData, { LOAM_MODEL_CATALOG: catalog })
    await recordNetwork(app)
    await rail(page, 'Settings').click()

    // The URLs come first.
    await page.getByRole('button', { name: 'Download', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Download the model' })
    for (const name of Object.keys(files)) {
      await expect(dialog.getByTestId('download-urls')).toContainText(`${base}/${name}`)
    }
    state.corrupt.add('projector.gguf')
    await dialog.getByRole('button', { name: 'Download', exact: true }).click()

    // Cancel part-way through the model file; the partial file stays.
    await expect(page.getByTestId('model-status')).toContainText('Downloading')
    await expect
      .poll(() => existsSync(join(models, 'model.gguf.part')), { timeout: 10_000 })
      .toBe(true)
    await page.getByRole('button', { name: 'Cancel download' }).click()
    await expect(page.getByTestId('model-status')).toContainText('Paused')
    expect(existsSync(join(models, 'model.gguf.part'))).toBe(true)

    // Resume: a Range request picks up where it stopped. The projector is corrupt: rejected.
    state.slow = false
    await page.getByRole('button', { name: 'Resume download' }).click()
    // Resuming shows the URLs again before anything is fetched.
    await dialog.getByRole('button', { name: 'Download', exact: true }).click()
    await expect(page.getByTestId('download-error')).toContainText('did not match its checksum')
    expect(state.ranges.some(([name]) => name === 'model.gguf')).toBe(true)
    expect(existsSync(join(models, 'model.gguf'))).toBe(true)
    expect(existsSync(join(models, 'projector.gguf'))).toBe(false)
    expect(existsSync(join(models, 'projector.gguf.part'))).toBe(false)

    // A good copy this time.
    state.corrupt.clear()
    await page.getByRole('button', { name: 'Resume download' }).click()
    // Resuming shows the URLs again before anything is fetched.
    await dialog.getByRole('button', { name: 'Download', exact: true }).click()
    await expect(page.getByTestId('model-status')).toHaveText('Downloaded')
    expect(readdirSync(models).sort()).toEqual(['model.gguf', 'projector.gguf', 'runtime'])
    expect(existsSync(join(models, 'runtime', 'llama-server.exe'))).toBe(true)
    // Only the local server was contacted.
    const outbound = (await networkLog(app)).filter((line) => !line.includes('127.0.0.1'))
    expect(outbound).toEqual([])

    // Delete frees the disk.
    await page.getByRole('button', { name: 'Delete model' }).click()
    await page
      .getByRole('alertdialog', { name: 'Delete the model' })
      .getByRole('button', { name: 'Delete model' })
      .click()
    await expect(page.getByTestId('model-status')).toHaveText('Not downloaded')
    expect(readdirSync(models)).toEqual([])
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test('tag suggestions: accept, reject, accept all; never in filters or search until accepted', async () => {
  const appData = join(root, 'appdata')
  // The old UM_ name on purpose: it must keep working for the 0.1 releases.
  const { page } = await launchApp(appData, { UM_AI_FAKE_PROVIDER: '1' })
  await importImages(page, 3)
  await rail(page, 'Settings').click()
  await aiSwitch(page).click()
  await expect(aiSwitch(page)).toHaveAttribute('aria-checked', 'true')
  await rail(page, 'Library').click()
  await expect(progress(page)).toContainText('Tag suggestions: all 3 images looked at')

  await page.getByTestId('ref-card').first().click()
  const detail = page.getByRole('complementary', { name: 'Reference detail' })
  const chips = detail.getByTestId('suggested-tag')
  await expect(chips).toHaveCount(4)
  const tags = await detail
    .getByRole('group', { name: 'Suggested tags' })
    .locator('.suggested-accept')
    .allInnerTexts()
  // Not a tag yet: no filter chip, no search hit, no tag on the image.
  await expect(page.getByText('Tags you add to references appear here as filters.')).toBeVisible()
  await expect(detail.getByRole('button', { name: `Remove tag ${tags[0]}` })).toHaveCount(0)
  await page
    .getByRole('searchbox')
    .first()
    .fill(tags[0] ?? '')
  await expect(page.getByTestId('result-count')).toHaveText('0 references match')
  await page.getByRole('searchbox').first().fill('')

  // Accept one: it becomes a normal tag and a filter.
  await detail.getByRole('button', { name: `Accept tag ${tags[0]}` }).click()
  await expect(detail.getByRole('button', { name: `Remove tag ${tags[0]}` })).toBeVisible()
  await expect(chips).toHaveCount(3)
  await expect(page.locator('.tag-chip', { hasText: tags[0] ?? '' })).toHaveCount(1)

  // Reject one: it goes and does not come back for this image.
  await detail.getByRole('button', { name: `Reject tag ${tags[1]}` }).click()
  await expect(chips).toHaveCount(2)
  await page.getByTestId('ref-card').nth(1).click()
  await page.getByTestId('ref-card').first().click()
  await expect(detail.getByTestId('suggested-tag')).toHaveCount(2)
  await expect(detail.getByRole('button', { name: `Accept tag ${tags[1]}` })).toHaveCount(0)

  // Accept all.
  await detail.getByRole('button', { name: 'Accept all' }).click()
  await expect(detail.getByTestId('suggested-tag')).toHaveCount(0)
  for (const tag of [tags[0], tags[2], tags[3]]) {
    await expect(detail.getByRole('button', { name: `Remove tag ${tag}` })).toBeVisible()
  }
  await expect(detail.getByRole('button', { name: `Remove tag ${tags[1]}` })).toHaveCount(0)

  // The log says what happened, never which tags.
  const log = mainLog(appData)
  expect(log).toContain('[ai] queue started')
  for (const tag of tags) expect(log.toLowerCase()).not.toContain(` ${tag.toLowerCase()}`)
})

test('the queue pauses within 5 seconds of a listed app starting and resumes after it closes', async () => {
  // A uniquely named stand-in for UnrealEditor.exe: a copy of node that waits.
  const blockerExe = join(root, 'LoamBlocker.exe')
  copyFileSync(process.execPath, blockerExe)
  const appData = join(root, 'appdata')
  const { page } = await launchApp(appData, {
    LOAM_AI_FAKE_PROVIDER: '1',
    LOAM_AI_FAKE_DELAY_MS: '800',
  })
  await importImages(page, 8)
  await rail(page, 'Settings').click()
  await page.getByRole('textbox', { name: 'Add a program' }).fill('LoamBlocker.exe')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByRole('list', { name: 'Apps that pause AI' })).toContainText(
    'UnrealEditor.exe',
  )
  await expect(page.getByRole('list', { name: 'Apps that pause AI' })).toContainText(
    'LoamBlocker.exe',
  )
  await aiSwitch(page).click()
  await rail(page, 'Library').click()
  await expect(progress(page)).toContainText(/Suggesting tags: [1-7] of 8$/)

  blocker = spawn(blockerExe, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' })
  const started = Date.now()
  await expect(progress(page)).toContainText('paused while LoamBlocker.exe runs', {
    timeout: 5000,
  })
  expect(Date.now() - started).toBeLessThan(5000)
  const held = await progress(page).innerText()
  // Nothing moves while it runs (the UI still answers meanwhile).
  await page.getByTestId('ref-card').first().click()
  await expect(page.getByRole('complementary', { name: 'Reference detail' })).toBeVisible()
  await page.waitForTimeout(2500)
  expect(await progress(page).innerText()).toBe(held)

  blocker.kill()
  blocker = null
  await expect(progress(page)).not.toContainText('paused while', { timeout: 5000 })
  await expect(progress(page)).toContainText('Tag suggestions: all 8 images looked at', {
    timeout: 20_000,
  })
  expect(mainLog(appData)).toContain('[ai] queue paused while a listed app runs')
})

function sessionFile(id: string, title: string, date: string, body: string): string {
  return `---\nid: ${id}\ntitle: ${title}\ntags: []\ncreated: ${date}T08:00:00.000Z\nupdated: ${date}T08:00:00.000Z\ndate: ${date}\ntopics: []\n---\n${body}`
}

test('a journal recap is only a draft until "Save as session note"', async () => {
  const appData = join(root, 'appdata')
  const { app, page } = await launchApp(appData, { LOAM_AI_FAKE_PROVIDER: '1' })
  const folder = join(root, 'Journal')
  await rail(page, 'Journal').click()
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [picked],
    })) as unknown as typeof dialog.showOpenDialog
  }, folder)
  await page.getByRole('button', { name: 'Choose folder…' }).click()
  await page.getByRole('button', { name: 'Create journal' }).click()
  const today = page.getByRole('region', { name: 'Today' })
  await expect(today).toBeVisible()
  // No recap button while AI is off.
  await expect(today.getByRole('button', { name: 'Recap this week' })).toHaveCount(0)

  const pad = (value: number) => String(value).padStart(2, '0')
  const day = (offset: number) => {
    const at = new Date()
    at.setDate(at.getDate() - offset)
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  }
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(folder, rel)), { recursive: true })
    writeFileSync(join(folder, rel), text)
  }
  write(
    'sessions/a.md',
    sessionFile(
      'aaaa00000001',
      'Hands',
      day(2),
      '## What I practised\n\nGesture hands.\n\n## Private\n\nMy secret plans.\n',
    ),
  )
  write(
    'sessions/b.md',
    sessionFile('bbbb00000001', 'Light', day(0), '## What I learned\n\nRim light reads.\n'),
  )
  await expect(
    page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('button', { name: 'Light', exact: true }),
  ).toBeVisible()

  await rail(page, 'Settings').click()
  await aiSwitch(page).click()
  await rail(page, 'Journal').click()
  const listing = () => readdirSync(join(folder, 'sessions')).sort()
  const before = listing()
  await page
    .getByRole('region', { name: 'Today' })
    .getByRole('button', { name: 'Recap this week' })
    .click()
  const draft = page.getByRole('region', { name: 'Recap draft' })
  await expect(draft.getByTestId('recap-text')).toContainText('Gesture hands.')
  await expect(draft.getByTestId('recap-text')).toContainText('Rim light reads.')
  await expect(draft.getByTestId('recap-text')).not.toContainText('secret')
  await expect(draft).toContainText('Built from: Hands, Light')
  // Nothing written yet.
  await page.waitForTimeout(1000)
  expect(listing()).toEqual(before)

  await draft.getByRole('button', { name: 'Save as session note' }).click()
  await expect(page.getByRole('textbox', { name: 'Entry title', exact: true })).toHaveValue(
    `${day(0)} Weekly recap`,
  )
  const added = listing().filter((name) => !before.includes(name))
  expect(added).toHaveLength(1)
  const saved = readFileSync(join(folder, 'sessions', added[0] ?? ''), 'utf8')
  expect(saved).toMatch(/^ai_generated: true$/m)
  expect(saved).toMatch(/^source_sessions: \[aaaa00000001, bbbb00000001\]$/m)
  expect(saved).toContain('Gesture hands.')

  // A topic offers a recap too.
  await page.getByRole('button', { name: 'New entry in Topics' }).click()
  await page.getByRole('textbox', { name: 'New entry title' }).fill('Anatomy')
  await page.getByRole('textbox', { name: 'New entry title' }).press('Enter')
  await expect(
    page.getByTestId('topic-progress').getByRole('button', { name: 'Recap this topic' }),
  ).toBeVisible()
  // The log records the recap, not its text.
  const log = mainLog(appData)
  expect(log).toContain('[ai] recap started')
  expect(log).not.toContain('Gesture hands')
})

test('the real local model tags 5 images (runs only when a model folder is given)', async () => {
  const modelsDir = testSetting('E2E_MODELS_DIR')
  test.skip(!modelsDir, 'Set LOAM_E2E_MODELS_DIR to a folder with the downloaded model to run this')
  test.setTimeout(300_000)
  const appData = join(root, 'appdata')
  const { app, page } = await launchApp(appData, { LOAM_MODELS_DIR: modelsDir ?? '' })
  await recordNetwork(app)
  await importImages(page, 5)
  await rail(page, 'Settings').click()
  await expect(page.getByTestId('model-status')).toHaveText('Downloaded')
  await aiSwitch(page).click()
  await rail(page, 'Library').click()
  await expect(progress(page)).toContainText('Tag suggestions: all 5 images looked at', {
    timeout: 240_000,
  })
  await page.getByTestId('ref-card').first().click()
  await expect(
    page
      .getByRole('complementary', { name: 'Reference detail' })
      .getByTestId('suggested-tag')
      .first(),
  ).toBeVisible()
  const log = mainLog(appData)
  expect(log).toMatch(/\[ai\] model loaded in \d+ ms/)
  // The model runs on 127.0.0.1 only.
  const outbound = (await networkLog(app)).filter((line) => !line.includes('127.0.0.1'))
  expect(outbound).toEqual([])
  // Turning AI off frees the model.
  await rail(page, 'Settings').click()
  await aiSwitch(page).click()
  await expect.poll(() => llamaServerRunning(), { timeout: 5000 }).toBe(false)
})
