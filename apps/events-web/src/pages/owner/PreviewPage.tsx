import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { joinAttendance, leaveAttendance } from '../../lib/api.js'
import { attendeeHomeHref } from '../../lib/attendee-route.js'
import { useEventOutlet } from './_event-outlet.js'

export function PreviewPage() {
  const { event, reload } = useEventOutlet()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Same destination My Events and the owner layout use. This used to
  // hardcode the event shell, so an owner who was in a group previewed
  // as "attending solo" instead of landing in their group.
  const attendeeHref = attendeeHomeHref(event)
  const attending = event.viewer_attending === true

  async function join(openAfter: boolean) {
    setBusy(true)
    setError(null)
    try {
      await joinAttendance(event.id)
      await reload()
      if (openAfter) void navigate(attendeeHref)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join as attendee.')
    } finally {
      setBusy(false)
    }
  }

  async function leave() {
    setBusy(true)
    setError(null)
    try {
      await leaveAttendance(event.id)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to leave attendance.')
    } finally {
      setBusy(false)
    }
  }

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

        {error && (
          <p className="text-sm" style={{ color: 'var(--hot-text)' }}>
            {error}
          </p>
        )}

        <section
          style={{
            background: 'var(--surface-2)',
            borderRadius: 'var(--radius-xl)',
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
            a group: the Now feed and Lineup driven by your event&rsquo;s
            schedule, plus Map / Group / Rallies tabs rendered as empty-
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

        <section
          style={{
            background: 'var(--surface-2)',
            borderRadius: 'var(--radius-xl)',
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
              Full participation
            </p>
            <h2 className="display text-lg" style={{ marginTop: 6 }}>
              {attending ? 'You are attending' : 'Join as attendee'}
            </h2>
          </div>
          <p className="text-sm" style={{ color: 'var(--ink-dim)', lineHeight: 1.5 }}>
            {attending
              ? 'You appear in the attendee list and can join groups and rallies like any other attendee. Leaving attendance removes you from the roster — your owner access is unaffected.'
              : 'Actually join your event: you’ll appear in the attendee list and counts, and you can join groups and rallies for real — the full attendee experience, not just a preview.'}
          </p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {attending ? (
              <>
                <Link to={attendeeHref} className="btn-brutal" style={{ width: 'auto' }}>
                  Open attendee view
                </Link>
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ width: 'auto' }}
                  onClick={() => void leave()}
                  disabled={busy}
                >
                  Leave attendance
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn-brutal"
                style={{ width: 'auto' }}
                onClick={() => void join(true)}
                disabled={busy}
              >
                Join as attendee
              </button>
            )}
          </div>
        </section>
      </div>
    </main>
  )
}
