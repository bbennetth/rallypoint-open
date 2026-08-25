import { useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  holidaysQuery,
  personalEventsQuery,
  settingsQuery,
  updateSettings,
  type HolidayDto,
  type PersonalEventDto,
} from '../lib/api.js'
import { useCachedQuery } from '../lib/offline/use-cached-query.js'
import { resolveKnownTmpId } from '../lib/offline/engine.js'
import { formatWhenShort, isPastEvent } from '../lib/events-helpers.js'
import { hiddenHolidays, holidaysEnabled, mergeEventsAndHolidays } from '../lib/holidays-helpers.js'
import { localToday } from '../lib/planner-helpers.js'
import { onCreated } from '../lib/refresh-bus.js'
import { Icon } from '../ui/icons.js'
import { SkeletonRows } from '../ui/Skeleton.js'
import { Drawer } from '@rallypoint/ui'
import { EventDetail, HolidayDetail } from '../ui/EventDetail.js'
import { PersonalEventEdit } from '../ui/PersonalEventEdit.js'
import { ACCEPT_ATTR, useEventTickets } from '../ui/useEventTickets.js'
import { openProps, stopRowOpen as stop } from '../ui/row-open.js'
import { QuickAdd } from '../ui/QuickAdd.js'

// Personal Events surface (slice 7 + Ink redesign). A thin view over the
// planner-api BFF: renders the user's personal events as a single scrolling
// chronological list — tapping a row opens the detail in a Drawer — and lets
// them create events and attach / download ticket files (images + PDF).
// All persistence lives in Events via the BFF — this page owns only view state.
// Holidays are interleaved into the list (read-only) via mergeEventsAndHolidays.
//
// The week/month calendar that used to live here (issue #547) moved to the
// standalone Calendar page; the shared EventDetail/HolidayDetail components +
// the useEventTickets hook are reused by both surfaces.

// How far ahead the list shows holidays.
const HOLIDAY_LOOKAHEAD_DAYS = 90

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

function ymd(dt: Date): string {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

export function EventsPage() {
  // Render-from-cache: paints the last-known value instantly (skeletons
  // only on a true cold cache miss) and re-renders on every cache write.
  const eventsQ = useCachedQuery(useMemo(() => personalEventsQuery(), []))
  const events = useMemo(() => eventsQ.data ?? [], [eventsQ.data])
  const [activeEventId, setActiveEventId] = useState<string | null>(null)
  // A just-created event carries a tmp id until its outbox create flushes;
  // the flush swaps the cached row to the real id. Resolve through the
  // engine's tmp→real map so the open detail drawer follows the swap
  // instead of silently closing (and tickets attach to the REAL id).
  const resolvedActiveId = activeEventId ? resolveKnownTmpId(activeEventId) : null
  const [editing, setEditing] = useState<PersonalEventDto | null>(null)
  // Holiday selected in the list → shown read-only in the detail drawer;
  // takes precedence over the active event while set.
  const [selectedHoliday, setSelectedHoliday] = useState<HolidayDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Past events are hidden by default; the list's "Show past" toggle reveals
  // them (they stay reachable — old events can carry ticket attachments).
  const [showPast, setShowPast] = useState(false)

  const loadingEvents = eventsQ.status === 'loading'
  const todayYmd = useMemo(() => localToday().date, [])

  // Ticket machinery for the active event's detail pane (load + attach + download).
  const { tickets, loadingTickets, uploading, fileInputRef, onPickFile, onDownload, triggerAttach } =
    useEventTickets(resolvedActiveId, setError)

  useEffect(() => {
    if (eventsQ.status === 'error') setError(errMessage(eventsQ.error))
  }, [eventsQ.status, eventsQ.error])

  // An event added from the global quick-add FAB shows up without a reload.
  const refetchEvents = eventsQ.refetch
  useEffect(() => onCreated('event', () => void refetchEvents()), [refetchEvents])

  // ── Holidays ──────────────────────────────────────────────────────
  // Holidays are fetched for a fixed forward window and interleaved into the
  // list (read-only). Settings (holiday prefs) drive whether the holiday
  // query runs at all — a dependent query, null until settings resolve.
  const settingsQ = useCachedQuery(useMemo(() => settingsQuery('planner'), []))
  const [plannerSettings, setPlannerSettings] = useState<Record<string, unknown>>({})
  useEffect(() => setPlannerSettings(settingsQ.data ?? {}), [settingsQ.data])

  const holidayWindow = useMemo(() => {
    const from = new Date(todayYmd)
    const to = new Date(todayYmd)
    to.setDate(to.getDate() + HOLIDAY_LOOKAHEAD_DAYS)
    return { from: ymd(from), to: ymd(to) }
  }, [todayYmd])

  const holidaysOn = holidaysEnabled(plannerSettings)
  const holidaysDataQ = useCachedQuery(
    useMemo(
      () => (holidaysOn ? holidaysQuery(holidayWindow.from, holidayWindow.to) : null),
      [holidaysOn, holidayWindow],
    ),
  )
  const [holidays, setHolidays] = useState<HolidayDto[]>([])
  useEffect(() => {
    if (!holidaysOn || !holidaysDataQ.data) {
      setHolidays([])
      return
    }
    // The BFF already filters hiddenHolidays; re-apply client-side so an
    // optimistic Hide takes effect before the next round-trip.
    const hidden = hiddenHolidays(plannerSettings)
    setHolidays(
      hidden.length > 0 ? holidaysDataQ.data.filter((h) => !hidden.includes(h.id)) : holidaysDataQ.data,
    )
  }, [holidaysOn, holidaysDataQ.data, plannerSettings])

  // Past events are dropped from the list unless the toggle is on. Day-based
  // (isPastEvent): today's earlier events don't vanish mid-day, and a
  // multi-day event stays until its last covered day has passed.
  const pastCount = useMemo(
    () => events.filter((ev) => isPastEvent(ev, todayYmd)).length,
    [events, todayYmd],
  )
  const visibleEvents = useMemo(
    () => (showPast ? events : events.filter((ev) => !isPastEvent(ev, todayYmd))),
    [events, showPast, todayYmd],
  )

  // Interleave events + holidays into one chronological list (uniform rows).
  const listRows = useMemo(
    () => mergeEventsAndHolidays(visibleEvents, holidays),
    [visibleEvents, holidays],
  )

  // Hide a holiday from the list: append to the hidden-ids setting (optimistic,
  // functional updater so rapid clicks don't read a stale list) and drop it from
  // local state. Clears any selection pointing at it.
  function hideHoliday(h: HolidayDto) {
    setPlannerSettings((s) => {
      const hidden = [...hiddenHolidays(s), h.id]
      void updateSettings('planner', { hiddenHolidays: hidden })
      return { ...s, hiddenHolidays: hidden }
    })
    setHolidays((prev) => prev.filter((x) => x.id !== h.id))
    setSelectedHoliday((cur) => (cur?.id === h.id ? null : cur))
  }

  // Resolve the active event against the VISIBLE list so a past event can't
  // occupy the detail drawer while hidden (toggling "Show past" off with a
  // past event's drawer open closes the drawer, since `open` derives from
  // this resolution).
  const activeEvent = visibleEvents.find((ev) => ev.id === resolvedActiveId) ?? null

  const detailOpen = selectedHoliday != null || activeEvent != null
  function closeDetail() {
    setActiveEventId(null)
    setSelectedHoliday(null)
  }

  return (
    <>
      <div className="pg-head pl-wide">
        <div>
          <h1>Events</h1>
        </div>
      </div>

      {error && (
        <p role="alert" style={{ color: 'var(--hot)', fontSize: 13, marginTop: 0 }}>
          {error}
        </p>
      )}

      {/* Single scrolling chronological list; row tap opens the detail drawer. */}
      <nav className="ev-list" aria-label="Events">
        {loadingEvents ? (
          <SkeletonRows count={4} height={56} label="Loading events" />
        ) : listRows.length === 0 ? (
          <p className="meta" style={{ color: 'var(--ink-mute)' }}>
            {pastCount > 0
              ? 'No upcoming events — use the + button to add one.'
              : 'No events yet — use the + button to add one.'}
          </p>
        ) : (
          listRows.map((row) => {
            // Holidays render as the same .ev-rail-item shape as events so
            // the list reads uniform. They're selectable (open a read-only
            // detail in the drawer) but never editable, and keep a quiet
            // inline Hide affordance.
            if (row.kind === 'holiday') {
              const h = row.holiday
              const active = selectedHoliday?.id === h.id
              return (
                <div
                  key={`holiday:${h.id}`}
                  className={'ev-rail-item is-holiday' + (active ? ' is-active' : '')}
                  {...openProps(() => { setActiveEventId(null); setSelectedHoliday(h) })}
                  aria-pressed={active}
                  aria-label={`${h.name}, holiday, ${formatWhenShort(`${h.observedDate}T12:00:00`, true)}`}
                >
                  <span className="ev-rail-name">{h.name}</span>
                  <span className="meta" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {/* Append noon so a bare YYYY-MM-DD renders on its own
                          local day rather than shifting in negative TZs. */}
                      {formatWhenShort(`${h.observedDate}T12:00:00`, true)}
                      <span className="pl-chip">Holiday</span>
                    </span>
                    <button
                      type="button"
                      className="pl-btn ghost sm"
                      title="Hide this holiday"
                      aria-label={`Hide ${h.name}`}
                      onClick={(e) => { stop(e); hideHoliday(h) }}
                    >
                      Hide
                    </button>
                  </span>
                </div>
              )
            }
            const ev = row.event
            const active = ev.id === resolvedActiveId && selectedHoliday == null
            const accessibleName = [ev.name, formatWhenShort(ev.startAt, ev.allDay)].filter(Boolean).join(', ')
            return (
              <button
                key={`event:${ev.id}`}
                type="button"
                className={'ev-rail-item' + (active ? ' is-active' : '')}
                aria-pressed={active}
                aria-label={accessibleName}
                onClick={() => { setActiveEventId(ev.id); setSelectedHoliday(null) }}
              >
                <span className="ev-rail-name">{ev.name}</span>
                <span className="meta" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {formatWhenShort(ev.startAt, ev.allDay)}
                  {ev.ticketCount > 0 && (
                    <span className="ev-rail-tickets">
                      <Icon name="events" size={10} />
                      {ev.ticketCount}
                    </span>
                  )}
                </span>
              </button>
            )
          })
        )}
        {!loadingEvents && pastCount > 0 && (
          <button
            type="button"
            className="pl-btn ghost sm"
            style={{ justifySelf: 'start' }}
            aria-pressed={showPast}
            onClick={() => setShowPast((v) => !v)}
          >
            {showPast ? 'Hide past events' : `Show past events (${pastCount})`}
          </button>
        )}
      </nav>

      {/* Detail drawer — event (editable, tickets) or holiday (read-only). */}
      <Drawer
        open={detailOpen}
        onClose={closeDetail}
        title={selectedHoliday ? 'Holiday' : 'Event'}
        mobileSheet
      >
        {selectedHoliday ? (
          <HolidayDetail holiday={selectedHoliday} onHide={() => hideHoliday(selectedHoliday)} />
        ) : activeEvent != null ? (
          <EventDetail
            event={activeEvent}
            tickets={tickets}
            loadingTickets={loadingTickets}
            uploading={uploading}
            onAttach={triggerAttach}
            onDownload={(t) => onDownload(t)}
            // Close the detail drawer before opening the edit drawer — the
            // shared Drawer doesn't coordinate stacked instances (each one's
            // Escape listener fires), so only one is open at a time.
            onEdit={() => { setEditing(activeEvent); closeDetail() }}
          />
        ) : null}
      </Drawer>

      {/* Hidden ticket file picker — top-level so EventDetail can trigger it. */}
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT_ATTR}
        onChange={(e) => void onPickFile(e)}
        style={{ display: 'none' }}
        aria-label="Ticket file"
      />

      {/* Edit drawer */}
      <Drawer open={editing !== null} onClose={() => setEditing(null)} title="Edit event" mobileSheet>
        {editing && (
          <PersonalEventEdit
            event={editing}
            onChanged={() => void refetchEvents()}
            onClose={() => setEditing(null)}
          />
        )}
      </Drawer>
      <QuickAdd anchor="float" />
    </>
  )
}
