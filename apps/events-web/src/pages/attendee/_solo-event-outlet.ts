import { useOutletContext } from 'react-router-dom'
import type { SoloEventOutlet } from '../../ui/SoloAttendeeChrome.js'

// Typed accessor for the event context shared by SoloAttendeeLayout
// via React Router's <Outlet context>. Solo tab pages call this
// instead of re-fetching the event row.

export function useSoloEventOutlet(): SoloEventOutlet {
  return useOutletContext<SoloEventOutlet>()
}
