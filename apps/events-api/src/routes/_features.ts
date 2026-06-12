import { resolveEventFeatures, type EventFeatureKey } from '@rallypoint/events-shared'
import { errors } from '../errors.js'
import type { EventRecord, MemberRole } from '../repos/types.js'

// Per-event feature gating (#216). When a feature is toggled off, the
// surface 404s for everyone except the event owner — the owner keeps
// full read/write access so toggling a feature back on never loses
// data, while non-owners can't tell a disabled feature from a missing
// one (404, not 403, so the toggle state itself isn't probeable).
export function assertFeatureEnabled(
  event: EventRecord,
  role: MemberRole,
  feature: EventFeatureKey,
): void {
  if (role === 'owner') return
  if (!resolveEventFeatures(event.features)[feature]) {
    throw errors.notFound('Not found.')
  }
}
