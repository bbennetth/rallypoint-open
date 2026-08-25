import { Drawer } from '@rallypoint/ui'
import type { HolidayDto } from '../lib/api.js'
import { TaskDetail } from '../ui/TaskDetail.js'
import { SeriesEdit } from '../ui/SeriesEdit.js'
import { PersonalEventEdit } from '../ui/PersonalEventEdit.js'
import { EventDayDetail } from '../ui/EventDayDetail.js'
import { HolidayDetail } from '../ui/EventDetail.js'
import type { Selected } from './MyDayPage.js'

export interface MyDayDetailDrawersProps {
  selected: Selected | null
  onClose: () => void
  onChanged: () => void
  onHideHoliday: (h: HolidayDto) => void
}

// The Drawer that shows detail/edit UI for whatever is currently `selected`
// on the My Day agenda (task, personal event, group event day, holiday, or
// recurring series). Split out of `MyDayPage` — selection STATE stays in the
// page; this only owns the render switch.
export function MyDayDetailDrawers({
  selected,
  onClose,
  onChanged,
  onHideHoliday,
}: MyDayDetailDrawersProps) {
  return (
    <Drawer
      open={selected !== null}
      onClose={onClose}
      title={
        selected?.kind === 'task'
          ? 'Task'
          : selected?.kind === 'series'
            ? 'Edit series'
            : selected?.kind === 'holiday'
              ? 'Holiday'
              : 'Event'
      }
      mobileSheet
    >
      {selected?.kind === 'task' && (
        <TaskDetail task={selected.task} onChanged={onChanged} onClose={onClose} />
      )}
      {selected?.kind === 'event' && (
        <PersonalEventEdit event={selected.event} onChanged={onChanged} onClose={onClose} />
      )}
      {selected?.kind === 'eventDay' && <EventDayDetail eventDay={selected.eventDay} />}
      {selected?.kind === 'holiday' && (
        <HolidayDetail holiday={selected.holiday} onHide={() => onHideHoliday(selected.holiday)} />
      )}
      {selected?.kind === 'series' && (
        <SeriesEdit
          series={selected.series}
          surface={selected.surface}
          onChanged={onChanged}
          onClose={onClose}
        />
      )}
    </Drawer>
  )
}
