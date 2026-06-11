import { Link } from 'react-router-dom'
import { Button, EmptyState } from '@rallypoint/ui'
import { useSoloEventOutlet } from './_solo-event-outlet.js'

// Phase 4 (#16). Rallies tab in the solo shell. Rallies live inside
// groups; without a group there are none. CTA flows to group join.

export function SoloRalliesEmptyPage() {
  const { event } = useSoloEventOutlet()
  return (
    <main className="page-pad">
      <div className="max-w-xl mx-auto">
        <EmptyState
          title="No rallies — you're solo"
          body={
            <>
              Rallies are quick meet-ups your group plans during{' '}
              <strong>{event.name}</strong>. Join a group to RSVP to one or call your own.
            </>
          }
          action={
            <Link to="/groups/join" style={{ textDecoration: 'none' }}>
              <Button variant="brutal">Join or create a group</Button>
            </Link>
          }
        />
      </div>
    </main>
  )
}
