import { describe, expect, it } from 'vitest'
import { canCreate, existingTag, tagOptions, tagToAdd } from './tagPicker.ts'

const all = [
  { name: 'forest', count: 9 },
  { name: 'creature', count: 4 },
  { name: 'scary creature', count: 7 },
  { name: 'crest', count: 4 },
  { name: 'cave', count: 2 },
  { name: 'secret', count: 1 },
]
const names = (options: Array<{ name: string }>) => options.map((option) => option.name)

describe('tag picker options', () => {
  it('lists every tag not on the reference, most used first, when nothing is typed', () => {
    expect(names(tagOptions(all, ['cave'], ''))).toEqual([
      'forest',
      'scary creature',
      'creature',
      'crest',
      'secret',
    ])
  })

  it('filters anywhere in the name, case-insensitively; names starting with the text come first', () => {
    // Starting with "cre": creature and crest (4 each: by name); then containing it, by count.
    expect(names(tagOptions(all, [], 'CRE'))).toEqual([
      'creature',
      'crest',
      'scary creature',
      'secret',
    ])
    expect(names(tagOptions(all, [], '  scary   cre '))).toEqual(['scary creature'])
  })

  it('never offers tags already on the reference, in any case', () => {
    expect(names(tagOptions(all, ['Creature', 'crest'], 'cre'))).toEqual([
      'scary creature',
      'secret',
    ])
  })
})

describe('adding typed text', () => {
  it('uses the existing spelling when the text names a tag in another case', () => {
    expect(existingTag(all, 'FOREST')).toEqual({ name: 'forest', count: 9 })
    expect(tagToAdd(all, ' Scary  Creature ')).toBe('scary creature')
  })

  it('keeps new text as typed (spaces tidied) and ignores empty text', () => {
    expect(existingTag(all, 'moss')).toBeNull()
    expect(tagToAdd(all, ' wet  moss ')).toBe('wet moss')
    expect(tagToAdd(all, '   ')).toBeNull()
  })

  it('offers "Create" only for text that names no tag and is not on the reference', () => {
    expect(canCreate(all, [], 'moss')).toBe(true)
    expect(canCreate(all, [], 'Forest')).toBe(false)
    expect(canCreate(all, ['moss'], 'MOSS')).toBe(false)
    expect(canCreate(all, [], '  ')).toBe(false)
  })
})
