import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ApiError,
  listEvents,
  listEventPlannerPrefs,
  restoreEvent,
  setEventPlannerPref,
  type EventDto,
  type EventListPage,
} from '../lib/api.js'

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; page: EventListPage }
  | { status: 'error'; error: ApiError | Error }

function formatDate(d: string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString(undefined, { dateStyle: 'medium' })
}

export function MyEventsPage() {
  const [showDeleted, setShowDeleted] = useState(false)
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [loadingMore, setLoadingMore] = useState(false)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  // Per-user "show in Planner" flags — a Set of event ids the current
  // user has toggled on. Loaded once on mount; updated optimistically.
  const [plannerSet, setPlannerSet] = useState<Set<string>>(new Set())
  const [plannerError, setPlannerError] = useState<string | null>(null)
  // Event ids whose planner toggle has an in-flight request — guards
  // against a rapid double-click firing two concurrent, racing PUTs.
  const [plannerBusy, setPlannerBusy] = useState<Set<string>>(new Set())

  async function load(includeDeleted: boolean) {
    setState({ status: 'loading' })
    try {
      const page = await listEvents({ includeDeleted })
      setState({ status: 'ready', page })
    } catch (err) {
      setState({ status: 'error', error: err instanceof Error ? err : new Error(String(err)) })
    }
  }

  async function loadPlannerPrefs() {
    try {
      const ids = await listEventPlannerPrefs()
      setPlannerSet(new Set(ids))
    } catch {
      // Non-fatal: prefs simply appear unset on error.
      setPlannerSet(new Set())
    }
  }

  async function handlePlannerToggle(eventId: string, e: React.MouseEvent | React.ChangeEvent) {
    // Prevent the parent <Link> from navigating.
    e.stopPropagation()
    if ('preventDefault' in e) e.preventDefault()

    // Ignore re-entrant toggles while this event's request is in flight.
    if (plannerBusy.has(eventId)) return

    const next = !plannerSet.has(eventId)
    // Optimistic update.
    setPlannerSet((prev) => {
      const copy = new Set(prev)
      if (next) copy.add(eventId)
      else copy.delete(eventId)
      return copy
    })
    setPlannerError(null)
    setPlannerBusy((prev) => new Set(prev).add(eventId))

    try {
      await setEventPlannerPref(eventId, next)
    } catch (err) {
      // Revert on failure.
      setPlannerSet((prev) => {
        const copy = new Set(prev)
        if (next) copy.delete(eventId)
        else copy.add(eventId)
        return copy
      })
      setPlannerError(err instanceof ApiError ? err.message : 'Could not update Planner preference.')
    } finally {
      setPlannerBusy((prev) => {
        const copy = new Set(prev)
        copy.delete(eventId)
        return copy
      })
    }
  }

  useEffect(() => {
    void load(showDeleted)
    void loadPlannerPrefs()
  }, [showDeleted])

  async function handleLoadMore() {
    if (state.status !== 'ready' || !state.page.next_cursor) return
    setLoadingMore(true)
    try {
      const next = await listEvents({
        includeDeleted: showDeleted,
        cursor: state.page.next_cursor,
      })
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

  async function handleRestore(event: EventDto) {
    setRestoringId(event.id)
    try {
      await restoreEvent(event.id)
      await load(showDeleted)
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Restore failed.')
    } finally {
      setRestoringId(null)
    }
  }

  return (
    <main className="page-pad">
      <div className="content-cap mx-auto space-y-6">
        <header className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="text-xs font-medium text-[color:var(--ink-mute)]">
              Rallypoint Events
            </p>
            <h1 className="display text-2xl mt-1">My Events</h1>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <Link to="/events/join" className="btn-ghost" style={{ width: 'auto' }}>
              Join event
            </Link>
            <Link to="/groups/join" className="btn-ghost" style={{ width: 'auto' }}>
              Join group
            </Link>
            <Link to="/events/new" className="btn-brutal" style={{ width: 'auto' }}>
              New event
            </Link>
          </div>
        </header>

        <label className="flex items-center gap-2 text-sm text-white/60 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(e) => setShowDeleted(e.target.checked)}
            style={{ accentColor: 'var(--acid)' }}
          />
          Show deleted events
        </label>

        {state.status === 'loading' && <p className="text-white/60 text-sm">Loading…</p>}

        {state.status === 'error' && (
          <div
            className="p-4"
            style={{
              border: '1.5px solid var(--hot)',
              background: 'color-mix(in srgb, var(--hot) 12%, transparent)',
            }}
          >
            <p className="text-sm" style={{ color: 'var(--ink)' }}>
              {state.error instanceof ApiError
                ? `${state.error.code}: ${state.error.message}`
                : state.error.message}
            </p>
            <button
              type="button"
              onClick={() => void load(showDeleted)}
              className="mt-3 text-sm text-[color:var(--ink)] underline"
            >
              Try again
            </button>
          </div>
        )}

        {state.status === 'ready' && state.page.items.length === 0 && (
          <div
            className="p-6 text-center text-white/60 text-sm"
            style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
          >
            No events yet.{' '}
            <Link to="/events/new" className="text-[color:var(--ink)] underline">
              Create your first event.
            </Link>
          </div>
        )}

        {plannerError && (
          <p className="text-sm" style={{ color: 'var(--hot)' }}>
            {plannerError}
          </p>
        )}

        {state.status === 'ready' && state.page.items.length > 0 && (
          <ul className="space-y-3">
            {state.page.items.map((event) => (
              <li
                key={event.id}
                className="flex items-stretch"
                style={{
                  border: '1.5px solid var(--line)',
                  background: 'var(--surface)',
                  opacity: event.deleted_at ? 0.6 : 1,
                }}
              >
                <div className="flex-1 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Link
                          to={`/events/${event.slug}`}
                          className="font-medium hover:opacity-70 transition-opacity"
                        >
                          {event.name}
                        </Link>
                        <span className="mono text-xs text-white/40">{event.slug}</span>
                        {event.deleted_at && (
                          <span className="chip" style={{ color: 'var(--hot)' }}>
                            deleted
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-white/60 flex-wrap">
                        <span className="capitalize">{event.privacy_mode}</span>
                        <span className="capitalize text-[color:var(--ink-mute)]">{event.viewer_role}</span>
                        {(event.start_date || event.end_date) && (
                          <span>
                            {formatDate(event.start_date)}
                            {event.end_date && event.end_date !== event.start_date
                              ? ` – ${formatDate(event.end_date)}`
                              : ''}
                          </span>
                        )}
                      </div>
                    </div>
                    {event.deleted_at && event.viewer_role === 'owner' && (
                      <button
                        type="button"
                        disabled={restoringId === event.id}
                        onClick={() => void handleRestore(event)}
                        className="btn-ghost shrink-0"
                        style={{ width: 'auto' }}
                      >
                        {restoringId === event.id ? 'Restoring…' : 'Restore'}
                      </button>
                    )}
                  </div>
                </div>
                {event.scope_type === 'group' && !event.deleted_at && (
                  <label
                    className="flex items-center gap-1.5 px-3 cursor-pointer text-xs"
                    style={{ color: 'var(--ink-dim)', borderLeft: '1px solid var(--line)' }}
                    title={plannerSet.has(event.id) ? 'Remove from Planner' : 'Show in Planner'}
                  >
                    <input
                      type="checkbox"
                      checked={plannerSet.has(event.id)}
                      disabled={plannerBusy.has(event.id)}
                      onChange={(e) => void handlePlannerToggle(event.id, e)}
                      aria-label={`Show "${event.name}" in Planner`}
                      className="cyber-checkbox"
                    />
                    <span className="whitespace-nowrap">Planner</span>
                  </label>
                )}
              </li>
            ))}
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
