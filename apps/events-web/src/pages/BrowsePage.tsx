import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAsyncTask } from '@rallypoint/web-kit'
import {
  ApiError,
  joinEvent,
  listBrowsableEvents,
  type BrowseEventDto,
  type BrowseEventListPage,
} from '../lib/api.js'
import { formatEventDay } from '../lib/date-format.js'
import {
  browseEventAction,
  eventAttendDecisionHref,
  eventPreviewHref,
  isSystemEvent,
} from '../lib/browse-route.js'

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; page: BrowseEventListPage }
  | { status: 'error'; error: ApiError | Error }

function formatDate(d: string | null): string {
  return formatEventDay(d, 'medium')
}

// Discovery list (#browse-tab): system-owned + public events, joinable
// without an invite. Mirrors MyEventsPage's list/pagination shell.
export function BrowsePage() {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [loadingMore, setLoadingMore] = useState(false)
  const [joiningId, setJoiningId] = useState<string | null>(null)
  const [joinError, setJoinError] = useState<string | null>(null)
  const navigate = useNavigate()
  const run = useAsyncTask()

  async function load() {
    setState({ status: 'loading' })
    await run(async (ctx) => {
      try {
        const page = await listBrowsableEvents()
        if (ctx.stale()) return
        setState({ status: 'ready', page })
      } catch (err) {
        if (ctx.stale()) return
        setState({ status: 'error', error: err instanceof Error ? err : new Error(String(err)) })
      }
    })
  }

  useEffect(() => {
    void load()
  }, [])

  async function handleLoadMore() {
    if (state.status !== 'ready' || !state.page.next_cursor) return
    setLoadingMore(true)
    try {
      const next = await listBrowsableEvents({ cursor: state.page.next_cursor })
      setState({
        status: 'ready',
        page: {
          items: [...state.page.items, ...next.items],
          next_cursor: next.next_cursor,
        },
      })
    } catch (err) {
      setState({ status: 'error', error: err instanceof Error ? err : new Error(String(err)) })
    } finally {
      setLoadingMore(false)
    }
  }

  async function handleJoin(event: BrowseEventDto) {
    if (joiningId) return
    setJoiningId(event.id)
    setJoinError(null)
    try {
      const { event_slug } = await joinEvent(event.id)
      void navigate(eventAttendDecisionHref(event_slug))
    } catch (err) {
      setJoinError(err instanceof ApiError ? err.message : 'Could not join this event.')
      setJoiningId(null)
    }
  }

  return (
    <main className="page-pad">
      <div className="content-cap mx-auto space-y-6">
        <div className="pg-head">
          <div>
            <span className="eyebrow">Rallypoint Events</span>
            <h1 style={{ marginTop: 6 }}>Browse</h1>
          </div>
        </div>

        <p className="text-sm" style={{ color: 'var(--ink-dim)' }}>
          Public and featured events anyone can join.
        </p>

        {state.status === 'loading' && <p className="text-white/60 text-sm">Loading…</p>}

        {state.status === 'error' && (
          <div
            className="p-4"
            style={{
              background: 'var(--hot-soft)',
              color: 'var(--hot-text)',
              borderRadius: 'var(--radius-lg)',
            }}
          >
            <p className="text-sm" style={{ color: 'var(--ink)' }}>
              {state.error instanceof ApiError
                ? `${state.error.code}: ${state.error.message}`
                : state.error.message}
            </p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-3 text-sm text-[color:var(--ink)] underline"
            >
              Try again
            </button>
          </div>
        )}

        {state.status === 'ready' && state.page.items.length === 0 && (
          <div className="p-6 text-center text-white/60 text-sm pl-card">
            Nothing to browse yet — check back soon.
          </div>
        )}

        {joinError && (
          <p className="text-sm" style={{ color: 'var(--hot)' }}>
            {joinError}
          </p>
        )}

        {state.status === 'ready' && state.page.items.length > 0 && (
          <ul className="ev-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {state.page.items.map((event) => {
              const action = browseEventAction(event)
              return (
                <li key={event.id} className="ev-listitem">
                  <div className="body">
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        justifyContent: 'space-between',
                        gap: 12,
                        flexWrap: 'wrap',
                      }}
                    >
                      <div style={{ minWidth: 0, display: 'grid', gap: 8 }}>
                        <div
                          style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
                        >
                          <Link
                            to={eventPreviewHref(event.slug)}
                            className="title"
                            style={{ textDecoration: 'none' }}
                          >
                            {event.name}
                          </Link>
                          {event.location_label && (
                            <span className="meta">{event.location_label}</span>
                          )}
                        </div>
                        <div
                          style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}
                        >
                          {isSystemEvent(event) ? (
                            <span className="pl-chip accent">Featured</span>
                          ) : (
                            <span className="pl-chip">{event.privacy_mode}</span>
                          )}
                          {event.viewer_role !== null && (
                            <span className="pl-chip">{event.viewer_role}</span>
                          )}
                          {(event.start_date || event.end_date) && (
                            <span className="meta">
                              {formatDate(event.start_date)}
                              {event.end_date && event.end_date !== event.start_date
                                ? ` – ${formatDate(event.end_date)}`
                                : ''}
                            </span>
                          )}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                        <Link
                          to={eventPreviewHref(event.slug)}
                          className="btn-ghost"
                          style={{ width: 'auto' }}
                        >
                          Preview
                        </Link>
                        {action.kind === 'join' ? (
                          <button
                            type="button"
                            disabled={joiningId !== null}
                            onClick={() => void handleJoin(event)}
                            className="btn-brutal"
                            style={{ width: 'auto' }}
                          >
                            {joiningId === event.id ? 'Joining…' : 'Join'}
                          </button>
                        ) : (
                          <Link to={action.href} className="btn-brutal" style={{ width: 'auto' }}>
                            Open
                          </Link>
                        )}
                      </div>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        {state.status === 'ready' && state.page.next_cursor && (
          <div className="text-center">
            <button
              type="button"
              disabled={loadingMore}
              onClick={() => void handleLoadMore()}
              className="btn-ghost"
              style={{ width: 'auto' }}
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </main>
  )
}
