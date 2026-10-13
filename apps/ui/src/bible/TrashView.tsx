import { useState } from 'react'
import type { TrashItemData } from '@loam/protocol'
import { ConfirmDialog } from '../board/ConfirmDialog.tsx'

interface Props {
  items: readonly TrashItemData[]
  onRestore: (item: TrashItemData) => void
  onPurge: (item: TrashItemData) => void
}

function when(iso: string | null): string {
  if (!iso) return 'unknown'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleString()
}

/** The vault's .trash folder: restore or delete for good. */
export function TrashView({ items, onRestore, onPurge }: Props) {
  const [purging, setPurging] = useState<TrashItemData | null>(null)
  return (
    <section className="trash-view" aria-label="Bible trash">
      <header className="pillars-head">
        <div>
          <div className="s-eyebrow">Trash</div>
          <h1 className="board-title">Deleted entries and sections</h1>
          <p className="bible-muted">
            They are in the bible&apos;s <span className="mono">.trash</span> folder until you
            delete them for good.
          </p>
        </div>
      </header>
      {items.length === 0 ? (
        <p className="bible-muted">The trash is empty.</p>
      ) : (
        <table className="trash-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>From</th>
              <th>Deleted</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.trashPath} data-trash-path={item.trashPath}>
                <td>
                  <span className="trash-kind">
                    {item.kind === 'section' ? 'Section' : 'Entry'}
                  </span>{' '}
                  {item.name}
                  {item.kind === 'section' && (
                    <span className="bible-muted">
                      {' '}
                      ({item.entryCount} {item.entryCount === 1 ? 'entry' : 'entries'})
                    </span>
                  )}
                </td>
                <td className="mono">
                  {item.kind === 'entry'
                    ? (item.sectionName ?? item.from.split('/')[0])
                    : 'Sections'}
                  <span className="bible-muted"> · {item.from}</span>
                </td>
                <td>{when(item.deletedAt)}</td>
                <td className="trash-actions">
                  <button
                    type="button"
                    className="btn"
                    aria-label={`Restore ${item.name}`}
                    onClick={() => onRestore(item)}
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    className="btn danger-outline"
                    aria-label={`Delete ${item.name} permanently`}
                    onClick={() => setPurging(item)}
                  >
                    Delete permanently
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {purging && (
        <ConfirmDialog
          title={`Delete “${purging.name}” permanently?`}
          message={
            purging.kind === 'section'
              ? `The section folder and its ${purging.entryCount} ${purging.entryCount === 1 ? 'entry' : 'entries'} are deleted from disk. This cannot be undone (unless the bible is in git).`
              : 'The file is deleted from disk. This cannot be undone (unless the bible is in git).'
          }
          confirmLabel="Delete permanently"
          onConfirm={() => {
            const item = purging
            setPurging(null)
            onPurge(item)
          }}
          onCancel={() => setPurging(null)}
        />
      )}
    </section>
  )
}
