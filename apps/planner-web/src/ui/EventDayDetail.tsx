import type { EventDayDto } from '../lib/api.js'
import { eventDayWindow } from '../lib/planner-helpers.js'
import { EventEditPencil } from './bits.js'

// Read-only detail for a group (festival) event day shown in the My Day /
// Upcoming slider. Planner never edits these inline — owners get the
// "edit in RP Events" pencil; everyone else sees a read-only summary.
export function EventDayDetail({ eventDay }: { eventDay: EventDayDto }) {
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="pl-note-view-title">{eventDay.name}</div>
      <div className="pl-fab-hint">
        {eventDay.dayLabel} · {eventDayWindow(eventDay.startTime, eventDay.endTime)}
      </div>
      {eventDay.owned ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="pl-fab-hint">Edit in RP Events</span>
          <EventEditPencil slug={eventDay.slug} />
        </div>
      ) : (
        <p className="pl-fab-hint">A festival event on your schedule.</p>
      )}
    </div>
  )
}
