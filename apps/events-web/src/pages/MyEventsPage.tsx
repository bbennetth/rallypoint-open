import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAsyncTask } from '@rallypoint/web-kit'
import { useMobileViewport } from '@rallypoint/ui'
import {
  ApiError,
  listEvents,
  listEventPlannerPrefs,
  restoreEvent,
  setEventPlannerPref,
  type EventDto,
  type EventListPage,
} from '../lib/api.js'
import { formatEventDay } from '../lib/date-format.js'
import { canManageEvent, eventHomeHref, eventOwnerHref } from '../lib/attendee-route.js'

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; page: EventListPage }
  | { status: 'error'; error: ApiError | Error }

// start_date / end_date are date-only calendar days — render them as the day
// they name, not a viewer-shifted one. See lib/date-format.formatEventDay.
function formatDate(d: string | null): string {
  return formatEventDay(d, 'medium')
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
  // Drives where a row tap goes: on a phone every event opens the
  // attendee experience, owners included (see eventHomeHref). Reactive
  // so the links re-target on rotate/resize rather than going stale.
  const mobile = useMobileViewport()

  const run = useAsyncTask()
  // Separate gate: the planner-prefs fetch is independent of the events load,
  // so it must not cancel it (and vice versa).
  const runPrefs = useAsyncTask()

  async function load(includeDeleted: boolean) {
    setState({ status: 'loading' })
    await run(async (ctx) => {
      try {
        const page = await listEvents({ includeDeleted })
        if (ctx.stale()) return
        setState({ status: 'ready', page })
      } catch (err) {
        if (ctx.stale()) return
        setState({ status: 'error', error: err instanceof Error ? err : new Error(String(err)) })
      }
    })
  }

  async function loadPlannerPrefs() {
    await runPrefs(async (ctx) => {
      try {
        const ids = await listEventPlannerPrefs()
        if (ctx.stale()) return
        setPlannerSet(new Set(ids))
      } catch {
        // Non-fatal: prefs simply appear unset on error.
        if (ctx.stale()) return
        setPlannerSet(new Set())
      }
    })
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
        {/* Ink kit's `.pg-head` shell — eyebrow + display-font H1 +
            right-aligned action row. Replaces the prior ad-hoc Tailwind
            flex header. */}
        <div className="pg-head">
          <div>
            <span className="eyebrow">Rallypoint Events</span>
            <h1 style={{ marginTop: 6 }}>My Events</h1>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
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
        </div>

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 13,
            color: 'var(--ink-dim)',
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(e) => setShowDeleted(e.target.checked)}
            className="cyber-checkbox"
          />
          Show deleted events
        </label>

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
              onClick={() => void load(showDeleted)}
              className="mt-3 text-sm text-[color:var(--ink)] underline"
            >
              Try again
            </button>
          </div>
        )}

        {state.status === 'ready' && state.page.items.length === 0 && (
          <div
            className="p-6 text-center text-white/60 text-sm pl-card"
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
          // Ink kit's `.ev-list` of `.ev-listitem` rows. Each row's
          // body is `.body`, the row title is `.title`, privacy / role
          // are real `.pl-chip` / `.pl-chip.accent` chips, and the
          // group-scoped Planner toggle sits in `.planner-toggle` as a
          // bordered mono-uppercase right cell.
          <ul className="ev-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {state.page.items.map((event) => (
              <li
                key={event.id}
                className="ev-listitem"
                style={{ opacity: event.deleted_at ? 0.6 : 1 }}
              >
                <div className="body">
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0, display: 'grid', gap: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <Link
                          to={eventHomeHref(event, { mobile })}
                          className="title"
                          style={{ textDecoration: 'none' }}
                        >
                          {event.name}
                        </Link>
                        <span className="meta">{event.slug}</span>
                        {event.deleted_at && (
                          <span className="pl-chip" style={{ background: 'var(--hot-soft)', color: 'var(--hot-text)' }}>
                            DELETED
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <span className="pl-chip">{event.privacy_mode}</span>
                        <span
                          className={
                            'pl-chip' +
                            (event.viewer_role === 'owner' ? ' accent' : '')
                          }
                        >
                          {event.viewer_role}
                        </span>
                        {/* On mobile the row title opens the attendee
                            experience, so this is how an organizer gets
                            to the management tabs. It matters most for
                            group members, whose attendee shell
                            (/groups/:id) has no route back at all. */}
                        {mobile && !event.deleted_at && canManageEvent(event.viewer_role) && (
                          <Link
                            to={eventOwnerHref(event.slug)}
                            // `toggle` for the interactive chip size +
                            // press feedback, `accent` so the action
                            // doesn't read flatter than the static role
                            // chip beside it. Sized to --control-h-sm,
                            // not --tap-min: at 44px the pill stretches
                            // around unchanged 9.5px text and stops
                            // reading as part of this chip family (a
                            // 1.5:1 box among 2.6:1 neighbours). ~65x28
                            // clears the WCAG 24px floor with room, and
                            // by position this is a row-trailing action
                            // even though it matters more than most.
                            className="pl-chip toggle accent"
                            style={{ minHeight: 'var(--control-h-sm)', textDecoration: 'none' }}
                            aria-label={`Manage "${event.name}"`}
                          >
                            Manage
                          </Link>
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
                    {event.deleted_at && event.viewer_role === 'owner' && (
                      <button
                        type="button"
                        disabled={restoringId === event.id}
                        onClick={() => void handleRestore(event)}
                        className="btn-ghost"
                        style={{ width: 'auto', flexShrink: 0 }}
                      >
                        {restoringId === event.id ? 'Restoring…' : 'Restore'}
                      </button>
                    )}
                  </div>
                </div>
                {event.scope_type === 'group' && !event.deleted_at && (
                  <label
                    className="planner-toggle"
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
                    Planner
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
