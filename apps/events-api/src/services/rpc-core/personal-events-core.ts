import { ulid } from 'ulid'
import type { EventRecord, PatchEventInput } from '../../repos/types.js'
import { UniqueConstraintError } from '@rallypoint/api-kit'
import { errors } from '../../errors.js'
import type { EventsRpcDeps } from './deps.js'

// Cross-Worker RPC core for the personal-events surface
// (apps/events-api/src/routes/sdk-personal-events.ts). HTTP handlers and
// EventsRPC methods both call these; the ownership opaque 404 stays
// enforced in the core fn (a missing/deleted/wrong-scope/foreign-owner
// row maps to the `not_found` discriminator), so the gate can't drift.

const TENANT = 'rallypoint'

export type PersonalEventNotFound = { kind: 'not_found' }
export type Ok<T> = { kind: 'ok'; data: T }

export interface PersonalEventDto {
  id: string
  scopeType: string
  ownerUserId: string
  slug: string
  name: string
  description: string | null
  startAt: string | null
  endAt: string | null
  allDay: boolean
  timezone: string
  locationLabel: string | null
  privacyMode: string
  ticketCount: number
  ticketPlatform: string | null
  ticketAccountEmail: string | null
  createdAt: string
  updatedAt: string
}

// Issue #545: resolve the effective all-day flag. Explicit DB value wins;
// null falls back to inference: no startAt → false (no time info);
// midnight UTC (or no time-of-day component) → true; any other time → false.
function effectiveAllDay(e: EventRecord): boolean {
  if (e.allDay !== null && e.allDay !== undefined) return e.allDay
  if (!e.startAt) return false
  const iso = e.startAt.toISOString()
  if (!iso.includes('T')) return true
  const timePart = iso.split('T')[1] ?? ''
  return timePart === '00:00:00.000Z'
}

export function serializePersonalEventDto(e: EventRecord): PersonalEventDto {
  return {
    id: e.id,
    scopeType: e.scopeType,
    ownerUserId: e.ownerUserId,
    slug: e.slug,
    name: e.name,
    description: e.description,
    startAt: e.startAt?.toISOString() ?? null,
    endAt: e.endAt?.toISOString() ?? null,
    allDay: effectiveAllDay(e),
    timezone: e.timezone,
    locationLabel: e.locationLabel,
    privacyMode: e.privacyMode,
    ticketCount: e.ticketCount,
    ticketPlatform: e.ticketPlatform ?? null,
    ticketAccountEmail: e.ticketAccountEmail ?? null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  }
}

export interface CreatePersonalEventInput {
  name: string
  description?: string | null | undefined
  locationLabel?: string | null | undefined
  startAt?: string | null | undefined
  endAt?: string | null | undefined
  ticketPlatform?: string | null | undefined
  ticketAccountEmail?: string | null | undefined
  allDay?: boolean | undefined
  // Offline-create idempotency key (repo-wide "offline create retries
  // must be idempotent" fix; mirrors money-api's expense/settlement
  // `ref`). Offline clients carry a stable client-generated `tmpId`
  // (`tmp_<uuid>`) across retries and send it as `ref`. A retry that
  // lands after the original commit finds the existing row via
  // findByOwnerAndRef and returns it instead of inserting a duplicate.
  // Unique per (owner_user_id, ref); omit for un-keyed creates
  // (duplicates allowed, matches historical behavior).
  ref?: string | null | undefined
}

export async function createPersonalEventCore(
  actor: string,
  input: CreatePersonalEventInput,
  deps: EventsRpcDeps,
): Promise<PersonalEventDto> {
  const ref = input.ref ?? null

  // Idempotent-create on (owner_user_id, ref): if the caller supplied a
  // ref and we've seen it before, return the existing row instead of
  // inserting again. Pre-flight check avoids the optimistic insert when
  // an offline-retry cascade replays the same ref.
  if (ref !== null) {
    const existing = await deps.repos.events.findByOwnerAndRef(actor, ref)
    if (existing) return replayOrConflict(existing, ref)
  }

  const id = `event_${ulid()}`
  const slug = `personal-${ulid().toLowerCase()}`
  try {
    const record = await deps.repos.events.create({
      id,
      tenantId: TENANT,
      ownerUserId: actor,
      slug,
      name: input.name,
      description: input.description ?? null,
      timezone: 'UTC',
      scopeType: 'personal',
      privacyMode: 'private',
      locationLabel: input.locationLabel ?? null,
      startAt: input.startAt ? new Date(input.startAt) : null,
      endAt: input.endAt ? new Date(input.endAt) : null,
      ticketPlatform: input.ticketPlatform ?? null,
      ticketAccountEmail: input.ticketAccountEmail ?? null,
      ...(input.allDay !== undefined ? { allDay: input.allDay } : {}),
      ref,
    })
    return serializePersonalEventDto(record)
  } catch (err) {
    // Race: two parallel creates with the same ref both got past the
    // pre-flight; the second hit the partial-unique index. Same
    // fall-back: fetch and return the winner.
    if (err instanceof UniqueConstraintError && ref !== null) {
      const existing = await deps.repos.events.findByOwnerAndRef(actor, ref)
      if (existing) return replayOrConflict(existing, ref)
    }
    throw err
  }
}

// A ref-idempotency replay must not resurrect a tombstone: findByOwnerAndRef
// spans soft-deleted rows, so a replay whose ref belongs to a deleted event
// 409s instead of returning the stale row as a fake success (which would also
// re-arm the planner-api notification for a deleted event). Mirrors lists-api.
function replayOrConflict(existing: EventRecord, ref: string): PersonalEventDto {
  if (existing.deletedAt !== null) {
    throw errors.eventRefTakenByDeleted({
      ref,
      event_id: existing.id,
      deleted_at: existing.deletedAt.toISOString(),
    })
  }
  return serializePersonalEventDto(existing)
}

export interface ListPersonalEventsOpts {
  from?: string | null | undefined
  to?: string | null | undefined
}

export async function listPersonalEventsCore(
  actor: string,
  opts: ListPersonalEventsOpts,
  deps: EventsRpcDeps,
): Promise<PersonalEventDto[]> {
  const from = opts.from ? new Date(opts.from) : null
  const to = opts.to ? new Date(opts.to) : null
  const records = await deps.repos.events.listPersonalForUser(actor, { from, to })
  return records.map(serializePersonalEventDto)
}

export async function getPersonalEventCore(
  actor: string,
  id: string,
  deps: EventsRpcDeps,
): Promise<Ok<PersonalEventDto> | PersonalEventNotFound> {
  const record = await loadOwnedPersonalEvent(actor, id, deps)
  if (!record) return { kind: 'not_found' }
  return { kind: 'ok', data: serializePersonalEventDto(record) }
}

export interface PatchPersonalEventFields {
  name?: string | undefined
  description?: string | null | undefined
  locationLabel?: string | null | undefined
  startAt?: string | null | undefined
  endAt?: string | null | undefined
  ticketPlatform?: string | null | undefined
  ticketAccountEmail?: string | null | undefined
  // The Zod schema accepts `null` to mean "leave inferred"; the repo
  // patch path treats `null` and `undefined` equivalently here.
  allDay?: boolean | null | undefined
}

export async function patchPersonalEventCore(
  actor: string,
  id: string,
  patch: PatchPersonalEventFields,
  deps: EventsRpcDeps,
): Promise<Ok<PersonalEventDto> | PersonalEventNotFound> {
  const record = await loadOwnedPersonalEvent(actor, id, deps)
  if (!record) return { kind: 'not_found' }
  const fields: PatchEventInput = {}
  if (patch.name !== undefined) fields.name = patch.name
  if (patch.description !== undefined) fields.description = patch.description
  if (patch.locationLabel !== undefined) fields.locationLabel = patch.locationLabel
  if (patch.startAt !== undefined)
    fields.startAt = patch.startAt === null ? null : new Date(patch.startAt)
  if (patch.endAt !== undefined)
    fields.endAt = patch.endAt === null ? null : new Date(patch.endAt)
  if (patch.ticketPlatform !== undefined) fields.ticketPlatform = patch.ticketPlatform
  if (patch.ticketAccountEmail !== undefined) fields.ticketAccountEmail = patch.ticketAccountEmail
  // `null` is meaningful: "clear my explicit choice, fall back to
  // inference". The repo accepts `boolean | null` on this field.
  if (patch.allDay !== undefined) fields.allDay = patch.allDay

  const updated = await deps.repos.events.patch(id, fields)
  if (!updated) return { kind: 'not_found' }
  return { kind: 'ok', data: serializePersonalEventDto(updated) }
}

export async function deletePersonalEventCore(
  actor: string,
  id: string,
  deps: EventsRpcDeps,
): Promise<Ok<true> | PersonalEventNotFound> {
  const record = await loadOwnedPersonalEvent(actor, id, deps)
  if (!record) return { kind: 'not_found' }
  await deps.repos.events.softDelete(id, new Date())
  return { kind: 'ok', data: true }
}

// Opaque ownership check. Returns the record only when actor owns the
// live personal event; null otherwise (missing / soft-deleted / wrong
// scope / different owner — all collapse to one branch).
async function loadOwnedPersonalEvent(
  actor: string,
  id: string,
  deps: EventsRpcDeps,
): Promise<EventRecord | null> {
  const record = await deps.repos.events.findById(id)
  if (
    !record ||
    record.deletedAt ||
    record.scopeType !== 'personal' ||
    record.ownerUserId !== actor
  ) {
    return null
  }
  return record
}
