import type { CSSProperties } from 'react'

// Lightweight skeleton placeholders for Planner loading states. Purely
// presentational — render pulsing blocks sized to approximate the loaded
// content so swapping the real content in causes (near-)zero layout shift,
// replacing the old one-line "Loading…" text that let pages lurch on load.
// Planner-local (only Planner uses these); the `.pl-skel` pulse lives in
// index.css.

export function SkeletonBlock({
  height = 16,
  width = '100%',
  radius = 0,
  style,
}: {
  height?: number | string
  width?: number | string
  radius?: number
  style?: CSSProperties
}) {
  return (
    <div className="pl-skel" aria-hidden style={{ height, width, borderRadius: radius, ...style }} />
  )
}

// A vertical stack of equal-height skeleton rows, sized to mirror a list of
// cards/rows. `label` feeds the accessible busy status. Pass `bare` when this
// is nested inside an outer `role="status"` wrapper (e.g. a composite skeleton
// that also has SkeletonBlocks) — it drops the inner live region so screen
// readers announce the busy state once, not twice (nested live regions are
// invalid ARIA).
export function SkeletonRows({
  count = 3,
  height = 52,
  gap = 8,
  label = 'Loading…',
  bare = false,
  style,
}: {
  count?: number
  height?: number
  gap?: number
  label?: string
  bare?: boolean
  style?: CSSProperties
}) {
  const rows = Array.from({ length: count }, (_, i) => <SkeletonBlock key={i} height={height} />)
  const liveProps = bare ? {} : { role: 'status', 'aria-busy': true, 'aria-label': label }
  return (
    <div {...liveProps} style={{ display: 'grid', gap, ...style }}>
      {rows}
    </div>
  )
}
