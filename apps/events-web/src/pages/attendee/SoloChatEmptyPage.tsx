import { Link } from 'react-router-dom'
import { Button, EmptyState } from '@rallypoint/ui'
import { useSoloEventOutlet } from './_solo-event-outlet.js'

// Phase 4 (#16). Chat tab in the solo shell. Chat is group-scoped;
// without a group there's no thread. CTA flows to group join.

export function SoloChatEmptyPage() {
  const { event } = useSoloEventOutlet()
  return (
    <main className="page-pad">
      <div className="max-w-xl mx-auto">
        <EmptyState
          title="No chat — you're solo"
          body={
            <>
              Chat lives inside groups at <strong>{event.name}</strong>. Once you join a
              group with friends, your messages land here.
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
