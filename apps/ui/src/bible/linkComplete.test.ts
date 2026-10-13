import { describe, expect, it } from 'vitest'
import { completeLink, openLinkQuery, rankTitles } from './linkComplete.ts'

describe('link autocomplete', () => {
  it('finds an open [[ on the caret line', () => {
    expect(openLinkQuery('See [[Ab', 8)).toEqual({ start: 6, query: 'Ab' })
    expect(openLinkQuery('See [[', 6)).toEqual({ start: 6, query: '' })
    expect(openLinkQuery('See [[Ashfall]] now', 17)).toBeNull()
    expect(openLinkQuery('[[x\nnext line', 13)).toBeNull()
    expect(openLinkQuery('[[a|alias', 9)).toBeNull()
  })

  it('completes the title and closes the link, or steps over an existing ]]', () => {
    expect(completeLink('See [[Ab', 8, 6, 'The Ashfall')).toEqual({
      text: 'See [[The Ashfall]]',
      caret: 19,
    })
    expect(completeLink('See [[Ab]] now', 8, 6, 'The Ashfall')).toEqual({
      text: 'See [[The Ashfall]] now',
      caret: 19,
    })
  })

  it('ranks titles that start with the query before ones that contain it', () => {
    expect(rankTitles(['The Ashfall', 'Ashfall Edge', 'Rowan', 'Ashen dock'], 'as', 3)).toEqual([
      'Ashen dock',
      'Ashfall Edge',
      'The Ashfall',
    ])
  })
})
