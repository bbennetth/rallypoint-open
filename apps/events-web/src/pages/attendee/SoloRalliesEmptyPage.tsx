import { Link } from 'react-router-dom'
import { Button, EmptyState } from '@rallypoint/ui'
import { useSoloEventOutlet } from './_solo-event-outlet.js'

// Phase 4 (#16). Rallies tab in the solo shell. Rallies live inside
// groups; without a group there are none. CTAs flow to group join /
// start-a-group.

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
            <div className="flex items-center gap-3">
              <Link to="/groups/join" style={{ textDecoration: 'none' }}>
                <Button variant="brutal">Join a group</Button>
              </Link>
              <Link
                to={`/events/${encodeURIComponent(event.slug)}/groups/new`}
                style={{ textDecoration: 'none' }}
              >
                <Button variant="ghost">Start a group</Button>
              </Link>
            </div>
          }
        />
      </div>
    </main>
  )
}
