import { Link } from 'react-router-dom'
import { useEventOutlet } from './_event-outlet.js'

export function PreviewPage() {
  const { event } = useEventOutlet()
  const attendeeHref = `/events/${encodeURIComponent(event.slug)}/attending`

  return (
    <main className="page-pad">
      <div className="max-w-3xl mx-auto space-y-5">
        <header className="space-y-1">
          <p
            className="text-xs font-medium"
            style={{ color: 'var(--acid)' }}
          >
            Preview
          </p>
          <h1 className="display text-2xl">{event.name}</h1>
          <p className="text-white/60 text-sm mt-1">
            See your event from an attendee&rsquo;s point of view.
          </p>
        </header>

        <section
          style={{
            border: '1.5px solid var(--line)',
            background: 'var(--surface-2)',
            padding: 20,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          <div>
            <p
              className="text-xs font-medium"
              style={{ color: 'var(--ink-dim)' }}
            >
              Attendee experience
            </p>
            <h2 className="display text-lg" style={{ marginTop: 6 }}>
              Solo attendee shell
            </h2>
          </div>
          <p className="text-sm" style={{ color: 'var(--ink-dim)', lineHeight: 1.5 }}>
            Opens the in-event shell a member sees before they&rsquo;ve joined
            a group: the Now feed and My Day driven by your event&rsquo;s
            lineup, plus Group / Rallies / Chat tabs rendered as empty-
            state CTAs that invite them to join or create a group.
          </p>
          <p className="text-sm" style={{ color: 'var(--ink-mute)', lineHeight: 1.5 }}>
            Groups themselves stay private to their members &mdash; the
            preview reflects what an attendee sees, not what&rsquo;s inside
            any group.
          </p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Link to={attendeeHref} className="btn-brutal" style={{ width: 'auto' }}>
              View as attendee
            </Link>
          </div>
        </section>
      </div>
    </main>
  )
}
