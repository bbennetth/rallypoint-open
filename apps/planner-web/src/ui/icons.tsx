// Planner content glyphs. The chrome icon set (Icon/IconName), the brand
// compass, and the app-switcher lockup now live in @rallypoint/ui (promoted in
// the UI-stack-wide migration). This module re-exports Icon/IconName so the
// many planner content call-sites keep importing from '../ui/icons.js', and
// keeps the two planner-only content glyphs: the My Day progress Ring and the
// ticket-stub QR placeholder.

export { Icon } from '@rallypoint/ui'
export type { IconName } from '@rallypoint/ui'

// Progress ring (My Day hero). `pct` 0-100; the arc uses the accent.
export function Ring({ pct = 0, size = 64, label = 'DONE' }: { pct?: number; size?: number; label?: string }) {
  const r = size / 2 - 5
  const c = 2 * Math.PI * r
  return (
    <div className="pl-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth="5" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--acid)"
          strokeWidth="5"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct / 100)}
          strokeLinecap="butt"
        />
      </svg>
      <div className="num">
        <b style={{ fontSize: pct >= 100 ? 14 : undefined }}>{pct}%</b>
        <span>{label}</span>
      </div>
    </div>
  )
}

// Deterministic QR-ish placeholder for ticket stubs (decorative only).
export function QR({ size = 42 }: { size?: number }) {
  const cells = 7
  const s = size / cells
  const seed = [
    1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1,
    1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1,
  ]
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      {seed.map((v, i) =>
        v ? (
          <rect
            key={i}
            x={(i % cells) * s}
            y={Math.floor(i / cells) * s}
            width={s}
            height={s}
            fill="var(--ink)"
          />
        ) : null,
      )}
    </svg>
  )
}
