import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { drop, makeImageTransfer } from './fixtures.ts'
import { assertBuilt, launchApp as launch } from './launch.ts'

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url))

let localAppData: string
let running: ElectronApplication[] = []

async function launchApp(): Promise<Page> {
  const app = await launch(localAppData)
  running.push(app)
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'All references' })).toBeVisible()
  return page
}

async function closeAll(): Promise<void> {
  for (const app of running) await app.close().catch(() => undefined)
  running = []
}

test.beforeAll(() => {
  assertBuilt()
})

test.beforeEach(() => {
  localAppData = mkdtempSync(join(tmpdir(), 'loam-e2e-s4-'))
})

test.afterEach(async () => {
  await closeAll()
  rmSync(localAppData, { recursive: true, force: true })
})

interface View {
  items: Array<{ referenceId: number; x: number; y: number; groupId: number | null }>
  groups: Array<{ id: number; title: string; locked: boolean }>
  notes: Array<{
    id: number
    text: string
    fontSize: string
    color: string
    width: number | null
    attachedReferenceId: number | null
  }>
}

async function canvasView(page: Page, boardId: number): Promise<View> {
  const reply = (await page.evaluate(
    (id) => window.loam.invoke('canvas:get', { boardId: id }),
    boardId,
  )) as { ok: boolean; data: View }
  return reply.data
}

/** A board with `count` images dropped onto its canvas, fitted to the view. */
async function boardWithImages(page: Page, count: number): Promise<number> {
  await page.getByRole('button', { name: 'New board' }).click()
  await page.getByRole('textbox', { name: 'New board name' }).fill('Zone 2')
  await page.getByRole('textbox', { name: 'New board name' }).press('Enter')
  await expect(page.getByTestId('canvas')).toBeVisible()
  const specs = Array.from({ length: count }, (_, index) => ({
    index: index + 1,
    width: 800,
    height: 600,
  }))
  await drop(page, await makeImageTransfer(page, specs))
  await expect(page.getByTestId('canvas-item')).toHaveCount(count)
  await page.getByTestId('canvas').click({ position: { x: 4, y: 300 } })
  await page.keyboard.press('f')
  return 1
}

const items = (page: Page) => page.getByTestId('canvas-item')
const notes = (page: Page) => page.getByTestId('canvas-note')
const groups = (page: Page) => page.getByTestId('canvas-group')

async function rects(page: Page, testId: string): Promise<string[]> {
  return page.getByTestId(testId).evaluateAll((elements) =>
    elements
      .map((element) => {
        const r = element.getBoundingClientRect()
        const id =
          (element as HTMLElement).dataset['refId'] ?? (element as HTMLElement).dataset['noteId']
        return `${id}:${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`
      })
      .sort(),
  )
}

async function dragBy(
  page: Page,
  from: { x: number; y: number },
  dx: number,
  dy: number,
  shift = false,
) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 4 })
  if (shift) await page.keyboard.down('Shift')
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 })
  await page.mouse.up()
  if (shift) await page.keyboard.up('Shift')
}

/** Creates a note by double-clicking empty canvas and typing. */
async function addNote(page: Page, at: { x: number; y: number }, text: string) {
  const count = await notes(page).count()
  await page.mouse.dblclick(at.x, at.y)
  await expect(page.getByRole('textbox', { name: 'Note text' })).toBeFocused()
  await page.keyboard.type(text)
  await page.keyboard.press('Escape')
  await expect(notes(page)).toHaveCount(count + 1)
}

async function emptySpot(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId('canvas').boundingBox()
  if (!box) throw new Error('no canvas')
  return { x: box.x + box.width - 60, y: box.y + box.height - 80 }
}

test('backup: one before migrating a schema-4 database, none on the next start, five kept', async () => {
  // A database at schema 4, as the previous release left it.
  const dataDir = join(localAppData, 'Loam')
  const backups = join(dataDir, 'backups')
  mkdirSync(backups, { recursive: true })
  const db = new DatabaseSync(join(dataDir, 'loam.db'))
  for (const name of [
    '0001_init.sql',
    '0002_references.sql',
    '0003_trash.sql',
    '0004_board_items.sql',
  ]) {
    db.exec(readFileSync(join(migrationsDir, name), 'utf8'))
  }
  db.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '4')")
  db.close()
  // Six older backups, plus a file of the user's that must survive pruning.
  for (let day = 1; day <= 6; day++) {
    writeFileSync(
      join(backups, `loam-3-202609${String(day).padStart(2, '0')}T120000000Z.db`),
      'old',
    )
  }
  writeFileSync(join(backups, 'readme.txt'), 'mine')

  const page = await launchApp()
  await expect(page.getByRole('heading', { name: 'All references' })).toBeVisible()
  await closeAll()
  const afterFirst = readdirSync(backups)
    .filter((name) => name.endsWith('.db'))
    .sort()
  expect(afterFirst).toHaveLength(5)
  const fresh = afterFirst.filter((name) => name.startsWith('loam-4-'))
  expect(fresh).toHaveLength(1)
  expect(readdirSync(backups)).toContain('readme.txt')
  const log = readFileSync(join(dataDir, 'logs', 'main.log'), 'utf8')
  expect(log).toContain(`backed up the database to ${join(backups, fresh[0]!)} before migrating`)
  expect(log).toMatch(/schema version 4 before, 11 after migrating/)
  const copy = new DatabaseSync(join(backups, fresh[0]!), { readOnly: true })
  expect(copy.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
    value: '4',
  })
  copy.close()

  await launchApp()
  await closeAll()
  expect(
    readdirSync(backups)
      .filter((name) => name.endsWith('.db'))
      .sort(),
  ).toEqual(afterFirst)
  const migrated = new DatabaseSync(join(dataDir, 'loam.db'), { readOnly: true })
  // Migrated all the way to the latest schema.
  expect(migrated.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
    value: '11',
  })
  migrated.close()
})

test('group 10 images, move the group, restart: every child where it was, to the pixel', async () => {
  const page = await launchApp()
  const boardId = await boardWithImages(page, 10)
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Control+g')
  await expect(groups(page)).toHaveCount(1)
  const view = await canvasView(page, boardId)
  expect(view.items.every((item) => item.groupId === view.groups[0]?.id)).toBe(true)

  // Drag the group by its title band.
  const title = await page.getByTestId('group-title').boundingBox()
  if (!title) throw new Error('no title')
  const before = await rects(page, 'canvas-item')
  await dragBy(page, { x: title.x + 10, y: title.y + title.height / 2 }, 140, 70)
  await expect.poll(() => rects(page, 'canvas-item')).not.toEqual(before)
  const moved = await rects(page, 'canvas-item')
  // Every child moved by the same amount.
  const shift = (a: string, b: string) => {
    const [, pa] = a.split(':')
    const [, pb] = b.split(':')
    const [ax, ay] = pa!.split(',').map(Number)
    const [bx, by] = pb!.split(',').map(Number)
    return `${bx! - ax!},${by! - ay!}`
  }
  const shifts = new Set(before.map((entry, index) => shift(entry, moved[index]!)))
  expect(shifts.size).toBe(1)

  await closeAll()
  const again = await launchApp()
  await again.getByRole('button', { name: /^Zone 2/ }).click()
  await expect(items(again)).toHaveCount(10)
  await expect.poll(() => rects(again, 'canvas-item')).toEqual(moved)
})

test('locked group: a click selects the group; Alt+click one child; ungroup leaves children in place', async () => {
  const page = await launchApp()
  const boardId = await boardWithImages(page, 4)
  await items(page).nth(0).click()
  await items(page)
    .nth(1)
    .click({ modifiers: ['Control'] })
  await items(page)
    .nth(2)
    .click({ modifiers: ['Control'] })
  await page.keyboard.press('Control+g')
  await expect(groups(page)).toHaveCount(1)
  await expect(groups(page)).toHaveAttribute('data-locked', 'true')

  // One click on a child selects the whole group.
  await page.getByTestId('canvas').click({ position: { x: 4, y: 300 } })
  await items(page).nth(1).click()
  await expect(groups(page)).toHaveClass(/selected/)
  await expect(page.getByTestId('canvas-selection')).toHaveText('1 selected')
  await expect(page.locator('[data-testid="canvas-item"][aria-selected="true"]')).toHaveCount(0)

  // Alt+click selects just that child.
  await items(page)
    .nth(1)
    .click({ modifiers: ['Alt'] })
  await expect(items(page).nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(groups(page)).not.toHaveClass(/selected/)

  // Double-click on a child of a locked group picks the child; a second double-click views it.
  await page.getByTestId('canvas').click({ position: { x: 4, y: 300 } })
  await items(page).nth(2).dblclick()
  await expect(items(page).nth(2)).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('dialog', { name: 'Image viewer' })).toHaveCount(0)
  await items(page).nth(2).dblclick()
  await expect(page.getByRole('dialog', { name: 'Image viewer' })).toBeVisible()
  await page.keyboard.press('Escape')

  // Ungroup: children stay exactly where they are.
  const before = await rects(page, 'canvas-item')
  await items(page).nth(0).click()
  await page.keyboard.press('Control+Shift+g')
  await expect(groups(page)).toHaveCount(0)
  expect(await rects(page, 'canvas-item')).toEqual(before)
  expect((await canvasView(page, boardId)).items.every((item) => item.groupId === null)).toBe(true)

  // A lock toggle switches whole-group selection off.
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Control+g')
  await page.getByRole('button', { name: 'Locked' }).click()
  await expect(groups(page)).toHaveAttribute('data-locked', 'false')
  await page.getByTestId('canvas').click({ position: { x: 4, y: 300 } })
  await items(page).nth(0).click()
  await expect(items(page).nth(0)).toHaveAttribute('aria-selected', 'true')
})

test('an attached note follows its image when it moves and when it leaves the board', async () => {
  const page = await launchApp()
  const boardId = await boardWithImages(page, 2)
  await addNote(page, await emptySpot(page), 'Rim light')

  // Shift-drop the note onto the first image to attach it.
  const note = await notes(page).first().boundingBox()
  const image = await items(page).first().boundingBox()
  if (!note || !image) throw new Error('missing boxes')
  await dragBy(
    page,
    { x: note.x + 8, y: note.y + 8 },
    image.x + 30 - note.x,
    image.y + 30 - note.y,
    true,
  )
  const imageId = Number(await items(page).first().getAttribute('data-ref-id'))
  await expect
    .poll(async () => (await canvasView(page, boardId)).notes[0]?.attachedReferenceId)
    .toBe(imageId)

  // Move the image: the note moves by the same amount.
  const noteBefore = await notes(page).first().boundingBox()
  const imageBox = await items(page).first().boundingBox()
  if (!noteBefore || !imageBox) throw new Error('missing boxes')
  await page.getByTestId('canvas').click({ position: { x: 4, y: 300 } })
  await dragBy(
    page,
    { x: imageBox.x + imageBox.width - 15, y: imageBox.y + imageBox.height - 15 },
    -90,
    -40,
  )
  await expect
    .poll(async () =>
      Math.round(((await notes(page).first().boundingBox())?.x ?? 0) - noteBefore.x),
    )
    .toBe(-90)
  const noteAfter = await notes(page).first().boundingBox()
  expect(Math.round((noteAfter?.y ?? 0) - noteBefore.y)).toBe(-40)

  // Remove the image from the board: the note goes with it; the image stays in the Library.
  await expect(items(page).first()).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Delete')
  await expect(items(page)).toHaveCount(1)
  await expect(notes(page)).toHaveCount(0)
  await expect(page.getByTestId('library-item')).toHaveCount(2)
  // ...and Ctrl+Z brings both back.
  await page.keyboard.press('Control+z')
  await expect(items(page)).toHaveCount(2)
  await expect(notes(page)).toHaveCount(1)
})

test('note text, size, colour and width survive a restart', async () => {
  const page = await launchApp()
  const boardId = await boardWithImages(page, 1)
  const spot = await emptySpot(page)
  await addNote(page, spot, 'Value study\nkeep the darks')
  await notes(page).first().click()
  await page.getByRole('button', { name: 'XL', exact: true }).click()
  await page.getByRole('radio', { name: 'Text colour: amber' }).click()
  await expect.poll(async () => (await canvasView(page, boardId)).notes[0]?.color).toBe('amber')

  // Fit so the grown note is fully on screen, then drag its width handle.
  await page.getByRole('button', { name: 'Fit all' }).click()
  await notes(page).first().click()
  const handle = notes(page).first().locator('[data-handle="e"]')
  const handleBox = await handle.boundingBox()
  if (!handleBox) throw new Error('no handle')
  await dragBy(
    page,
    { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 },
    -40,
    0,
  )
  await expect.poll(async () => (await canvasView(page, boardId)).notes[0]?.width).not.toBeNull()
  const saved = (await canvasView(page, boardId)).notes[0]
  expect(saved).toMatchObject({
    text: 'Value study\nkeep the darks',
    fontSize: 'XL',
    color: 'amber',
  })
  const shown = await rects(page, 'canvas-note')

  await closeAll()
  const again = await launchApp()
  await again.getByRole('button', { name: /^Zone 2/ }).click()
  await expect(notes(again)).toHaveCount(1)
  expect((await canvasView(again, boardId)).notes[0]).toEqual(saved)
  await expect.poll(() => rects(again, 'canvas-note')).toEqual(shown)
  await expect(notes(again).first()).toHaveText('Value study\nkeep the darks')
})

test('Ctrl+Z undoes group, ungroup, note create, note edit and attach, one step each', async () => {
  const page = await launchApp()
  const boardId = await boardWithImages(page, 3)
  const snapshot = async () => JSON.stringify(await canvasView(page, boardId))
  const undo = async (expected: string) => {
    await page.getByTestId('canvas').click({ position: { x: 4, y: 300 } })
    await page.keyboard.press('Control+z')
    await expect.poll(snapshot).toBe(expected)
  }

  // Group
  let before = await snapshot()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Control+g')
  await expect(groups(page)).toHaveCount(1)
  await undo(before)
  await expect(groups(page)).toHaveCount(0)

  // Ungroup
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Control+g')
  await expect(groups(page)).toHaveCount(1)
  before = await snapshot()
  await items(page).first().click()
  await page.keyboard.press('Control+Shift+g')
  await expect(groups(page)).toHaveCount(0)
  await undo(before)
  await expect(groups(page)).toHaveCount(1)

  // Note create
  before = await snapshot()
  await addNote(page, await emptySpot(page), 'first')
  await undo(before)
  await expect(notes(page)).toHaveCount(0)

  // Note edit
  await addNote(page, await emptySpot(page), 'first')
  before = await snapshot()
  await notes(page).first().dblclick()
  await expect(page.getByRole('textbox', { name: 'Note text' })).toBeFocused()
  await page.keyboard.press('End')
  await page.keyboard.type(' and second')
  await page.keyboard.press('Escape')
  await expect(notes(page).first()).toHaveText('first and second')
  await undo(before)
  await expect(notes(page).first()).toHaveText('first')

  // Attach
  before = await snapshot()
  await notes(page).first().click()
  const note = await notes(page).first().boundingBox()
  const free = await items(page).nth(2).boundingBox()
  if (!note || !free) throw new Error('missing boxes')
  // Group is locked: put the note on the group's last image; the note attaches to the image.
  await dragBy(
    page,
    { x: note.x + 6, y: note.y + 6 },
    free.x + 20 - note.x,
    free.y + 20 - note.y,
    true,
  )
  await expect
    .poll(async () => (await canvasView(page, boardId)).notes[0]?.attachedReferenceId)
    .not.toBeNull()
  await undo(before)
})
