// Ink iconography for the Rallypoint app chrome. Ported from the Planner design
// handoff (lib.jsx): a brand compass, a thin-stroke (1.5px) square icon set, and
// the brand lockup used as the app-switcher trigger. Custom-drawn — the repo
// ships no icon font — so they live here rather than pulling a dependency.
//
// Planner-specific content glyphs (the My Day progress Ring and the ticket QR
// stub) intentionally stay in apps/planner-web; only the chrome-shared set is
// promoted here.

import type { CSSProperties, JSX } from 'react'

// Brand compass; needle + bezel dot use the live accent (--acid).
export function Compass({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <circle cx="256" cy="256" r="200" stroke="currentColor" strokeWidth="16" fill="none" />
      <line x1="256" y1="40" x2="256" y2="74" stroke="currentColor" strokeWidth="16" strokeLinecap="round" />
      <line x1="256" y1="438" x2="256" y2="472" stroke="currentColor" strokeWidth="16" strokeLinecap="round" />
      <line x1="40" y1="256" x2="74" y2="256" stroke="currentColor" strokeWidth="16" strokeLinecap="round" />
      <line x1="438" y1="256" x2="472" y2="256" stroke="currentColor" strokeWidth="16" strokeLinecap="round" />
      <line x1="408.7" y1="103.3" x2="389.5" y2="122.5" stroke="currentColor" strokeWidth="11" strokeLinecap="round" opacity="0.55" />
      <line x1="103.3" y1="103.3" x2="122.5" y2="122.5" stroke="currentColor" strokeWidth="11" strokeLinecap="round" opacity="0.55" />
      <line x1="408.7" y1="408.7" x2="389.5" y2="389.5" stroke="currentColor" strokeWidth="11" strokeLinecap="round" opacity="0.55" />
      <line x1="103.3" y1="408.7" x2="122.5" y2="389.5" stroke="currentColor" strokeWidth="11" strokeLinecap="round" opacity="0.55" />
      <polygon points="343.1,168.9 183.73,258.41 253.59,328.27" fill="var(--acid)" />
      <circle cx="397.4" cy="114.6" r="24" fill="var(--acid)" />
      <circle cx="397.4" cy="114.6" r="10" fill="var(--bg)" />
    </svg>
  )
}

export type IconName =
  | 'myday'
  | 'upcoming'
  | 'tasks'
  | 'events'
  | 'check'
  | 'plus'
  | 'clock'
  | 'pin'
  | 'repeat'
  | 'bell'
  | 'file'
  | 'download'
  | 'grid'
  | 'money'
  | 'sliders'
  | 'chevron'
  | 'pencil'
  | 'more'
  | 'cart'
  | 'trash'

const PATHS: Record<IconName, JSX.Element> = {
  myday: (
    <>
      <circle cx="8" cy="9" r="3.1" />
      <path d="M8 1.6v1.6M8 14.6v-.6M2 9H.6M15.4 9H14M3.5 4.5l-1-1M12.5 4.5l1-1M1.4 13h13.2" />
    </>
  ),
  upcoming: (
    <>
      <rect x="2" y="3" width="12" height="11" />
      <path d="M2 6.2h12M5.2 1.6v2.2M10.8 1.6v2.2" />
      <circle cx="8" cy="10" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  tasks: (
    <>
      <path d="M2 4.2h7M2 8h7M2 11.8h4.5" />
      <path d="M11 3.6l1.5 1.5L15 2.4" />
      <path d="M11.4 8.2h3M11.4 12h3" />
    </>
  ),
  events: (
    <>
      <path d="M2.5 4h11a0 0 0 0 1 0 0v2.2a1.4 1.4 0 0 0 0 2.8V11.8a0 0 0 0 1 0 0h-11a0 0 0 0 1 0 0V9a1.4 1.4 0 0 0 0-2.8V4z" />
      <path d="M9.5 4v7.8" strokeDasharray="1.4 1.4" />
    </>
  ),
  check: <path d="M2.5 8.5l3.2 3.2L13.5 4" strokeWidth="2" />,
  plus: <path d="M8 2.5v11M2.5 8h11" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.4V8l2.6 1.6" />
    </>
  ),
  pin: (
    <>
      <path d="M8 14.5s5-4.4 5-8a5 5 0 0 0-10 0c0 3.6 5 8 5 8z" />
      <circle cx="8" cy="6.5" r="1.8" />
    </>
  ),
  repeat: (
    <>
      <path d="M2.5 6.5A5 5 0 0 1 12 5.2l1.5 1.3" />
      <path d="M13.5 3v3.5H10" />
      <path d="M13.5 9.5A5 5 0 0 1 4 10.8L2.5 9.5" />
      <path d="M2.5 13V9.5H6" />
    </>
  ),
  bell: (
    <>
      <path d="M4 7a4 4 0 0 1 8 0c0 3 1.2 4 1.2 4H2.8S4 10 4 7z" />
      <path d="M6.6 13.4a1.6 1.6 0 0 0 2.8 0" />
    </>
  ),
  file: (
    <>
      <path d="M4 1.6h5L13 5.5V14.4H4z" />
      <path d="M9 1.6V5.5h4" />
    </>
  ),
  download: (
    <>
      <path d="M8 2.4v7.6M5 7.4L8 10.4l3-3" />
      <path d="M3 12.6h10" />
    </>
  ),
  grid: (
    <>
      <rect x="2.2" y="2.2" width="4.6" height="4.6" />
      <rect x="9.2" y="2.2" width="4.6" height="4.6" />
      <rect x="2.2" y="9.2" width="4.6" height="4.6" />
      <rect x="9.2" y="9.2" width="4.6" height="4.6" />
    </>
  ),
  money: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.4v7.2M9.8 6.1c-.4-.7-1.1-1-1.9-1-1 0-1.8.6-1.8 1.4 0 2 3.7 1 3.7 3 0 .9-.8 1.5-1.9 1.5-.9 0-1.6-.4-2-1.1" />
    </>
  ),
  sliders: (
    <>
      <path d="M2.5 5h7M11.5 5h2M2.5 11h2M6.5 11h7" />
      <circle cx="10" cy="5" r="1.5" />
      <circle cx="5" cy="11" r="1.5" />
    </>
  ),
  chevron: <path d="M6 3.5L10.5 8 6 12.5" />,
  pencil: (
    <>
      <path d="M2.8 13.2l.7-2.8L10.6 3.3l2.1 2.1-7.1 7.1-2.8.7z" />
      <path d="M9.3 4.6l2.1 2.1" />
    </>
  ),
  // Three-dot overflow / more-actions indicator.
  more: (
    <>
      <circle cx="4" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="8" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  // Shopping cart.
  cart: (
    <>
      <path d="M1.5 2h2l1.5 7h7l1.5-5H5" />
      <circle cx="7" cy="13" r="1" fill="currentColor" stroke="none" />
      <circle cx="11" cy="13" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  // Trash / delete.
  trash: (
    <>
      <path d="M2.5 4h11M6 4V2.6h4V4M4 4l.7 9.4a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4" />
      <path d="M6.6 6.8v4.6M9.4 6.8v4.6" />
    </>
  ),
}

export function Icon({
  name,
  size = 16,
  stroke = 1.5,
}: {
  name: IconName
  size?: number
  stroke?: number
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: `0 0 ${size}px` }}
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}

// Brand lockup: compass + two-tone "rallypt" wordmark + optional caret. Used as
// the app-switcher trigger contents. (Distinct from the older minimalist
// `BrandLockup` wordmark in this package — this is the Ink chrome lockup.)
export function AppBrandLockup({
  size = 'desktop',
  caret,
  caretOpen = false,
}: {
  size?: 'desktop' | 'mobile'
  caret?: boolean
  caretOpen?: boolean
}) {
  const cw = size === 'desktop' ? 40 : 28
  const fs = size === 'desktop' ? 30 : 22
  const caretStyle: CSSProperties = {
    color: 'var(--ink-mute)',
    display: 'flex',
    transition: 'transform .15s ease',
    transform: caretOpen ? 'rotate(180deg)' : 'none',
  }
  return (
    <>
      <span style={{ color: 'var(--ink)', display: 'flex' }}>
        <Compass size={cw} />
      </span>
      <span className="pl-wordmark" style={{ fontSize: fs }}>
        rally<b>pt</b>
      </span>
      {caret && (
        <span style={caretStyle}>
          <Icon name="chevron" size={12} />
        </span>
      )}
    </>
  )
}
