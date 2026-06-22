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
        <header className="space-y-1">
          <p className="text-xs font-medium" style={{ color: 'var(--acid)' }}>
            Overview
          </p>
          <h1 className="display text-2xl">{event.name}</h1>
          {event.description && (
            <p className="text-white/80 text-sm leading-relaxed">{event.description}</p>
          )}
        </header>

        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
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
  const inner = (
    <div
      className="p-3 space-y-1"
      style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
    >
      <div
        className="mono"
        style={{
          fontSize: 9,
          letterSpacing: '0.14em',
          color: 'var(--ink-mute)',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
      <div className="text-sm text-white/85 truncate">{value}</div>
    </div>
  )
  return href ? (
    <Link to={href} style={{ textDecoration: 'none' }}>
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
        className="p-4 space-y-2 hover:bg-white/10 transition-colors"
        style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
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
