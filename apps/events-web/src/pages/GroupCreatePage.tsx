import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { EmptyState } from '@rallypoint/ui'
import { useAsyncTask } from '@rallypoint/web-kit'
import { ApiError, createGroup, getEvent, type EventDto } from '../lib/api.js'

// Start-a-group flow, the create half of the "Join or create a group"
// promise on AttendingLandingPage. Slug-scoped (/events/:slug/groups/new)
// because the create endpoint is event-scoped; any attendee (event
// viewer+) can start a group and becomes its owner. On success we land
// on /groups/:groupId — the group detail page re-shows the 6-char
// share code, so no one-time-code interstitial is needed here.

function createErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'group_name_taken':
        return 'A group with that name already exists at this event.'
      case 'rate_limited':
        return 'You have started a lot of groups recently — try again later.'
      default:
        return err.message
    }
  }
  return 'Could not create the group.'
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; event: EventDto }
  | { status: 'error'; message: string }

export function GroupCreatePage() {
  const { slug } = useParams<{ slug: string }>()
  const navigate = useNavigate()
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = useAsyncTask()

  useEffect(() => {
    if (!slug) return
    void run(async (ctx) => {
      try {
        const event = await getEvent(slug)
        if (ctx.stale()) return
        if (!event.features.groups) {
          void navigate(`/events/${encodeURIComponent(event.slug)}/attend`, { replace: true })
          return
        }
        setState({ status: 'ready', event })
      } catch (err) {
        if (ctx.stale()) return
        if (err instanceof ApiError && err.status === 404) {
          void navigate('/me/events', { replace: true })
          return
        }
        setState({
          status: 'error',
          message: err instanceof ApiError ? err.message : 'Failed to load event.',
        })
      }
    })
  }, [slug, navigate, run])

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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setError(null)
    setSubmitting(true)
    try {
      const group = await createGroup(event.id, { name: trimmed })
      void navigate(`/groups/${group.id}`)
    } catch (err) {
      setError(createErrorMessage(err))
      setSubmitting(false)
    }
  }

  return (
    <main className="page-pad">
      <div className="max-w-md w-full mx-auto space-y-5">
        <header className="space-y-1">
          <p className="text-xs font-medium text-[color:var(--ink-mute)]">Start a group</p>
          <h1 className="display text-2xl">Name your group</h1>
          <p className="text-sm text-white/60">
            Your circle at <strong>{event.name}</strong> — shared rallies, lists, and a
            ledger. You'll get a join code to share with friends.
          </p>
        </header>

        {error && (
          <div
            className="p-3 text-sm"
            style={{
              background: 'var(--hot-soft)',
              color: 'var(--hot-text)',
              borderRadius: 'var(--radius-lg)',
            }}
          >
            {error}
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3">
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. The Day Crew"
            aria-label="Group name"
            maxLength={100}
            className="cyber-input"
          />
          <button
            type="submit"
            disabled={submitting || !name.trim()}
            className="btn-brutal disabled:opacity-50"
          >
            {submitting ? 'Starting…' : 'Start group'}
          </button>
        </form>

        <a
          href={`/events/${encodeURIComponent(event.slug)}/attend`}
          className="inline-block text-sm text-[color:var(--ink)] underline hover:opacity-70"
        >
          ← Back to event
        </a>
      </div>
    </main>
  )
}
