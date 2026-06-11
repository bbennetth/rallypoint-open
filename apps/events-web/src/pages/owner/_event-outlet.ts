import { useOutletContext } from 'react-router-dom'
import type { EventOutlet } from '../../ui/EventOwnerLayout.js'

// Typed accessor for the event context shared by EventOwnerLayout via
// React Router's <Outlet context={…}>. Every owner tab page calls this
// instead of re-fetching the event row.

export function useEventOutlet(): EventOutlet {
  return useOutletContext<EventOutlet>()
}
