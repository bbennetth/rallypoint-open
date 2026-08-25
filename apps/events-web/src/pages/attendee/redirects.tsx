import { Navigate, useParams } from 'react-router-dom'

// The attendee "My Day" tab merged into "Now" (one day-aware view instead
// of two overlapping ones). These keep the old `/day` URLs working for
// bookmarks, home-screen shortcuts and shared links — without
// them the SPA's catch-all would bounce people out to /me/events.

export function SoloDayRedirect() {
  const { slug } = useParams<{ slug: string }>()
  if (!slug) return <Navigate to="/me/events" replace />
  return <Navigate to={`/events/${encodeURIComponent(slug)}/attending/now`} replace />
}

export function GroupDayRedirect() {
  const { groupId } = useParams<{ groupId: string }>()
  if (!groupId) return <Navigate to="/me/events" replace />
  return <Navigate to={`/groups/${encodeURIComponent(groupId)}/now`} replace />
}
