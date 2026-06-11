import { useState } from 'react'
import type { GroupDayDto } from '../lib/api.js'

// Festival-planner-styled alert chip rendered at the top of My Day
// when the day-aggregator has flagged overlaps. Tap to expand an
// inline list of the offending rows; the expanded list mirrors the
// data the page already renders below, so this is purely an
// orient-yourself banner — not a resolver flow (rallypoint doesn't
// have user-persistent ignore decisions like festival-planner does).
//
// Renders nothing when `conflicts` is empty so callers can mount
// unconditionally.

interface Props {
  conflicts: GroupDayDto['conflicts']
}

export function ConflictBanner({ conflicts }: Props) {
  const [open, setOpen] = useState(false)
  if (conflicts.length === 0) return null
  const count = conflicts.length
  const noun = count === 1 ? 'conflict' : 'conflicts'
  return (
    <div
      style={{
        border: '1px solid var(--hot)',
        background: 'rgba(200,48,43,0.08)',
      }}
      className="dark:[background:rgba(226,100,96,0.14)]"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${count} ${noun} on this day`}
        style={{
          display: 'flex',
          width: '100%',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          padding: '10px 14px',
          fontSize: 13,
          fontWeight: 500,
          cursor: 'pointer',
          color: 'var(--hot)',
          background: 'transparent',
          border: 'none',
        }}
      >
        <span>{open ? 'Collapse' : `${count} ${noun}`}</span>
        <span>{open ? '↑' : '↓'}</span>
      </button>
      {open && (
        <ul className="space-y-1 p-3" style={{ borderTop: '1px solid var(--hot)' }}>
          {conflicts.map((c) => (
            <li key={`${c.kind}-${c.id}`} className="text-sm" style={{ color: 'var(--ink)' }}>
              <span
                style={{
                  color: 'var(--hot)',
                  fontSize: 11,
                  fontWeight: 500,
                  marginRight: 6,
                }}
              >
                {c.kind}
              </span>
              {c.title}{' '}
              <span style={{ color: 'var(--ink-mute)' }}>— during {c.sets.join(', ')}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
