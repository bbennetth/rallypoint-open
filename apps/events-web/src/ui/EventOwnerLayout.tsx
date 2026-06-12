import { useCallback, useEffect, useState } from 'react'
import { Outlet, useNavigate, useParams } from 'react-router-dom'
import { AppChrome } from './AppChrome.js'
import { ApiError, getEvent, type EventDto } from '../lib/api.js'

// Phase 2 of platform/v-1.1 (#16). Wraps every `/events/:slug/*` route
// in the owner-side chrome with an event-scoped sidebar (back-link +
// event name + tab strip). Loads the event once at the layout level
// and shares it with child routes via `<Outlet context={...}>`; child
// routes use `useEventOutlet()` (below) to read the event and the
// `reload()` callback without re-fetching.

export interface EventOutlet {
  event: EventDto
  reload: () => Promise<void>
  userId: string
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; event: EventDto }
  | { status: 'error'; code: string; message: string }

export function EventOwnerLayout({ userId }: { userId: string }) {
  const { slug } = useParams<{ slug: string }>()
  const navigate = useNavigate()
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  const load = useCallback(async () => {
    if (!slug) return
    try {
      const event = await getEvent(slug)
      setState({ status: 'ready', event })
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setState({ status: 'error', code: 'not_found', message: 'Event not found.' })
        return
      }
      setState({
        status: 'error',
        code: err instanceof ApiError ? err.code : 'unexpected_error',
        message: err instanceof Error ? err.message : 'Unexpected error.',
      })
    }
  }, [slug])

  useEffect(() => {
    void load()
  }, [load])

  if (state.status === 'loading') {
    return (
      <AppChrome>
        <main className="page-pad">
          <p className="text-sm text-white/60">Loading event…</p>
        </main>
      </AppChrome>
    )
  }

  if (state.status === 'error') {
    if (state.code === 'not_found') {
      // Belt-and-suspenders: bounce to My Events; the page may still
      // briefly flash, which is fine — error UX would block the click.
      void navigate('/me/events', { replace: true })
    }
    return (
      <AppChrome>
        <main className="page-pad">
          <p className="text-sm text-white/80">{state.message}</p>
        </main>
      </AppChrome>
    )
  }

  const { event } = state

  // #440: the owner tab shell is for owners/editors. A viewer-role
  // user deep-linking /events/:slug gets bounced to their attendee
  // destination (group shell when they're in a group, else solo).
  if (event.viewer_role === 'viewer') {
    void navigate(
      event.my_group_id ? `/groups/${event.my_group_id}` : `/events/${event.slug}/attending/now`,
      { replace: true },
    )
    return null
  }

  return (
    <AppChrome eventContext={{ slug: event.slug, name: event.name, features: event.features }}>
      <Outlet context={{ event, reload: load, userId } satisfies EventOutlet} />
    </AppChrome>
  )
}
