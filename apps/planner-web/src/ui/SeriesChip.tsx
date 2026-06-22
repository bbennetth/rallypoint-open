import { resolveSeries, type ResolvedSeries, type SeriesSurface } from '../lib/series-lookup.js'
import { Icon } from './icons.js'

// Inline recurring marker for a task/chore row. Renders a type badge
// ("Repeats" for a task series, "Chore" for a chore series) and, when the
// series is resolvable from the lookup, an "Edit series" button that opens the
// editor. Used on My Day roll-up rows and in the Upcoming feed.
//
// `surface` drives the badge label and is supplied by the caller (which knows
// the row's list), so the label stays correct even when the series isn't in the
// lookup — e.g. a chore whose series fetch is still pending or failed. The
// lookup only gates whether the "Edit series" button appears.
//
// Click/keydown stop propagation so activating the edit button never also
// triggers the row's open-detail handler.

export function SeriesChip({
  seriesId,
  surface,
  lookup,
  onEdit,
}: {
  seriesId: string
  surface: SeriesSurface
  lookup: Map<string, ResolvedSeries>
  onEdit: (resolved: ResolvedSeries) => void
}) {
  const resolved = resolveSeries(lookup, seriesId)
  const label = surface === 'chores' ? 'Chore' : 'Repeats'
  return (
    <>
      <span
        className="pl-chip repeat"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
      >
        <Icon name="repeat" size={10} />
        {label}
      </span>
      {resolved && (
        <span
          className="pl-chip"
          role="button"
          tabIndex={0}
          title="Edit series"
          aria-label={`Edit ${label.toLowerCase()} series`}
          onClick={(e) => {
            e.stopPropagation()
            onEdit(resolved)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              e.stopPropagation()
              onEdit(resolved)
            }
          }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}
        >
          <Icon name="sliders" size={10} />
          Edit series
        </span>
      )}
    </>
  )
}
