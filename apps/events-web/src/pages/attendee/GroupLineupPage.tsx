import { useParams } from 'react-router-dom'
import { getGroup, type GroupDetailDto } from '../../lib/api.js'
import { useCachedFetch } from '../../lib/cached-fetch.js'
import { readGroupDetail, writeGroupDetail } from '../../lib/cache.js'
import { EventLineup } from '../../ui/EventLineup.js'

// Group-joined attendee Lineup tab. Renders the same `EventLineup` view as
// the solo-attending route — joining a group changes who you're going with,
// not which festival lineup you see.
//
// The event behind the group comes from this page's own cached fetch rather
// than the active-group store the chrome hydrates. That store swallows a
// failed load and never retries — it isn't wired to the refresh bus — so
// trusting it would strand this tab on "Loading…" forever after one
// cold-cache failure, with pull-to-refresh unable to recover it. Every
// sibling tab (Now, Rallies, Social, Group) fetches the group itself for the
// same reason; `useCachedFetch` brings cache-first reads, refresh-bus
// revalidation and an error slot along with it.
export function GroupLineupPage() {
  const { groupId } = useParams<{ groupId: string }>()
  const group = useCachedFetch<GroupDetailDto>({
    key: `group:${groupId ?? 'missing'}`,
    loadFromCache: () =>
      groupId ? readGroupDetail<GroupDetailDto>(groupId) : Promise.resolve(null),
    saveToCache: async (v) => {
      if (groupId) await writeGroupDetail(groupId, v)
    },
    revalidate: () => {
      if (!groupId) throw new Error('Missing group.')
      return getGroup(groupId)
    },
  })

  if (group.data) {
    return <EventLineup eventId={group.data.event_id} title={group.data.name} groupId={groupId} />
  }

  return (
    <main className="page-pad">
      <div className="max-w-2xl mx-auto">
        <p className="text-sm" style={{ color: 'var(--ink-dim)' }}>
          {group.error
            ? "Couldn't load this group's lineup. Pull to refresh to try again."
            : 'Loading lineup…'}
        </p>
      </div>
    </main>
  )
}
