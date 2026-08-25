import { useEffect, useState } from 'react'
import { useAsyncTask } from '@rallypoint/web-kit'
import {
  ApiError,
  listCommunityAttendees,
  listGroupAttendees,
  type CommunityAttendeeDto,
} from '../lib/api.js'

// "Who's going" (#216) — attendee-visible roster of display names.
// Pass exactly one of eventId (solo shell: event-membership endpoint)
// or groupId (group shell: group-membership endpoint). The server
// 404s when the event's `attendees` feature toggle is off; the card
// renders nothing in that case so callers can mount it
// unconditionally.

type LoadState =
  | { status: 'loading' }
  | { status: 'hidden' }
  | { status: 'error'; message: string }
  | { status: 'ready'; items: CommunityAttendeeDto[] }

export function WhoIsGoingCard({ eventId, groupId }: { eventId?: string; groupId?: string }) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const run = useAsyncTask()

  useEffect(() => {
    const fetcher = groupId
      ? () => listGroupAttendees(groupId)
      : eventId
        ? () => listCommunityAttendees(eventId)
        : null
    if (!fetcher) {
      setState({ status: 'hidden' })
      return
    }
    setState({ status: 'loading' })
    void run(async (ctx) => {
      try {
        const page = await fetcher()
        if (ctx.stale()) return
        setState({ status: 'ready', items: page.items })
      } catch (err) {
        if (ctx.stale()) return
        if (err instanceof ApiError && err.status === 404) {
          // Feature off (or no access) — show nothing rather than an error.
          setState({ status: 'hidden' })
          return
        }
        setState({
          status: 'error',
          message: err instanceof ApiError ? err.message : 'Failed to load attendees.',
        })
      }
    })
  }, [eventId, groupId, run])

  if (state.status === 'hidden' || state.status === 'loading') return null
  if (state.status === 'error') {
    return (
      <p className="text-xs" style={{ color: 'var(--hot)' }}>
        {state.message}
      </p>
    )
  }

  return (
    <section
      className="p-4 space-y-3 pl-card"
    >
      <h3 className="text-xs font-medium text-[color:var(--ink-mute)]">
        Who's going ({state.items.length})
      </h3>
      {state.items.length === 0 ? (
        <p className="text-xs text-[color:var(--ink-dim)]">No attendees yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {state.items.map((a) => (
            <li
              key={a.user_id}
              className="chip text-xs"
              style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-round)', padding: '2px 8px' }}
              title={new Date(a.joined_at).toLocaleDateString()}
            >
              {a.display_name ?? 'Attendee'}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
