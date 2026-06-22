// Personal-event + holiday detail cards, shared by the Events page (list pane +
// calendar drawer) and the standalone Calendar page (chip → detail drawer).
// Both are pure presentational — they own no state; the parent supplies the
// ticket list + upload/download callbacks. Extracted from EventsPage so the two
// surfaces render identical detail without forking.

import { EyeRow } from './bits.js'
import { Icon, QR } from './icons.js'
import { deriveStatus, formatWhen } from '../lib/events-helpers.js'
import type { HolidayDto, PersonalEventDto, TicketDto } from '../lib/api.js'

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

// Event detail: header card + ticket list. Rendered both inline in the Events
// list view's right pane and inside the calendar detail drawer, so a calendar
// chip click shows the same details rather than bouncing back to the list. The
// hidden file <input> lives in the parent; `onAttach` triggers it.
export function EventDetail({
  event,
  tickets,
  loadingTickets,
  uploading,
  onAttach,
  onDownload,
  onEdit,
}: {
  event: PersonalEventDto
  tickets: TicketDto[]
  loadingTickets: boolean
  uploading: boolean
  onAttach: () => void
  onDownload: (ticket: TicketDto) => void
  onEdit: () => void
}) {
  const status = deriveStatus(event.startAt)
  return (
    <section style={{ display: 'grid', gap: 16, minWidth: 0 }}>
      <div className="pl-card" style={{ padding: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: status ? 10 : 6 }}>
          {status && <span className="pl-chip accent">{status}</span>}
          <button
            className="pl-btn ghost sm"
            style={{ marginLeft: 'auto' }}
            onClick={onEdit}
          >
            <Icon name="pencil" size={12} />
            Edit
          </button>
        </div>
        <h2 className="display" style={{ fontSize: 20, margin: '0 0 8px', color: 'var(--ink)' }}>
          {event.name}
        </h2>
        <div style={{ display: 'flex', gap: 16, color: 'var(--ink-dim)', flexWrap: 'wrap' }}>
          <span className="meta" style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
            <Icon name="clock" size={12} />
            {formatWhen(event.startAt, event.endAt, event.allDay)}
          </span>
          {event.locationLabel && (
            <span className="meta" style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
              <Icon name="pin" size={12} />
              {event.locationLabel}
            </span>
          )}
        </div>
        {event.description && (
          <p style={{ color: 'var(--ink-dim)', fontSize: 13.5, margin: '12px 0 0' }}>{event.description}</p>
        )}
      </div>

      <div>
        <EyeRow
          trailing={
            <button className="pl-btn ghost sm" disabled={uploading} onClick={onAttach}>
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
                  <button className="pl-btn ghost sm" onClick={() => onDownload(t)}>
                    <Icon name="download" size={13} />
                    Get
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

// Holiday detail: read-only card. Built-in holidays have no edit affordance —
// only a Hide control (mirrors the inline Hide in the Events list rail). Shown
// in the Events list pane when a holiday is selected and in the calendar detail
// drawer.
export function HolidayDetail({ holiday, onHide }: { holiday: HolidayDto; onHide: () => void }) {
  // Append noon so a bare YYYY-MM-DD renders on its own local day rather than
  // shifting in negative TZs (same trick the list rail uses).
  const observedLabel = formatWhen(`${holiday.observedDate}T12:00:00`, null, true)
  const shifted = holiday.date !== holiday.observedDate
  return (
    <section style={{ display: 'grid', gap: 16, minWidth: 0 }}>
      <div className="pl-card" style={{ padding: 20 }}>
        <span className="pl-chip">Holiday</span>
        <h2 className="display" style={{ fontSize: 24, margin: '12px 0 8px', color: 'var(--ink)' }}>
          {holiday.name}
        </h2>
        <div style={{ display: 'flex', gap: 16, color: 'var(--ink-dim)', flexWrap: 'wrap' }}>
          <span className="meta" style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
            <Icon name="clock" size={12} />
            {observedLabel}
          </span>
        </div>
        {shifted && (
          <p className="meta" style={{ color: 'var(--ink-mute)', margin: '12px 0 0' }}>
            Falls on {formatWhen(`${holiday.date}T12:00:00`, null, true)}; observed on the nearest weekday.
          </p>
        )}
        <p style={{ color: 'var(--ink-dim)', fontSize: 13.5, margin: '12px 0 0' }}>
          Public holiday · read-only
        </p>
      </div>
      <div>
        <button className="pl-btn ghost sm" onClick={onHide}>
          Hide from calendar
        </button>
      </div>
    </section>
  )
}
