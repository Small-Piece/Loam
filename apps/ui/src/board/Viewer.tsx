import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { assetUrl, type ReferenceCard } from '@loam/protocol'
import { XIcon } from '../icons.tsx'

interface Props {
  items: ReferenceCard[]
  index: number
  /** performance.now() of the click or key press that opened the viewer. */
  openedAt: number
  onIndexChange: (index: number) => void
  onClose: () => void
}

interface View {
  scale: number
  x: number
  y: number
}

const MAX_SCALE = 32 // 3200 %
const MIN_SCALE = 0.02
const WHEEL_SENSITIVITY = 0.0018
const LINE_HEIGHT_PX = 33
const MARGIN = 0.96

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Full-screen image viewer. Wheel zooms around the cursor, dragging pans,
 * 0 fits, 1 shows 100 %, arrow keys step through the current list, Esc or
 * Space closes. The transform is applied directly on the DOM in an animation
 * frame, so zooming never waits for React.
 */
export function Viewer({ items, index, openedAt, onIndexChange, onClose }: Props) {
  const item = items[index]
  const stage = useRef<HTMLDivElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const view = useRef<View>({ scale: 1, x: 0, y: 0 })
  const fitted = useRef(true)
  const frame = useRef(0)
  const pan = useRef<{ x: number; y: number; viewX: number; viewY: number } | null>(null)
  const [zoomLabel, setZoomLabel] = useState('')
  const [loadedHash, setLoadedHash] = useState<string | null>(null)
  const [openMs, setOpenMs] = useState<number | null>(null)

  /** Writes the current view to the image element right away. */
  const applyNow = useCallback(() => {
    const { scale, x, y } = view.current
    if (image.current) {
      image.current.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`
    }
    setZoomLabel(`${Math.round(scale * 100)}%`)
  }, [])

  /** Coalesces rapid wheel and drag updates into one write per frame. */
  const apply = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(applyNow)
  }, [applyNow])

  const fitScale = useCallback((): number => {
    const el = stage.current
    if (!el || !item) return 1
    const contain = Math.min(
      (el.clientWidth * MARGIN) / item.imageWidth,
      (el.clientHeight * MARGIN) / item.imageHeight,
    )
    return Math.min(1, contain)
  }, [item])

  /** Centers the image at the given scale. */
  const centerAt = useCallback(
    (scale: number) => {
      const el = stage.current
      if (!el || !item) return
      view.current = {
        scale,
        x: (el.clientWidth - item.imageWidth * scale) / 2,
        y: (el.clientHeight - item.imageHeight * scale) / 2,
      }
      cancelAnimationFrame(frame.current)
      applyNow()
    },
    [applyNow, item],
  )

  const fit = useCallback(() => {
    fitted.current = true
    centerAt(fitScale())
  }, [centerAt, fitScale])

  /** Zooms to a new scale keeping the stage point (px, py) fixed on screen. */
  const zoomAt = useCallback(
    (nextScale: number, px: number, py: number) => {
      const current = view.current
      const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE)
      const ratio = scale / current.scale
      view.current = { scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio }
      fitted.current = false
      apply()
    },
    [apply],
  )

  // Lay out the new image before paint, so it never flashes at the old position.
  useLayoutEffect(() => {
    fit()
  }, [fit])

  useEffect(() => {
    function onResize() {
      if (fitted.current) fit()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [fit])

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  // Decode the full image off the main thread, then show it in place of the thumbnail.
  useEffect(() => {
    if (!item) return
    let cancelled = false
    const full = new Image()
    full.src = assetUrl(item.imageHash)
    full
      .decode()
      .then(() => {
        if (cancelled) return
        setLoadedHash(item.imageHash)
        requestAnimationFrame(() => {
          if (!cancelled) setOpenMs((current) => current ?? performance.now() - openedAt)
        })
      })
      .catch(() => {
        if (!cancelled) setLoadedHash(item.imageHash)
      })
    // Warm the cache for the next image so stepping forward is instant.
    const next = items[index + 1]
    if (next) new Image().src = assetUrl(next.imageHash)
    return () => {
      cancelled = true
    }
  }, [item, items, index, openedAt])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const el = stage.current
      let handled = true
      if (event.key === 'Escape' || event.key === ' ') onClose()
      else if (event.key === '0') fit()
      else if (event.key === '1' && el) {
        zoomAt(1, el.clientWidth / 2, el.clientHeight / 2)
      } else if (event.key === 'ArrowRight' && index < items.length - 1) onIndexChange(index + 1)
      else if (event.key === 'ArrowLeft' && index > 0) onIndexChange(index - 1)
      else handled = false
      if (handled || event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        // The board below must not react to keys meant for the viewer.
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [fit, zoomAt, index, items.length, onClose, onIndexChange])

  useEffect(() => {
    const el = stage.current
    if (!el) return
    function onWheel(event: WheelEvent) {
      event.preventDefault()
      if (!el) return
      const delta = event.deltaMode === 1 ? event.deltaY * LINE_HEIGHT_PX : event.deltaY
      const rect = el.getBoundingClientRect()
      zoomAt(
        view.current.scale * Math.exp(-delta * WHEEL_SENSITIVITY),
        event.clientX - rect.left,
        event.clientY - rect.top,
      )
    }
    // Non-passive, so the page itself never scrolls or zooms underneath.
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as Element).closest('button')) return
    event.currentTarget.setPointerCapture(event.pointerId)
    pan.current = {
      x: event.clientX,
      y: event.clientY,
      viewX: view.current.x,
      viewY: view.current.y,
    }
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = pan.current
    if (!start) return
    view.current = {
      ...view.current,
      x: start.viewX + event.clientX - start.x,
      y: start.viewY + event.clientY - start.y,
    }
    fitted.current = false
    apply()
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    pan.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  if (!item) return null
  const showFull = loadedHash === item.imageHash
  return (
    <div
      className="viewer"
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      data-testid="viewer"
      data-ready={showFull}
      data-open-ms={openMs === null ? undefined : openMs.toFixed(1)}
      data-zoom={zoomLabel}
    >
      <div
        ref={stage}
        className="viewer-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <img
          ref={image}
          key={item.imageHash}
          className="viewer-image"
          // The thumbnail shows at full size immediately; the original replaces it once decoded.
          src={assetUrl(showFull ? item.imageHash : item.thumbHash)}
          width={item.imageWidth}
          height={item.imageHeight}
          alt={item.title}
          draggable={false}
        />
      </div>
      <div className="viewer-hud viewer-hud-top">
        <span className="viewer-title">{item.title}</span>
        <span className="viewer-count mono" data-testid="viewer-position">
          {index + 1} / {items.length}
        </span>
      </div>
      <div className="viewer-hud viewer-hud-bottom mono">
        <span data-testid="viewer-zoom">{zoomLabel}</span>
        <span className="viewer-keys">Wheel zoom · Drag pan · 0 fit · 1 100% · ← → · Esc</span>
      </div>
      <button type="button" className="viewer-close" aria-label="Close viewer" onClick={onClose}>
        <XIcon size={14} />
      </button>
    </div>
  )
}
