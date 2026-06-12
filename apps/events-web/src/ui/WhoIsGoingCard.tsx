import { useEffect, useState } from 'react'
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

  useEffect(() => {
    let cancelled = false
    const fetcher = groupId
      ? () => listGroupAttendees(groupId)
      : eventId
        ? () => listCommunityAttendees(eventId)
        : null
    if (!fetcher) {
      setState({ status: 'hidden' })
      return
    }
    fetcher()
      .then((page) => {
        if (!cancelled) setState({ status: 'ready', items: page.items })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 404) {
          // Feature off (or no access) — show nothing rather than an error.
          setState({ status: 'hidden' })
          return
        }
        setState({
          status: 'error',
          message: err instanceof ApiError ? err.message : 'Failed to load attendees.',
        })
      })
    return () => {
      cancelled = true
    }
  }, [eventId, groupId])

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
      className="p-4 space-y-3"
      style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
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
              style={{ border: '1px solid var(--line)', padding: '2px 8px' }}
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
