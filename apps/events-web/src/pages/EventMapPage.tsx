import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useAsyncTask } from '@rallypoint/web-kit'
import { ApiError, getEvent, type EventDto } from '../lib/api.js'
import { MapEditor } from '../ui/MapEditor.js'
import { shouldRefetch, subscribeEventStream } from '../lib/realtime.js'

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; event: EventDto }
  | { status: 'error'; code: string; message: string }

export function EventMapPage({ userId }: { userId: string }) {
  const { slug } = useParams<{ slug: string }>()
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  // Bumped on a realtime map invalidation so the MapEditor re-fetches.
  const [mapReload, setMapReload] = useState(0)

  const run = useAsyncTask()
  const load = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!slug) return
      if (!opts.silent) setState({ status: 'loading' })
      await run(async (ctx) => {
        try {
          const event = await getEvent(slug)
          if (ctx.stale()) return
          setState({ status: 'ready', event })
        } catch (err) {
          if (ctx.stale()) return
          if (err instanceof ApiError && err.status === 404) {
            setState({ status: 'error', code: 'not_found', message: 'Event not found.' })
          } else {
            setState({
              status: 'error',
              code: err instanceof ApiError ? err.code : 'unexpected_error',
              message: err instanceof Error ? err.message : 'Unknown error.',
            })
          }
        }
      })
    },
    [slug, run],
  )

  useEffect(() => {
    void load()
  }, [load])

  // Live updates: once the event id is known, subscribe to its stream. The
  // map page only cares about map-channel envelopes (maps/pois/no_go_zones)
  // and `events` header changes; either way we bump the editor's reload.
  const eventId = state.status === 'ready' ? state.event.id : null
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    if (!eventId) return undefined
    return subscribeEventStream(eventId, {
      onEvent: (env) => {
        if (!shouldRefetch(env, userId)) return
        if (env.resource === 'events') void loadRef.current({ silent: true })
        else setMapReload((n) => n + 1)
      },
      onReconnect: () => {
        void loadRef.current({ silent: true })
        setMapReload((n) => n + 1)
      },
    })
  }, [eventId, userId])

  if (state.status === 'loading') {
    return (
      <main className="flex items-center justify-center p-8">
        <p className="text-white/60 text-sm">Loading…</p>
      </main>
    )
  }

  if (state.status === 'error') {
    return (
      <main className="flex items-center justify-center p-8">
        <div
          className="max-w-md w-full p-4"
          style={{
            background: 'var(--hot-soft)',
            borderRadius: 'var(--radius-xl)',
          }}
        >
          <h1 className="text-lg font-semibold text-white/80">
            {state.code === 'not_found' ? 'Event not found' : 'Error'}
          </h1>
          <p className="mt-2 text-sm text-white/80">{state.message}</p>
          <a href="/me/events" className="mt-4 inline-block text-sm text-[color:var(--ink)] underline hover:opacity-70">
            Back to my events
          </a>
        </div>
      </main>
    )
  }

  const { event } = state
  const canEdit = event.viewer_role === 'owner' || event.viewer_role === 'editor'

  return (
    <main className="page-pad">
      <div className="max-w-4xl mx-auto space-y-6">
        <nav>
          <a
            href={`/events/${event.slug}`}
            className="text-sm text-[color:var(--ink)] underline hover:opacity-70"
          >
            ← {event.name}
          </a>
        </nav>

        <header className="space-y-1">
          <p className="text-xs font-medium text-[color:var(--ink-mute)]">Map &amp; POIs</p>
          <h1 className="display text-2xl">{event.name}</h1>
          {!canEdit && (
            <p className="text-xs text-white/40">
              You have view-only access — editing is disabled.
            </p>
          )}
        </header>

        <MapEditor eventId={event.id} canEdit={canEdit} reloadSignal={mapReload} />
      </div>
    </main>
  )
}
