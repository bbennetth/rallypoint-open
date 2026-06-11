import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ApiError,
  getTicketDownloadUrl,
  listPersonalEvents,
  listTickets,
  uploadTicket,
  type PersonalEventDto,
  type TicketDto,
} from '../lib/api.js'
import { deriveStatus, formatWhen, formatWhenShort } from '../lib/events-helpers.js'
import { onCreated } from '../lib/refresh-bus.js'
import { EyeRow } from '../ui/bits.js'
import { Icon, QR } from '../ui/icons.js'
import { Drawer } from '@rallypoint/ui'
import { PersonalEventEdit } from '../ui/PersonalEventEdit.js'

// Personal Events surface (slice 7 + Ink redesign). A thin view over the
// planner-api BFF: renders the user's personal events, lets them create
// events, and attach / download ticket files (images + PDF). All persistence
// lives in Events via the BFF — this page owns only view state.

// Client-side affordance only; events-api is the real gate on type + size.
const ACCEPTED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
const ACCEPT_ATTR = ACCEPTED_MIME.join(',')

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function contentTypeLabel(ct: string): string {
  if (ct === 'application/pdf') return 'PDF'
  const m = /^image\/(\w+)$/.exec(ct)
  if (m && m[1]) return m[1].toUpperCase()
  return ct
}

export function EventsPage() {
  const [events, setEvents] = useState<PersonalEventDto[]>([])
  const [activeEventId, setActiveEventId] = useState<string | null>(null)
  const [editing, setEditing] = useState<PersonalEventDto | null>(null)
  const [creating, setCreating] = useState(false)
  const [tickets, setTickets] = useState<TicketDto[]>([])
  const [loadingEvents, setLoadingEvents] = useState(true)
  const [loadingTickets, setLoadingTickets] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

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

  const refreshTickets = useCallback(async (eventId: string) => {
    setLoadingTickets(true)
    try {
      setTickets(await listTickets(eventId))
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setLoadingTickets(false)
    }
  }, [])

  useEffect(() => {
    if (activeEventId) void refreshTickets(activeEventId)
    else setTickets([])
  }, [activeEventId, refreshTickets])

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file later
    if (!file || !activeEventId) return
    setError(null)
    if (!ACCEPTED_MIME.includes(file.type)) {
      setError('Tickets must be a JPEG, PNG, WebP, or PDF file.')
      return
    }
    setUploading(true)
    try {
      const bound = await uploadTicket(activeEventId, file)
      setTickets((prev) => [...prev, bound])
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setUploading(false)
    }
  }

  async function onDownload(ticket: TicketDto) {
    if (!activeEventId) return
    setError(null)
    try {
      const url = getTicketDownloadUrl(activeEventId, ticket.id)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      setError(errMessage(err))
    }
  }

  const activeEvent = events.find((ev) => ev.id === activeEventId) ?? null
  const status = activeEvent ? deriveStatus(activeEvent.startAt) : null

  return (
    <>
      <div className="pg-head">
        <div>
          <h1>Events</h1>
          <div className="sub">Your personal events and their tickets.</div>
        </div>
        <button className="pl-btn" onClick={() => setCreating(true)}>
          <Icon name="plus" size={13} />
          New event
        </button>
      </div>

      {error && (
        <p role="alert" style={{ color: 'var(--hot)', fontSize: 13, marginTop: 0 }}>
          {error}
        </p>
      )}

      <div className="ev-grid">
        <nav className="ev-rail" aria-label="Events" style={{ display: 'grid', gap: 7 }}>
          {loadingEvents ? (
            <p className="meta" style={{ color: 'var(--ink-mute)' }}>Loading…</p>
          ) : events.length === 0 ? (
            <p className="meta" style={{ color: 'var(--ink-mute)' }}>No events yet — create one above.</p>
          ) : (
            events.map((ev) => {
              const active = ev.id === activeEventId
              const accessibleName = [ev.name, formatWhenShort(ev.startAt)].filter(Boolean).join(', ')
              return (
                <button
                  key={ev.id}
                  type="button"
                  className={'ev-rail-item' + (active ? ' is-active' : '')}
                  aria-pressed={active}
                  aria-label={accessibleName}
                  onClick={() => setActiveEventId(ev.id)}
                >
                  <span className="ev-rail-name">{ev.name}</span>
                  <span className="meta" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {formatWhenShort(ev.startAt)}
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

        <section style={{ display: 'grid', gap: 16, minWidth: 0 }}>
          {!loadingEvents && activeEvent == null ? (
            <p className="meta" style={{ color: 'var(--ink-mute)' }}>Select or create an event.</p>
          ) : activeEvent != null ? (
            <>
              <div className="pl-card" style={{ padding: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
                  <button
                    className="pl-btn ghost"
                    style={{ padding: '6px 11px' }}
                    onClick={() => setEditing(activeEvent)}
                  >
                    <Icon name="pencil" size={12} />
                    Edit
                  </button>
                </div>
                {status && <span className="pl-chip accent">{status}</span>}
                <h2 className="display" style={{ fontSize: 24, margin: status ? '12px 0 8px' : '0 0 8px', color: 'var(--ink)' }}>
                  {activeEvent.name}
                </h2>
                <div style={{ display: 'flex', gap: 16, color: 'var(--ink-dim)', flexWrap: 'wrap' }}>
                  <span className="meta" style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                    <Icon name="clock" size={12} />
                    {formatWhen(activeEvent.startAt, activeEvent.endAt)}
                  </span>
                  {activeEvent.locationLabel && (
                    <span className="meta" style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                      <Icon name="pin" size={12} />
                      {activeEvent.locationLabel}
                    </span>
                  )}
                </div>
                {activeEvent.description && (
                  <p style={{ color: 'var(--ink-dim)', fontSize: 13.5, margin: '12px 0 0' }}>{activeEvent.description}</p>
                )}
              </div>

              <div>
                <EyeRow
                  trailing={
                    <button className="pl-btn ghost" style={{ padding: '7px 11px' }} disabled={uploading} onClick={() => fileInputRef.current?.click()}>
                      <Icon name="plus" size={12} />
                      {uploading ? 'Uploading…' : 'Attach ticket'}
                    </button>
                  }
                >
                  <span>
                    Tickets{' '}
                    {!loadingTickets && <span aria-live="polite">· {tickets.length}</span>}
                  </span>
                </EyeRow>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPT_ATTR}
                  onChange={(e) => void onPickFile(e)}
                  style={{ display: 'none' }}
                  aria-label="Ticket file"
                />

                {loadingTickets ? (
                  <p className="meta" style={{ color: 'var(--ink-mute)' }}>Loading…</p>
                ) : tickets.length === 0 ? (
                  <p className="meta" style={{ color: 'var(--ink-mute)' }}>No tickets attached yet.</p>
                ) : (
                  <div style={{ display: 'grid', gap: 9 }}>
                    {tickets.map((t) => (
                      <div key={t.id} className="pl-ticket">
                        <div className="stub">
                          <QR size={42} />
                        </div>
                        <div className="body" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <span style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }}>
                            <span style={{ fontSize: 13.5, color: 'var(--ink)', display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                              <Icon name="file" size={13} />
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {t.fileName ?? contentTypeLabel(t.contentType)}
                              </span>
                            </span>
                            <span style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                              <span className="pl-chip">{contentTypeLabel(t.contentType)}</span>
                              <span className="pl-chip">{formatBytes(t.bytes)}</span>
                              <span className="pl-chip">
                                <b style={{ color: 'var(--ink-mute)', fontWeight: 700, marginRight: 4 }}>Source</b>
                                Upload
                              </span>
                            </span>
                          </span>
                          <button className="pl-btn ghost" style={{ padding: '8px 11px' }} onClick={() => void onDownload(t)}>
                            <Icon name="download" size={13} />
                            Get
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <p className="meta" style={{ color: 'var(--ink-mute)', marginTop: 11 }}>
                  Accepts JPEG, PNG, WebP, or PDF · stored privately
                </p>
              </div>
            </>
          ) : null}
        </section>
      </div>

      {/* Create drawer — full field parity with edit */}
      <Drawer open={creating} onClose={() => setCreating(false)} title="New event" mobileSheet>
        {creating && (
          <PersonalEventEdit
            event={null}
            onCreated={(created) => {
              setEvents((prev) => [...prev, created])
              setActiveEventId(created.id)
              setCreating(false)
            }}
            onClose={() => setCreating(false)}
          />
        )}
      </Drawer>

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
