import { TagIcon } from '../icons.tsx'

interface Props {
  tags: Array<{ name: string; count: number }>
  selected: string[]
  onToggle: (tag: string) => void
  onClear: () => void
}

/** Tag chips; selecting several narrows results to references carrying all of them. */
export function TagFilter({ tags, selected, onToggle, onClear }: Props) {
  // A selected tag stays visible even when nothing in this board carries it any more.
  const shown = [
    ...tags,
    ...selected
      .filter((name) => !tags.some((tag) => tag.name === name))
      .map((name) => ({ name, count: 0 })),
  ]
  if (shown.length === 0) {
    return (
      <div className="tag-filter">
        <span className="tag-filter-hint">
          <TagIcon /> Tags you add to references appear here as filters.
        </span>
      </div>
    )
  }
  return (
    <div className="tag-filter" role="group" aria-label="Filter by tag">
      <TagIcon className="tag-filter-icon" />
      {shown.map((tag) => {
        const active = selected.includes(tag.name)
        return (
          <button
            key={tag.name}
            type="button"
            className={'tag-chip' + (active ? ' active' : '')}
            aria-pressed={active}
            onClick={() => onToggle(tag.name)}
          >
            {tag.name}
            <span className="tag-chip-count mono">{tag.count}</span>
          </button>
        )
      })}
      {selected.length > 0 && (
        <button type="button" className="btn ghost tag-filter-clear" onClick={onClear}>
          Clear filters
        </button>
      )}
    </div>
  )
}
