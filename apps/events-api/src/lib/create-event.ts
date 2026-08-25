import { randomBytes } from 'node:crypto'
import { ulid } from 'ulid'
import { generateEventSlug } from '@rallypoint/events-shared'
import { UniqueConstraintError } from '@rallypoint/api-kit'
import type { CreateEventInput, EventRecord, Repos } from '../repos/types.js'

// Shared event-create with the auto-slug collision-retry loop, used by
// the HTTP create route (routes/events.ts) and the admin RPC core
// (services/rpc-core/admin-events-core.ts). Every event slug is
// auto-generated as `<slugified-name, max 24>-<4 random chars>`; the
// 30^4 namespace per name-prefix makes collisions vanishingly rare,
// but we retry rather than 500 if one happens. Custom slugs come later
// as a paid-tier feature.

export const SLUG_CREATE_RETRY = 5

function randomSlugByte(): number {
  return randomBytes(1)[0]!
}

// Throws the final UniqueConstraintError if every retry collides —
// callers map it to their surface's conflict shape.
export async function createEventWithSlugRetry(
  repos: Repos,
  fields: Omit<CreateEventInput, 'id' | 'slug'>,
): Promise<EventRecord> {
  let lastErr: unknown
  for (let attempt = 0; attempt < SLUG_CREATE_RETRY; attempt += 1) {
    const slug = generateEventSlug(fields.name, randomSlugByte)
    try {
      return await repos.events.create({ ...fields, id: `event_${ulid()}`, slug })
    } catch (err) {
      lastErr = err
      if (err instanceof UniqueConstraintError) continue
      throw err
    }
  }
  throw lastErr ?? new UniqueConstraintError('events.slug')
}
