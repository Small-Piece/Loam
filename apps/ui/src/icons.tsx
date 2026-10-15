// Thin-stroke line icons (1.6px stroke).
// Only the icons the Reference Board uses are kept.
import type { ReactNode } from 'react'

export type IconProps = { size?: number; className?: string }

function Svg({
  size,
  className,
  children,
}: {
  size: number
  className?: string | undefined
  children: ReactNode
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export function PlusIcon({ size = 14, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  )
}

export function SearchIcon({ size = 14, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Svg>
  )
}

export function XIcon({ size = 12, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  )
}

export function ImageIcon({ size = 14, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="m4 18 5-5 4 4 3-3 4 4" />
    </Svg>
  )
}

export function TagIcon({ size = 12, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M20 12 12 20l-9-9V3h8z" />
      <circle cx="7" cy="7" r="1.3" fill="currentColor" />
    </Svg>
  )
}

export function FolderIcon({ size = 13, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </Svg>
  )
}

export function GridIcon({ size = 13, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </Svg>
  )
}

export function TrashIcon({ size = 13, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
    </Svg>
  )
}

export function MaximizeIcon({ size = 13, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="M21 3l-7 7" />
      <path d="M3 21l7-7" />
    </Svg>
  )
}

export function PencilIcon({ size = 12, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M15.5 4.5l4 4L8 20H4v-4z" />
      <path d="M13.5 6.5l4 4" />
    </Svg>
  )
}

export function BookIcon({ size = 14, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z" />
      <path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3" />
      <path d="M9 7h6M9 10.5h4" />
    </Svg>
  )
}

export function CalendarIcon({ size = 14, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 10h16M9 3v4M15 3v4" />
    </Svg>
  )
}

export function GearIcon({ size = 14, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M4.2 7l2.6 1.5M17.2 15.5l2.6 1.5M4.2 17l2.6-1.5M17.2 8.5l2.6-1.5" />
      <circle cx="12" cy="12" r="7" />
    </Svg>
  )
}

export function InfoIcon({ size = 14, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5v.01" />
    </Svg>
  )
}
