import { ulid } from 'ulid'
import { SYSTEM_USER_ID } from '@rallypoint/shared'
import {
  CreateEventSchema,
  PatchEventSchema,
  mergeEventFeatures,
  resolveEventFeatures,
  type EventFeatures,
} from '@rallypoint/events-shared'
import type { EventRecord, PatchEventInput } from '../../repos/types.js'
import { UniqueConstraintError } from '@rallypoint/api-kit'
import { createEventWithSlugRetry } from '../../lib/create-event.js'
import { eventChannel, envelope } from '../../realtime/channels.js'
import type { EventsRpcDeps } from './deps.js'

// Cross-Worker RPC core for the admin system-events surface. Consumed
// by admin-api (via the EventsRPC binding) to manage events owned by
// the SYSTEM_USER_ID sentinel. The binding peer is trusted, but the
// acting admin id is re-checked against events-api's own
// ADMIN_USER_IDS allowlist (defense-in-depth — the same allowlist that
// grants owner-equivalent access in the UI routes, so the two surfaces
// can't drift apart).

const TENANT = 'rallypoint'
const ADMIN_LIST_MAX = 100

export type AdminForbidden = { kind: 'forbidden' }
export type AdminNotFound = { kind: 'not_found' }
export type AdminInvalid = { kind: 'invalid'; issues: { path: string; message: string }[] }
export type AdminConflict = { kind: 'conflict'; code: string }
export type AdminOk<T> = { kind: 'ok'; data: T }

export interface SystemEventDto {
  id: string
  slug: string
  name: string
  description: string | null
  startDate: string | null
  endDate: string | null
  timezone: string
  locationLabel: string | null
  privacyMode: string
  features: EventFeatures
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface AdminListSystemEventsOpts {
  includeDeleted?: boolean | undefined
  limit?: number | undefined
  cursor?: string | null | undefined
}

export interface AdminSystemEventsPage {
  items: SystemEventDto[]
  nextCursor: string | null
}

function serializeSystemEvent(e: EventRecord): SystemEventDto {
  return {
    id: e.id,
    slug: e.slug,
    name: e.name,
    description: e.description,
    startDate: e.startDate,
    endDate: e.endDate,
    timezone: e.timezone,
    locationLabel: e.locationLabel,
    privacyMode: e.privacyMode,
    features: resolveEventFeatures(e.features),
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    deletedAt: e.deletedAt ? e.deletedAt.toISOString() : null,
  }
}

export function isAdmin(actor: string, deps: EventsRpcDeps): boolean {
  if (!/^user_[a-zA-Z0-9_-]+$/.test(actor)) return false
  return deps.env.ADMIN_USER_IDS.split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .includes(actor)
}

export async function recordAdminActivity(
  deps: EventsRpcDeps,
  eventId: string,
  actor: string,
  eventType: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  await deps.repos.activity.record({
    id: `eva_${ulid()}`,
    eventId,
    actorUserId: actor,
    eventType,
    meta,
  })
}

// Best-effort realtime publish (mirrors routes' publish() helper — a
// NOTIFY failure must never fail the mutation).
export function publishUpdate(deps: EventsRpcDeps, eventId: string, actor: string, verb: 'update' | 'delete'): void {
  try {
    void deps.realtime.publish(eventChannel(eventId), envelope('events', verb, eventId, actor)).catch((err: unknown) => {
      deps.logger.warn({ err, eventId }, 'realtime publish failed')
    })
  } catch (err) {
    deps.logger.warn({ err, eventId }, 'realtime publish failed')
  }
}

// Load a SYSTEM-owned event or report not_found. Non-system events are
// reported as not_found (not forbidden) so this surface can't be used
// to probe user events.
export async function loadSystemEvent(eventId: string, deps: EventsRpcDeps): Promise<EventRecord | null> {
  if (!eventId.startsWith('event_')) return null
  const event = await deps.repos.events.findById(eventId)
  if (!event || event.ownerUserId !== SYSTEM_USER_ID) return null
  return event
}

export async function adminListSystemEventsCore(
  actor: string,
  opts: AdminListSystemEventsOpts,
  deps: EventsRpcDeps,
): Promise<AdminOk<AdminSystemEventsPage> | AdminForbidden> {
  if (!isAdmin(actor, deps)) return { kind: 'forbidden' }
  const limit = Math.min(ADMIN_LIST_MAX, Math.max(1, Math.floor(opts.limit ?? 50)))
  const page = await deps.repos.events.listByOwner(SYSTEM_USER_ID, {
    includeDeleted: opts.includeDeleted ?? false,
    limit,
    cursor: opts.cursor ?? null,
  })
  return {
    kind: 'ok',
    data: { items: page.items.map(serializeSystemEvent), nextCursor: page.nextCursor },
  }
}

export async function adminGetSystemEventCore(
  actor: string,
  eventId: string,
  deps: EventsRpcDeps,
): Promise<AdminOk<SystemEventDto> | AdminForbidden | AdminNotFound> {
  if (!isAdmin(actor, deps)) return { kind: 'forbidden' }
  const event = await loadSystemEvent(eventId, deps)
  if (!event) return { kind: 'not_found' }
  return { kind: 'ok', data: serializeSystemEvent(event) }
}

export async function adminCreateSystemEventCore(
  actor: string,
  input: unknown,
  deps: EventsRpcDeps,
): Promise<AdminOk<SystemEventDto> | AdminForbidden | AdminInvalid | AdminConflict> {
  if (!isAdmin(actor, deps)) return { kind: 'forbidden' }
  const parsed = CreateEventSchema.safeParse(input)
  if (!parsed.success) {
    return {
      kind: 'invalid',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }
  }
  const body = parsed.data
  let event: EventRecord
  try {
    event = await createEventWithSlugRetry(deps.repos, {
      tenantId: TENANT,
      ownerUserId: SYSTEM_USER_ID,
      name: body.name,
      description: body.description ?? null,
      startDate: body.startDate ?? null,
      endDate: body.endDate ?? null,
      timezone: body.timezone,
      locationLabel: body.locationLabel ?? null,
      locationLat: body.locationLat ?? null,
      locationLng: body.locationLng ?? null,
      privacyMode: body.privacyMode ?? 'unlisted',
    })
  } catch (err) {
    if (err instanceof UniqueConstraintError) return { kind: 'conflict', code: 'event_slug_taken' }
    throw err
  }
  await recordAdminActivity(deps, event.id, actor, 'event.created', {
    slug: event.slug,
    system: true,
  })
  return { kind: 'ok', data: serializeSystemEvent(event) }
}

export async function adminPatchSystemEventCore(
  actor: string,
  eventId: string,
  input: unknown,
  deps: EventsRpcDeps,
): Promise<AdminOk<SystemEventDto> | AdminForbidden | AdminNotFound | AdminInvalid> {
  if (!isAdmin(actor, deps)) return { kind: 'forbidden' }
  const event = await loadSystemEvent(eventId, deps)
  if (!event || event.deletedAt) return { kind: 'not_found' }
  const parsed = PatchEventSchema.safeParse(input)
  if (!parsed.success) {
    return {
      kind: 'invalid',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }
  }
  // Admins act with owner rights on system events, so the owner-only
  // feature-toggle gate from the HTTP route is satisfied by isAdmin.
  const { features: featuresPatch, ...rest } = parsed.data
  const fields: PatchEventInput = { ...rest }
  if (featuresPatch !== undefined) {
    fields.features = mergeEventFeatures(event.features, featuresPatch)
  }
  const updated = await deps.repos.events.patch(event.id, fields)
  if (!updated) return { kind: 'not_found' }
  await recordAdminActivity(deps, event.id, actor, 'event.patched', {
    fields: Object.keys(fields),
  })
  publishUpdate(deps, event.id, actor, 'update')
  return { kind: 'ok', data: serializeSystemEvent(updated) }
}

export async function adminDeleteSystemEventCore(
  actor: string,
  eventId: string,
  deps: EventsRpcDeps,
): Promise<AdminOk<true> | AdminForbidden | AdminNotFound> {
  if (!isAdmin(actor, deps)) return { kind: 'forbidden' }
  const event = await loadSystemEvent(eventId, deps)
  if (!event || event.deletedAt) return { kind: 'not_found' }
  await deps.repos.events.softDelete(event.id, new Date())
  await recordAdminActivity(deps, event.id, actor, 'event.soft_deleted')
  publishUpdate(deps, event.id, actor, 'delete')
  return { kind: 'ok', data: true }
}

export async function adminRestoreSystemEventCore(
  actor: string,
  eventId: string,
  deps: EventsRpcDeps,
): Promise<AdminOk<SystemEventDto> | AdminForbidden | AdminNotFound | AdminConflict> {
  if (!isAdmin(actor, deps)) return { kind: 'forbidden' }
  const event = await loadSystemEvent(eventId, deps)
  if (!event) return { kind: 'not_found' }
  if (!event.deletedAt) return { kind: 'conflict', code: 'event_not_deleted' }
  await deps.repos.events.restore(event.id)
  await recordAdminActivity(deps, event.id, actor, 'event.restored')
  publishUpdate(deps, event.id, actor, 'update')
  const fresh = await deps.repos.events.findById(event.id)
  return { kind: 'ok', data: serializeSystemEvent(fresh ?? event) }
}
