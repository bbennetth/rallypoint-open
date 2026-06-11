import { EventMapPage } from '../EventMapPage.js'
import { useEventOutlet } from './_event-outlet.js'

// Owner-side Map tab. The existing EventMapPage was already a
// standalone route (`/events/:slug/map`) before Phase 2; here we
// just mount it inside the EventOwnerLayout outlet so the chrome
// stays consistent. `userId` flows from the layout's outlet
// context.

export function MapPage() {
  const { userId } = useEventOutlet()
  return <EventMapPage userId={userId} />
}
