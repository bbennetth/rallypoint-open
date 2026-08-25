import { EventLineup } from '../../ui/EventLineup.js'
import { useSoloEventOutlet } from './_solo-event-outlet.js'

// Solo-attending Lineup tab. The view itself lives in `EventLineup` so the
// group-joined route (`GroupLineupPage`) renders exactly the same thing.
export function SoloLineupPage() {
  const { event } = useSoloEventOutlet()
  return <EventLineup eventId={event.id} title={event.name} />
}
