import { normalizeTags } from './rules.ts'
import type { ReferenceService } from './service.ts'
import type { ReferenceDetail } from './types.ts'

/** A tag a local model suggested for a reference, not yet accepted. */
export interface TagSuggestionRow {
  tag: string
  confidence: number
}

/** Where suggestions live: apart from real tags, so search and filters never see them. */
export interface SuggestionRepository {
  openSuggestions(refId: number): TagSuggestionRow[]
  reject(refId: number, tag: string): void
  remove(refId: number, tags: readonly string[]): void
}

/**
 * Accepting and rejecting tag suggestions. An accepted suggestion becomes a
 * normal tag (through the same rules as typed tags); a rejected one is
 * remembered and never suggested again for that image.
 */
export class SuggestionService {
  private readonly references: ReferenceService
  private readonly suggestions: SuggestionRepository

  constructor(deps: { references: ReferenceService; suggestions: SuggestionRepository }) {
    this.references = deps.references
    this.suggestions = deps.suggestions
  }

  list(refId: number): TagSuggestionRow[] {
    return this.suggestions.openSuggestions(refId)
  }

  /** Makes these suggestions real tags; null when the reference does not exist. */
  accept(refId: number, tags: readonly string[]): ReferenceDetail | null {
    const detail = this.references.getDetail(refId)
    if (!detail) return null
    const open = new Set(this.suggestions.openSuggestions(refId).map((item) => item.tag))
    const chosen = tags.filter((tag) => open.has(tag))
    if (chosen.length === 0) return detail
    const updated = this.references.update(refId, {
      tags: normalizeTags([...detail.tags, ...chosen]),
    })
    this.suggestions.remove(refId, chosen)
    return updated
  }

  reject(refId: number, tag: string): void {
    this.suggestions.reject(refId, tag)
  }
}
