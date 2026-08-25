import { Link } from 'react-router-dom'
import { useEventOutlet } from './_event-outlet.js'
import { WeatherSection } from '../PublicEventPage.js'
import { getEventWeather } from '../../lib/api.js'
import { formatEventDay } from '../../lib/date-format.js'

// Owner-side Overview tab. At-a-glance stat cards + weather + a
// pointer to where to edit deeper config. Slim by design — most of
// the heavy editing surfaces moved to dedicated tabs (Lineup,
// Sessions, Map, Attendees, Public Page, Settings) in Phase 2.

export function OverviewPage() {
  const { event } = useEventOutlet()
  const slugUrl = `/events/${encodeURIComponent(event.slug)}`

  return (
    <main className="page-pad">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Ink kit: `.pg-head` carrying the eyebrow context tag +
            display-font H1. The eyebrow uses the live accent so it
            reads as the active owner tab. */}
        <div className="pg-head" style={{ marginBottom: 8 }}>
          <div>
            <span className="eyebrow" style={{ color: 'var(--acid)' }}>
              Overview
            </span>
            <h1 style={{ marginTop: 6 }}>{event.name}</h1>
            {event.description && (
              <p className="sub" style={{ marginTop: 8, maxWidth: '62ch' }}>
                {event.description}
              </p>
            )}
          </div>
        </div>

        {/* Kit's `.md-stats` 4-up tile row — already defined in the
            planner-web index.css. Reuses the `.pl-stat` tile shape. */}
        <section className="md-stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
          <StatCard
            label="Privacy"
            value={privacyLabel(event.privacy_mode)}
            href={`${slugUrl}/settings`}
          />
          <StatCard
            label="Dates"
            value={dateRange(event.start_date, event.end_date)}
          />
          <StatCard label="Timezone" value={event.timezone ?? '—'} />
          <StatCard
            label="Attendees"
            value="Manage →"
            href={`${slugUrl}/attendees`}
          />
        </section>

        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ActionCard
            title="Lineup"
            body="Add stages, days, artists, and slot assignments."
            href={`${slugUrl}/lineup`}
          />
          <ActionCard
            title="Sessions"
            body="Schedule sessions across the event window."
            href={`${slugUrl}/sessions`}
          />
          <ActionCard
            title="Map"
            body="Upload a venue map and place POIs."
            href={`${slugUrl}/map`}
          />
          <ActionCard
            title="Public Page"
            body="Configure what visitors see at /e/your-slug."
            href={`${slugUrl}/public`}
          />
        </section>

        <WeatherSection fetcher={() => getEventWeather(event.id)} />
      </div>
    </main>
  )
}

function StatCard({
  label,
  value,
  href,
}: {
  label: string
  value: string
  href?: string
}) {
  // Ink kit's `.pl-stat` tile: display-font value + mono-eyebrow label.
  // `.pl-stat` + `.md-stats` are defined in `apps/events-web/src/events.css`
  // (duplicated from planner-web's index.css since the apps don't share
  // a CSS bundle at runtime).
  //
  // The .pl-stat .v CSS default is 26px desktop / 18px mobile. We
  // override to 18px on every viewport here because Overview shows 4
  // tiles in a row (vs Planner's 3), so the larger display font would
  // wrap or ellipsize too aggressively on common desktop widths.
  const inner = (
    <div className="pl-stat">
      <div className="v" style={{ fontSize: 18, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {value}
      </div>
      <div className="k">{label}</div>
    </div>
  )
  return href ? (
    <Link to={href} style={{ textDecoration: 'none', color: 'inherit' }}>
      {inner}
    </Link>
  ) : (
    inner
  )
}

function ActionCard({
  title,
  body,
  href,
}: {
  title: string
  body: string
  href: string
}) {
  return (
    <Link to={href} style={{ textDecoration: 'none' }}>
      <div
        className="p-4 space-y-2 hover:bg-white/10 transition-colors pl-card"
      >
        <h2
          className="display"
          style={{ fontSize: 14, color: 'var(--ink)', letterSpacing: '0.02em' }}
        >
          {title} →
        </h2>
        <p className="text-xs text-white/60 leading-relaxed">{body}</p>
      </div>
    </Link>
  )
}

function privacyLabel(mode: string | null | undefined): string {
  switch (mode) {
    case 'public':
      return 'Public'
    case 'unlisted':
      return 'Unlisted'
    case 'private':
      return 'Private'
    default:
      return 'Unlisted'
  }
}

function dateRange(start: string | null, end: string | null): string {
  if (!start && !end) return '—'
  if (start && end && start !== end) {
    return `${formatEventDay(start, 'medium')} → ${formatEventDay(end, 'medium')}`
  }
  return formatEventDay(start ?? end, 'medium')
}
