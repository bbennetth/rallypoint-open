import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  getSettings,
  listHolidays,
  listPersonalEvents,
  updateSettings,
  type HolidayDto,
  type PersonalEventDto,
} from '../lib/api.js'
import { formatWhenShort } from '../lib/events-helpers.js'
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

// Personal Events surface (slice 7 + Ink redesign). A thin view over the
// planner-api BFF: renders the user's personal events as a rail + detail pane,
// lets them create events, and attach / download ticket files (images + PDF).
// All persistence lives in Events via the BFF — this page owns only view state.
// Holidays are interleaved into the list (read-only) via mergeEventsAndHolidays.
//
// The week/month calendar that used to live here (issue #547) moved to the
// standalone Calendar page; the shared EventDetail/HolidayDetail components +
// the useEventTickets hook are reused by both surfaces.

// How far ahead the rail lists holidays.
const HOLIDAY_LOOKAHEAD_DAYS = 90

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

function ymd(dt: Date): string {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

export function EventsPage() {
  const [events, setEvents] = useState<PersonalEventDto[]>([])
  const [activeEventId, setActiveEventId] = useState<string | null>(null)
  const [editing, setEditing] = useState<PersonalEventDto | null>(null)
  // Holiday selected in the LIST rail → shown read-only in the right pane;
  // takes precedence over the active event while set.
  const [selectedHoliday, setSelectedHoliday] = useState<HolidayDto | null>(null)
  const [loadingEvents, setLoadingEvents] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const todayYmd = useMemo(() => localToday().date, [])

  // Ticket machinery for the active event's detail pane (load + attach + download).
  const { tickets, loadingTickets, uploading, fileInputRef, onPickFile, onDownload, triggerAttach } =
    useEventTickets(activeEventId, setError)

  const refreshEvents = useCallback(async () => {
    setLoadingEvents(true)
    try {
      const rows = await listPersonalEvents()
      setEvents(rows)
      setActiveEventId((cur) => cur ?? rows[0]?.id ?? null)
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setLoadingEvents(false)
    }
  }, [])

  useEffect(() => {
    void refreshEvents()
  }, [refreshEvents])

  // An event added from the global quick-add FAB shows up without a reload.
  useEffect(() => onCreated('event', () => void refreshEvents()), [refreshEvents])

  // ── Holidays ──────────────────────────────────────────────────────
  // Holidays are fetched for a fixed forward window and interleaved into the
  // list (read-only). Settings (holiday prefs) are loaded on mount.
  const [holidays, setHolidays] = useState<HolidayDto[]>([])
  const [plannerSettings, setPlannerSettings] = useState<Record<string, unknown>>({})

  useEffect(() => {
    let cancelled = false
    void getSettings('planner')
      .then((s) => {
        if (!cancelled) setPlannerSettings(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!holidaysEnabled(plannerSettings)) {
      setHolidays([])
      return
    }
    let cancelled = false
    const from = new Date(todayYmd)
    const to = new Date(todayYmd)
    to.setDate(to.getDate() + HOLIDAY_LOOKAHEAD_DAYS)
    void listHolidays(ymd(from), ymd(to))
      .then((rows) => {
        if (cancelled) return
        // The BFF already filters hiddenHolidays; re-apply client-side so an
        // optimistic Hide takes effect before the next round-trip.
        const hidden = hiddenHolidays(plannerSettings)
        setHolidays(hidden.length > 0 ? rows.filter((h) => !hidden.includes(h.id)) : rows)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [todayYmd, plannerSettings])

  // Interleave events + holidays into one chronological list (uniform rows).
  const listRows = useMemo(() => mergeEventsAndHolidays(events, holidays), [events, holidays])

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

  const activeEvent = events.find((ev) => ev.id === activeEventId) ?? null

  return (
    <>
      <div className="pg-head">
        <div>
          <h1>Events</h1>
        </div>
      </div>

      {error && (
        <p role="alert" style={{ color: 'var(--hot)', fontSize: 13, marginTop: 0 }}>
          {error}
        </p>
      )}

      {/* List view: rail + detail pane */}
      <div className="ev-grid">
        <nav className="ev-rail" aria-label="Events" data-noswipe style={{ display: 'grid', gap: 7 }}>
          {loadingEvents ? (
            <SkeletonRows count={4} height={56} label="Loading events" />
          ) : listRows.length === 0 ? (
            <p className="meta" style={{ color: 'var(--ink-mute)' }}>No events yet — use the + button to add one.</p>
          ) : (
            listRows.map((row) => {
              // Holidays render as the same .ev-rail-item shape as events so
              // the list reads uniform. They're selectable (open a read-only
              // detail in the right pane) but never editable, and keep a quiet
              // inline Hide affordance.
              if (row.kind === 'holiday') {
                const h = row.holiday
                const active = selectedHoliday?.id === h.id
                return (
                  <div
                    key={`holiday:${h.id}`}
                    className={'ev-rail-item is-holiday' + (active ? ' is-active' : '')}
                    {...openProps(() => setSelectedHoliday(h))}
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
              const active = ev.id === activeEventId && selectedHoliday == null
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
        </nav>

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
            onEdit={() => setEditing(activeEvent)}
          />
        ) : (
          <section style={{ display: 'grid', gap: 16, minWidth: 0 }}>
            {!loadingEvents && (
              <p className="meta" style={{ color: 'var(--ink-mute)' }}>Select or create an event.</p>
            )}
          </section>
        )}
      </div>

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
            onChanged={() => void refreshEvents()}
            onClose={() => setEditing(null)}
          />
        )}
      </Drawer>
    </>
  )
}
