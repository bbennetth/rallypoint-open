import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Button, EmptyState } from '@rallypoint/ui'
import { ApiError, getEvent, type EventDto } from '../../lib/api.js'

// Phase 4 of platform/v-1.1 (#16). Landed at by a viewer-role
// attendee right after they accept an event invite (see
// EventJoinPage's role-aware redirect). Shows the event identity +
// dates + a "what's next?" decision:
//   - Join or create a group  → /groups/join (existing flow)
//   - Continue solo          → /events/:slug/attending/now
//
// The solo flow is fully usable on its own; groups are an optional
// social layer attendees form among themselves. This page exists so
// that decision is explicit rather than buried in a fallthrough.

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; event: EventDto }
  | { status: 'error'; message: string }

export function AttendingLandingPage() {
  const { slug } = useParams<{ slug: string }>()
  const navigate = useNavigate()
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    if (!slug) return
    let cancelled = false
    void getEvent(slug)
      .then((event) => {
        if (!cancelled) setState({ status: 'ready', event })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 404) {
          void navigate('/me/events', { replace: true })
          return
        }
        setState({
          status: 'error',
          message: err instanceof ApiError ? err.message : 'Failed to load event.',
        })
      })
    return () => {
      cancelled = true
    }
  }, [slug, navigate])

  if (state.status === 'loading') {
    return (
      <main className="page-pad">
        <p className="text-sm text-white/60">Loading event…</p>
      </main>
    )
  }

  if (state.status === 'error') {
    return (
      <main className="page-pad">
        <EmptyState title="Couldn't load event" body={state.message} />
      </main>
    )
  }

  const { event } = state
  const countdown = formatCountdown(event.start_date)

  return (
    <main className="page-pad">
      <div className="max-w-xl mx-auto space-y-5">
        <header className="space-y-1">
          <p className="text-xs font-medium" style={{ color: 'var(--acid)' }}>
            You're in
          </p>
          <h1 className="display text-2xl">{event.name}</h1>
          <p className="text-white/60 text-sm">
            {dateRange(event.start_date, event.end_date)}
            {event.location_label ? ` · ${event.location_label}` : ''}
          </p>
          {countdown && (
            <p
              className="mono"
              style={{
                fontSize: 10,
                letterSpacing: '0.14em',
                color: 'var(--ink-mute)',
                textTransform: 'uppercase',
              }}
            >
              {countdown}
            </p>
          )}
        </header>

        <section className="space-y-3">
          <h2 className="text-sm text-white/80">What's next?</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Link to="/groups/join" style={{ textDecoration: 'none' }}>
              <DecisionCard
                title="Join or create a group →"
                body="Groups are how friends plan together at events — shared chat, rallies, lists, and a ledger."
              />
            </Link>
            <Link
              to={`/events/${encodeURIComponent(event.slug)}/attending/now`}
              style={{ textDecoration: 'none' }}
            >
              <DecisionCard
                title="Continue solo →"
                body="See the lineup, sessions, and weather without joining a group. You can join one later."
              />
            </Link>
          </div>
        </section>

        <div className="flex items-center gap-3">
          <Button variant="ghost" onClick={() => void navigate('/me/events')}>
            Not this one — back to my events
          </Button>
        </div>
      </div>
    </main>
  )
}

function DecisionCard({ title, body }: { title: string; body: string }) {
  return (
    <div
      className="p-4 space-y-2 hover:bg-white/10 transition-colors"
      style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
    >
      <h3 className="display" style={{ fontSize: 15, letterSpacing: '0.02em' }}>
        {title}
      </h3>
      <p className="text-xs text-white/60 leading-relaxed">{body}</p>
    </div>
  )
}

function dateRange(start: string | null, end: string | null): string {
  if (!start && !end) return 'Date TBA'
  if (start && end && start !== end) return `${start} → ${end}`
  return start ?? end ?? 'Date TBA'
}

function formatCountdown(start: string | null): string | null {
  if (!start) return null
  const startDate = new Date(`${start}T00:00:00`)
  if (Number.isNaN(startDate.getTime())) return null
  const diff = startDate.getTime() - Date.now()
  if (diff <= 0) return null
  const days = Math.ceil(diff / (24 * 60 * 60 * 1000))
  if (days === 1) return 'Starts tomorrow'
  return `Starts in ${days} days`
}
