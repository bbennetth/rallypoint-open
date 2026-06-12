import { Link } from 'react-router-dom'
import { Button, EmptyState } from '@rallypoint/ui'
import { useSoloEventOutlet } from './_solo-event-outlet.js'
import { WhoIsGoingCard } from '../../ui/WhoIsGoingCard.js'

// Phase 4 (#16). The Group tab in the solo shell. Renders an empty
// state because a solo attendee has no group; the CTA jumps to the
// existing join-or-create flow. Coming back from there with a group_id
// lands the user on the regular /groups/:groupId/* attendee chrome.

export function SoloGroupEmptyPage() {
  const { event } = useSoloEventOutlet()
  return (
    <main className="page-pad">
      <div className="max-w-xl mx-auto space-y-5">
        <EmptyState
          title="You're attending solo"
          body={
            <>
              <p>
                Groups are how friends plan together at <strong>{event.name}</strong>: shared chat,
                rallies, lists, and a ledger.
              </p>
              <p className="mt-2">Join a group or start one for your circle.</p>
            </>
          }
          action={
            <Link to="/groups/join" style={{ textDecoration: 'none' }}>
              <Button variant="brutal">Join or create a group</Button>
            </Link>
          }
        />
        {event.features.attendees && <WhoIsGoingCard eventId={event.id} />}
      </div>
    </main>
  )
}
