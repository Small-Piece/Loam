import { useState } from 'react'
import { useImageIntake, type IncomingFile } from '../board/useImageIntake.ts'

const ALSO_LIBRARY_KEY = 'loam.journal.alsoLibrary'

function readAlsoLibrary(): boolean {
  try {
    return localStorage.getItem(ALSO_LIBRARY_KEY) !== 'false'
  } catch {
    return true
  }
}

/**
 * On a journal session: images dropped from Explorer anywhere on the window,
 * or pasted, become practice images. "Also add to Library" (on by default,
 * remembered) imports them into the Library too.
 */
export function PracticeIntake({
  onImages,
}: {
  onImages: (files: IncomingFile[], alsoLibrary: boolean) => void
}) {
  const [alsoLibrary, setAlsoLibrary] = useState(readAlsoLibrary)
  const dragging = useImageIntake((files) => onImages(files, alsoLibrary))
  return (
    <label className={'practice-intake' + (dragging ? ' dragging' : '')}>
      <input
        type="checkbox"
        checked={alsoLibrary}
        onChange={(event) => {
          const next = event.target.checked
          setAlsoLibrary(next)
          try {
            localStorage.setItem(ALSO_LIBRARY_KEY, String(next))
          } catch {
            // Not remembered; harmless.
          }
        }}
      />
      Also add to Library
      <span className="bible-muted">
        {dragging ? ' · drop to add practice images' : ' · drop or paste images'}
      </span>
    </label>
  )
}
