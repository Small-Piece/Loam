import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { drop, makeImageTransfer } from './fixtures.ts'
import { setWindowContentSize } from '../support/windowSize.ts'
import { assertBuilt, launchApp } from './launch.ts'

// Temp data folder only.
let localAppData: string
let app: ElectronApplication | null = null

test.beforeAll(() => {
  assertBuilt()
})

test.beforeEach(() => {
  localAppData = mkdtempSync(join(tmpdir(), 'loam-e2e-tags-'))
})

test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = null
  rmSync(localAppData, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

async function invoke<T>(page: Page, channel: string, payload: unknown): Promise<T> {
  const reply = (await page.evaluate(([name, body]) => window.loam.invoke(name, body), [
    channel,
    payload,
  ] as const)) as { ok: boolean; data: T; error?: unknown }
  if (!reply.ok) throw new Error(`${channel}: ${JSON.stringify(reply.error)}`)
  return reply.data
}

/** Tag rows in the database whose name is this, in any case. */
function tagRows(name: string): number {
  const db = new DatabaseSync(join(localAppData, 'Loam', 'loam.db'), { readOnly: true })
  try {
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM tags WHERE lower(name) = lower(?)')
      .get(name) as { n: number }
    return row.n
  } finally {
    db.close()
  }
}

test('the tag input offers existing Library tags: pick, case match, create, keyboard', async () => {
  app = await launchApp(localAppData)
  const page = await app.firstWindow()
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'All references' })).toBeVisible()

  // Five references: four tagged in the Library, one only in the Trash, and the one we tag.
  await drop(
    page,
    await makeImageTransfer(
      page,
      [1, 2, 3, 4, 5].map((index) => ({ index, width: 640, height: 400 })),
    ),
  )
  await expect(page.getByTestId('ref-card')).toHaveCount(5)
  const { items } = await invoke<{ items: Array<{ id: number }> }>(page, 'refs:listBoard', {
    boardId: null,
    inTrash: false,
    tags: [],
    text: '',
  })
  const [first, second, third, trashed, target] = items.map((item) => item.id)
  const tag = (id: number | undefined, title: string, tags: string[]) =>
    invoke(page, 'refs:update', { id, title, tags })
  await tag(first, 'First', ['creature', 'forest'])
  await tag(second, 'Second', ['creature', 'creepy light'])
  await tag(third, 'Third', ['cave', 'secret door'])
  await tag(trashed, 'Gone', ['crest'])
  await tag(target, 'Target', [])
  await invoke(page, 'refs:delete', { ids: [trashed] })
  // A board holding only the reference we tag: the other tags are used outside it.
  const { board } = await invoke<{ board: { id: number } }>(page, 'boards:create', {
    name: 'Scenes',
  })
  await invoke(page, 'refs:update', { id: target, boardIds: [board.id] })
  await invoke(page, 'boards:setViewMode', { boardId: board.id, mode: 'grid' })
  await page.reload()

  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await page
    .getByRole('navigation', { name: 'Boards' })
    .getByRole('button', { name: /^Scenes/ })
    .click()
  await page.getByRole('button', { name: 'Target', exact: true }).click()
  const detail = page.getByRole('complementary', { name: 'Reference detail' })
  const input = detail.getByRole('combobox', { name: 'Add tag' })
  const list = page.getByRole('listbox', { name: 'Existing tags' })
  const options = list.getByRole('option')

  // Focus opens the list: every Library tag, used outside this board too; not the Trash's.
  await input.focus()
  await expect(list).toBeVisible()
  await expect(input).toHaveAttribute('aria-expanded', 'true')
  await expect(options).toHaveText([
    /^creature\s*2$/,
    /^cave\s*1$/,
    /^creepy light\s*1$/,
    /^forest\s*1$/,
    /^secret door\s*1$/,
  ])
  const box = await list.boundingBox()
  const viewport =
    page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
  expect(box && box.y >= 0 && box.y + box.height <= viewport.height).toBe(true)

  // Typing "cre" filters (names starting with it first) and offers to create "cre".
  await input.pressSequentially('cre')
  await expect(options).toHaveText([/^creature/, /^creepy light/, /^secret door/, 'Create "cre"'])
  // ↓ highlights the first; Enter adds it and saves at once.
  await page.keyboard.press('ArrowDown')
  await expect(options.first()).toHaveAttribute('aria-selected', 'true')
  await expect(input).toHaveAttribute(
    'aria-activedescendant',
    (await options.first().getAttribute('id')) ?? '',
  )
  await page.keyboard.press('Enter')
  await expect(detail.getByRole('button', { name: 'Remove tag creature' })).toBeVisible()
  await expect(input).toHaveValue('')
  await expect
    .poll(
      async () =>
        (await invoke<{ detail: { tags: string[] } }>(page, 'refs:getDetail', { id: target }))
          .detail.tags,
    )
    .toEqual(['creature'])

  // A tag already on the reference is not offered again.
  await input.pressSequentially('cre')
  await expect(options).toHaveText([/^creepy light/, /^secret door/, 'Create "cre"'])

  // Esc closes the list and keeps the text; ↓ opens it again; ↑ back to no highlight.
  await page.keyboard.press('Escape')
  await expect(list).toHaveCount(0)
  await expect(input).toHaveValue('cre')
  await expect(detail).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await expect(list).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  await expect(list.locator('[aria-selected="true"]')).toHaveCount(0)

  // An existing tag typed in another case adds the existing spelling; no second row.
  await input.fill('FOREST')
  await expect(options).toHaveText([/^forest/])
  await page.keyboard.press('Enter')
  await expect(detail.getByRole('button', { name: 'Remove tag forest' })).toBeVisible()
  expect(tagRows('forest')).toBe(1)

  // A new tag: by the Create row (mouse) and by Enter with nothing highlighted.
  await input.fill('wet moss')
  await expect(options.last()).toHaveText('Create "wet moss"')
  await options.last().click()
  await expect(detail.getByRole('button', { name: 'Remove tag wet moss' })).toBeVisible()
  await expect(input).toBeFocused()
  await input.fill('fog')
  await page.keyboard.press('Enter')
  await expect(detail.getByRole('button', { name: 'Remove tag fog' })).toBeVisible()
  await expect
    .poll(async () =>
      (
        await invoke<{ detail: { tags: string[] } }>(page, 'refs:getDetail', { id: target })
      ).detail.tags.sort(),
    )
    .toEqual(['creature', 'fog', 'forest', 'wet moss'])

  // With no room below the input, the list opens upward and stays inside the window.
  const inputBox = await input.boundingBox()
  await setWindowContentSize(app, {
    width: 1100,
    height: Math.ceil((inputBox?.y ?? 600) + (inputBox?.height ?? 30) + 60),
  })
  await input.scrollIntoViewIfNeeded()
  await input.fill('')
  await input.blur()
  await input.focus()
  await expect(list).toBeVisible()
  await expect
    .poll(async () => {
      const field = await input.boundingBox()
      const shown = await list.boundingBox()
      const height = await page.evaluate(() => window.innerHeight)
      if (!field || !shown) return 'missing'
      return shown.y + shown.height <= field.y + 1 &&
        shown.y >= 0 &&
        shown.y + shown.height <= height
        ? 'above, inside the window'
        : `list ${shown.y}..${shown.y + shown.height}, input at ${field.y}, window ${height}`
    })
    .toBe('above, inside the window')

  // Tab moves on as normal and closes the list.
  await input.pressSequentially('ca')
  await expect(list).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(input).not.toBeFocused()
  await expect(list).toHaveCount(0)
})
