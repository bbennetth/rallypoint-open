// Planner content glyphs. The chrome icon set (Icon/IconName), the brand
// compass, and the app-switcher lockup now live in @rallypoint/ui (promoted in
// the UI-stack-wide migration). This module re-exports Icon/IconName so the
// many planner content call-sites keep importing from '../ui/icons.js', and
// keeps the planner-only ticket-stub QR placeholder.

export { Icon } from '@rallypoint/ui'
export type { IconName } from '@rallypoint/ui'

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
