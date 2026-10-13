import { useEffect, useRef, useState } from 'react'
import { pastedImageName } from './images.ts'

export interface IncomingFile {
  file: File
  fileName: string
}

/** Where files were dropped, in window coordinates. Pastes have no point. */
export interface DropPoint {
  clientX: number
  clientY: number
}

function hasFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') ?? false
}

/**
 * Listens for images dropped anywhere on the window and for pasted images
 * (Ctrl+V). Returns whether files are currently being dragged over the window.
 */
export function useImageIntake(
  onFiles: (files: IncomingFile[], point: DropPoint | null) => void,
): boolean {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const handler = useRef(onFiles)
  useEffect(() => {
    handler.current = onFiles
  })

  useEffect(() => {
    function onDragEnter(event: DragEvent) {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth.current += 1
      setDragging(true)
    }
    function onDragOver(event: DragEvent) {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    function onDragLeave(event: DragEvent) {
      if (!hasFiles(event)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    }
    function onDrop(event: DragEvent) {
      // Always prevent the default, so a dropped file never replaces the page.
      event.preventDefault()
      depth.current = 0
      setDragging(false)
      const files = [...(event.dataTransfer?.files ?? [])]
      if (files.length > 0) {
        const point = { clientX: event.clientX, clientY: event.clientY }
        handler.current(
          files.map((file) => ({ file, fileName: file.name })),
          point,
        )
      }
    }
    function onPaste(event: ClipboardEvent) {
      const images = [...(event.clipboardData?.files ?? [])].filter((file) =>
        file.type.startsWith('image/'),
      )
      if (images.length === 0) return
      event.preventDefault()
      const now = new Date()
      handler.current(
        images.map((file, index) => ({ file, fileName: pastedImageName(now, index) })),
        null,
      )
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    document.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
      document.removeEventListener('paste', onPaste)
    }
  }, [])

  return dragging
}
