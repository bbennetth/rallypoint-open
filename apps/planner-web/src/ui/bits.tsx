import type { ReactNode } from 'react'
import { Icon } from './icons.js'

// Small presentational primitives shared across the Planner surfaces. Ported
// from the design handoff (pages.jsx). Priority maps the Lists string values
// ('high' | 'medium'/'med' | 'low') onto Ink tags; anything else renders
// nothing.

type Priority = string | null | undefined

function normPriority(p: Priority): 'high' | 'med' | 'low' | null {
  if (!p) return null
  const v = p.toLowerCase()
  if (v === 'high') return 'high'
  if (v === 'med' || v === 'medium') return 'med'
  if (v === 'low') return 'low'
  return null
}

const PRI_STYLE: Record<'high' | 'med' | 'low', { label: string; color: string; border: string }> = {
  high: { label: 'HIGH', color: 'var(--hot)', border: 'var(--hot)' },
  med: { label: 'MED', color: 'var(--acid)', border: 'var(--acid)' },
  low: { label: 'LOW', color: 'var(--ink-mute)', border: 'var(--line)' },
}

export function PriTag({ p }: { p: Priority }) {
  const key = normPriority(p)
  if (!key) return null
  const s = PRI_STYLE[key]
  return (
    <span className="pl-pritag" style={{ color: s.color, borderColor: s.border }}>
      {s.label}
    </span>
  )
}

export function DoneBtn({ done, onClick, busy }: { done: boolean; onClick: () => void; busy?: boolean }) {
  return (
    <button
      type="button"
      className={'pl-donebtn' + (done ? ' is-done' : '')}
      onClick={onClick}
      disabled={busy}
      aria-pressed={done}
    >
      <Icon name="check" size={11} />
      {done ? 'Done' : 'Mark done'}
    </button>
  )
}

export function Check({ done, onClick, sz = 20 }: { done: boolean; onClick: () => void; sz?: number }) {
  return (
    <button
      type="button"
      className={'pl-check' + (done ? ' done' : '')}
      onClick={onClick}
      aria-pressed={done}
      style={{ width: sz, height: sz, flex: `0 0 ${sz}px` }}
    >
      {done && (
        <span style={{ color: 'var(--accent-ink)', display: 'flex' }}>
          <Icon name="check" size={Math.round(sz * 0.62)} stroke={2} />
        </span>
      )}
    </button>
  )
}

// Owner-only deep-link to edit a group (festival) event in RP Events. Planner
// never edits these events inline — when the actor owns the event (server-
// stamped `owned`), this pencil opens the RP Events settings page in a new tab.
// Renders nothing when the RP Events origin isn't configured (no target).
export function EventEditPencil({ slug }: { slug: string }) {
  const base = import.meta.env.VITE_EVENTS_WEB_URL
  if (!base) return null
  return (
    <button
      type="button"
      className="pl-btn ghost"
      style={{ padding: '5px 7px' }}
      title="Edit in RP Events"
      aria-label="Edit in RP Events"
      onClick={() =>
        window.open(
          `${base}/events/${encodeURIComponent(slug)}/settings`,
          '_blank',
          'noopener,noreferrer',
        )
      }
    >
      <Icon name="pencil" size={13} />
    </button>
  )
}

export function EyeRow({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="pl-eyerow">
      <span className="eyebrow">{children}</span>
      <span className="ln" />
      {trailing}
    </div>
  )
}
