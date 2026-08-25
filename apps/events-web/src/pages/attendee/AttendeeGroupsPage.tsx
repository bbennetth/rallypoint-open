import { Link } from 'react-router-dom'
import { Button, EmptyState } from '@rallypoint/ui'
import { useSoloEventOutlet } from './_solo-event-outlet.js'
import { WhoIsGoingCard } from '../../ui/WhoIsGoingCard.js'
import { GroupLinkList } from '../../ui/GroupLinkCard.js'
import { useMyEventGroups } from '../../lib/useMyEventGroups.js'

// The Group tab of the event attendee shell. Lists every group the
// viewer belongs to in this event, and falls back to the solo empty
// state only when they genuinely belong to none.
//
// This page used to be SoloGroupEmptyPage: an unconditional "You're
// attending solo" that never asked the server. Because the event
// payload's `my_group_id` only ever carries the FIRST-joined group,
// that made every group after the first invisible — create a second
// group, reopen the event, and both were gone. The list here is what
// makes them reachable.

export function AttendeeGroupsPage() {
  const { event } = useSoloEventOutlet()
  const { state, reload } = useMyEventGroups(event.id)

  return (
    <main className="page-pad">
      <div className="max-w-xl mx-auto space-y-5">
        {state.status === 'loading' && (
          <p className="text-sm" style={{ color: 'var(--ink-dim)' }}>
            Loading your groups…
          </p>
        )}

        {/* A failed fetch is NOT "you have no groups" — saying so is the
            bug this page exists to fix. Offer a retry instead. */}
        {state.status === 'error' && (
          <EmptyState
            title="Couldn't load your groups"
            body={state.message}
            action={
              <Button variant="brutal" onClick={reload}>
                Try again
              </Button>
            }
          />
        )}

        {state.status === 'ready' && state.groups.length > 0 && (
          <>
            <header className="space-y-1">
              <h1 className="display text-2xl">Your groups</h1>
              <p className="text-sm" style={{ color: 'var(--ink-dim)' }}>
                {state.groups.length === 1
                  ? `Your group at ${event.name}.`
                  : `The ${state.groups.length} groups you're in at ${event.name}.`}
              </p>
            </header>

            <GroupLinkList groups={state.groups} />

            <div className="flex items-center gap-3">
              <Link
                to={`/events/${encodeURIComponent(event.slug)}/groups/new`}
                style={{ textDecoration: 'none' }}
              >
                <Button variant="ghost">Start another</Button>
              </Link>
              <Link to="/groups/join" style={{ textDecoration: 'none' }}>
                <Button variant="ghost">Join another</Button>
              </Link>
            </div>
          </>
        )}

        {state.status === 'ready' && state.groups.length === 0 && (
          <EmptyState
            title="You're attending solo"
            body={
              <>
                <p>
                  Groups are how friends plan together at <strong>{event.name}</strong>: shared
                  rallies, lists, and a ledger.
                </p>
                <p className="mt-2">Join a group or start one for your circle.</p>
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
        )}

        {event.features.attendees && <WhoIsGoingCard eventId={event.id} />}
      </div>
    </main>
  )
}
