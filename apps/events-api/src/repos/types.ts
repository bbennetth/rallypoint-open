// Locked repo shapes for events-api. Each interface has a D1
// impl (repos/d1/*) and an in-memory impl (repos/memory.ts) for
// unit tests. events-api owns its own D1 database — it takes no
// dependency on @rallypoint/db; the RPID side is reached over HTTP
// via the services layer.
//
// Ownership model: events.owner_user_id is the single source of
// truth for who owns an event. event_members holds NON-owner
// collaborators only (editor / viewer). Permission checks are
// therefore `userId === event.ownerUserId` OR a matching member row.

export type PrivacyMode = 'public' | 'unlisted' | 'private'
export type ScopeType = 'personal' | 'group'
export type MemberRole = 'owner' | 'editor' | 'viewer'
export type AssignableRole = 'editor' | 'viewer'

// --- events --------------------------------------------------------

// Date columns come back from the driver as 'YYYY-MM-DD' strings;
// numeric(9,6) columns come back as strings. We surface them as the
// driver returns them and convert at the route boundary.
export interface EventRecord {
  id: string
  tenantId: string
  ownerUserId: string
  slug: string
  name: string
  description: string | null
  startDate: string | null
  endDate: string | null
  timezone: string
  locationLabel: string | null
  locationLat: string | null
  locationLng: string | null
  privacyMode: PrivacyMode
  publicPageConfig: unknown | null
  // #216 per-event feature toggles; raw JSON, resolved by
  // resolveEventFeatures at the route boundary. Never read raw.
  features: unknown | null
  // Slice 2 (planner personal events).
  scopeType: ScopeType
  startAt: Date | null
  endAt: Date | null
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
  // Count of bound personal tickets. Populated by the personal-event
  // reads (findById, listPersonalForUser); other reads report 0. Always
  // 0 for non-personal (group) events, which carry no personal_tickets.
  ticketCount: number
  // Slice 3b (ticket platform metadata). Null for events where the user
  // hasn't recorded where they bought tickets.
  ticketPlatform: string | null
  ticketAccountEmail: string | null
  // Issue #545: first-class all-day flag. null = pre-migration row (use inference);
  // false = timed; true = all-day.
  allDay: boolean | null
}

export interface CreateEventInput {
  id: string
  tenantId: string
  ownerUserId: string
  slug: string
  name: string
  description?: string | null
  startDate?: string | null
  endDate?: string | null
  timezone: string
  locationLabel?: string | null
  locationLat?: number | null
  locationLng?: number | null
  privacyMode: PrivacyMode
  // Slice 2 (planner personal events). scopeType omitted → column default 'personal'.
  scopeType?: ScopeType | undefined
  startAt?: Date | null | undefined
  endAt?: Date | null | undefined
  // Slice 3b (ticket platform metadata).
  ticketPlatform?: string | null | undefined
  ticketAccountEmail?: string | null | undefined
  // Issue #545: explicit all-day flag.
  allDay?: boolean | null | undefined
}

// Patch fields. `undefined` = leave alone; `null` = clear (for
// nullable columns). name/slug/timezone are non-nullable so they
// take a value or stay absent.
export interface PatchEventInput {
  name?: string | undefined
  slug?: string | undefined
  description?: string | null | undefined
  startDate?: string | null | undefined
  endDate?: string | null | undefined
  // Personal-event instant columns (planner events edit these; group
  // events use startDate/endDate). null clears the column.
  startAt?: Date | null | undefined
  endAt?: Date | null | undefined
  timezone?: string | undefined
  locationLabel?: string | null | undefined
  locationLat?: number | null | undefined
  locationLng?: number | null | undefined
  privacyMode?: PrivacyMode | undefined
  // Slice 11. The schema is enforced by PublicPageConfigSchema at the
  // route boundary; the repo persists the parsed jsonb verbatim.
  publicPageConfig?: unknown | null | undefined
  // #216 feature toggles; the route stores the fully-merged object.
  features?: unknown | null | undefined
  // Slice 3b (ticket platform metadata).
  ticketPlatform?: string | null | undefined
  ticketAccountEmail?: string | null | undefined
  // Issue #545: explicit all-day flag. undefined = not set; null = inherit from inference.
  allDay?: boolean | null | undefined
}

export interface ListEventsOptions {
  includeDeleted: boolean
  limit: number
  cursor?: string | null
}

export interface ListEventsPage {
  items: EventRecord[]
  nextCursor: string | null
}

export interface EventRepo {
  create(input: CreateEventInput): Promise<EventRecord>
  // Returns the row regardless of soft-delete state; callers decide
  // how to treat deletedAt.
  findById(id: string): Promise<EventRecord | null>
  // Slug uniqueness is on (tenant_id, slug) and ignores soft-delete,
  // so a deleted event still occupies its slug — this finds it.
  findBySlug(tenantId: string, slug: string): Promise<EventRecord | null>
  // Events the user owns ∪ collaborates on, newest first, cursor-paged.
  listForUser(userId: string, opts: ListEventsOptions): Promise<ListEventsPage>
  patch(id: string, fields: PatchEventInput): Promise<EventRecord | null>
  softDelete(id: string, when: Date): Promise<void>
  restore(id: string): Promise<void>
  // Sweep support (design §5.1.1). Soft-delete filter disabled: returns
  // events whose deleted_at is set and strictly older than `cutoff`,
  // i.e. past the grace window. Used only by the pruner.
  listSoftDeletedBefore(cutoff: Date): Promise<EventRecord[]>
  // Active events whose location is set AND whose date range
  // overlaps the (windowStart, windowEnd) span — backs the weather
  // refresher (slice 12). Returns max `limit` rows per call.
  listForWeatherRefresh(input: {
    windowStart: Date
    windowEnd: Date
    limit: number
  }): Promise<EventRecord[]>
  // Hard-purge a single event. Child rows (members/invites/activity)
  // disappear via their ON DELETE CASCADE FKs. Returns true iff a row
  // was actually deleted — lets the pruner stay racy-safe across
  // replicas (only the replica whose DELETE wins writes the audit).
  // Precondition: only call with ids from listSoftDeletedBefore — this
  // deletes by id regardless of deleted_at, so passing a live event id
  // would hard-purge a non-deleted event.
  hardDelete(id: string): Promise<boolean>
  // Slice 2 (planner personal events). List non-deleted personal events
  // for a given owner on the 'rallypoint' tenant. Optional time window
  // narrows by start_at: from (inclusive) to `to` (exclusive). Ordered
  // start_at ASC NULLS LAST, then id ASC.
  listPersonalForUser(
    ownerUserId: string,
    opts: { from?: Date | null | undefined; to?: Date | null | undefined },
  ): Promise<EventRecord[]>
  // Group (festival) events the user owns ∪ collaborates on (event_members)
  // ∪ currently attends (event_attendees with removed_at IS NULL), on the
  // 'rallypoint' tenant, non-deleted. Deduplicated so a user who is both an
  // owner and an attendee row appears once. Backs the authenticated
  // /sdk/user-events surface that Planner folds into upcoming/my-day.
  // Ordered start_date ASC NULLS LAST, then id ASC.
  listGroupForUser(userId: string): Promise<EventRecord[]>
  // Atomic ownership swap (design §3.5): event owner → newOwner, the
  // new owner's collaborator row is removed, the old owner is added
  // back as an editor. All in one transaction.
  transferOwnership(input: {
    eventId: string
    newOwnerUserId: string
    oldOwnerUserId: string
    oldOwnerMemberId: string
  }): Promise<void>
  // Atomic invite acceptance (#171). Writes event_members (skipped on
  // re-admission — the route pre-detects via `members.findByEventAndUser`
  // + `attendees.findByEventAndUser` and passes `skipMemberAdd: true`),
  // event_attendees (upsert clears `removed_at` for re-admission), and
  // marks the invite consumed — all in one transaction. Concurrent
  // double-accept hits a unique violation on event_members and surfaces
  // as `already_active_member` so the route can 409 it.
  acceptInvite(input: {
    memberId: string
    attendeeId: string
    eventId: string
    userId: string
    role: MemberRole
    inviteId: string
    skipMemberAdd: boolean
  }): Promise<
    { ok: true; readmitted: boolean } | { ok: false; reason: 'already_active_member' }
  >
}

// --- members -------------------------------------------------------

export interface MemberRecord {
  id: string
  eventId: string
  userId: string
  role: MemberRole
  joinedAt: Date
}

export interface EventMemberRepo {
  add(input: { id: string; eventId: string; userId: string; role: MemberRole }): Promise<MemberRecord>
  findByEventAndUser(eventId: string, userId: string): Promise<MemberRecord | null>
  updateRole(eventId: string, userId: string, role: MemberRole): Promise<void>
  listForEvent(eventId: string): Promise<MemberRecord[]>
}

// --- attendees (Phase 0) -------------------------------------------

// event_attendees rows. Independent of event_members (collaborators)
// and group_members (intra-event subgroups). removed_at=null means
// the user is currently considered "attending".
export interface AttendeeRecord {
  id: string
  eventId: string
  userId: string
  joinedAt: Date
  removedAt: Date | null
}

// --- tickets (Phase T) ---------------------------------------------

// event_tickets row. price_cents=0 = free tier; quantity=null =
// unlimited; sold_count tracks the denormalised purchase counter
// (always 0 in Phase T — selling lands later); deleted_at is the
// soft-delete marker.
export interface TicketRecord {
  id: string
  eventId: string
  name: string
  description: string | null
  priceCents: number
  quantity: number | null
  soldCount: number
  sortOrder: number
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

export interface CreateTicketInput {
  id: string
  eventId: string
  name: string
  description?: string | null
  priceCents: number
  quantity?: number | null
  sortOrder?: number
}

export interface PatchTicketInput {
  name?: string
  description?: string | null
  priceCents?: number
  quantity?: number | null
  sortOrder?: number
}

export interface EventTicketRepo {
  create(input: CreateTicketInput): Promise<TicketRecord>
  findById(id: string): Promise<TicketRecord | null>
  // Lists all tiers for an event, ordered by sort_order ASC then
  // created_at ASC. Includes soft-deleted rows so the owner can see
  // what was historically defined (the SDK / public surface filters
  // them out).
  listForEvent(eventId: string): Promise<TicketRecord[]>
  patch(id: string, fields: PatchTicketInput): Promise<TicketRecord | null>
  // Soft-delete. Returns 'sold' when sold_count > 0 (route maps to
  // 409). Returns 'ok' on success, 'not_found' if no row to act on.
  softDelete(id: string, when: Date): Promise<'ok' | 'sold' | 'not_found'>
  restore(id: string): Promise<TicketRecord | null>
}

export interface EventAttendeeRepo {
  // Upsert: if a row already exists for (event_id, user_id), this is a
  // no-op when removed_at is NULL, or "un-removes" + refreshes
  // joined_at when removed_at is set. Returns the resulting row.
  upsert(input: { id: string; eventId: string; userId: string }): Promise<AttendeeRecord>
  findByEventAndUser(eventId: string, userId: string): Promise<AttendeeRecord | null>
  // Soft-remove: sets removed_at. No-op if the row doesn't exist or is
  // already removed. Caller checks owner-self protection at the route.
  softRemove(eventId: string, userId: string, when: Date): Promise<void>
  // List current attendees (removed_at IS NULL) for an event, paginated
  // by joined_at ASC. cursor is the last seen joined_at instant.
  listForEvent(
    eventId: string,
    opts: { limit: number; cursor: Date | null },
  ): Promise<{ items: AttendeeRecord[]; nextCursor: Date | null }>
}

// --- invites -------------------------------------------------------

export interface InviteRecord {
  id: string
  eventId: string
  codeHash: string
  invitedByUserId: string
  invitedEmail: string | null
  role: MemberRole
  createdAt: Date
  expiresAt: Date
  consumedAt: Date | null
  consumedByUserId: string | null
}

export interface EventInviteRepo {
  create(input: {
    id: string
    eventId: string
    codeHash: string
    invitedByUserId: string
    invitedEmail: string | null
    role: AssignableRole
    expiresAt: Date
  }): Promise<InviteRecord>
  findByCodeHash(codeHash: string): Promise<InviteRecord | null>
  markConsumed(id: string, consumedByUserId: string, when: Date): Promise<void>
  listForEvent(eventId: string): Promise<InviteRecord[]>
  // Phase 0 additions for the new invites surface.
  findById(id: string): Promise<InviteRecord | null>
  // Hard-delete a not-yet-consumed invite — used by the owner's
  // "revoke pending invite" button. Returns true iff a row was
  // removed (the row existed and consumed_at IS NULL).
  deletePending(id: string): Promise<boolean>
}

// --- activity (owner-facing audit log) -----------------------------

export interface ActivityRecord {
  id: string
  eventId: string
  actorUserId: string
  eventType: string
  meta: Record<string, unknown>
  createdAt: Date
}

export interface EventActivityRepo {
  record(input: {
    id: string
    eventId: string
    actorUserId: string
    eventType: string
    meta?: Record<string, unknown>
  }): Promise<void>
  listForEvent(eventId: string): Promise<ActivityRecord[]>
}

// --- purge log (operator/forensic hard-delete audit, design §5.1.1)-

// The durable home of the `event.hard_deleted` audit event. Unlike
// event_activity, this table does NOT cascade with the event — it is
// written precisely because the event row is being destroyed.
export interface PurgeLogRecord {
  id: string
  eventId: string
  ownerUserId: string
  tenantId: string
  deletedAt: Date
  purgedAt: Date
  daysAfterGrace: number
  objectsReaped: number
  objectsFailed: number
  meta: Record<string, unknown>
}

export interface EventPurgeLogRepo {
  record(input: {
    id: string
    eventId: string
    ownerUserId: string
    tenantId: string
    deletedAt: Date
    daysAfterGrace: number
    objectsReaped: number
    objectsFailed: number
    meta?: Record<string, unknown>
  }): Promise<void>
  // Operator/forensic read-back. Newest first.
  listForEvent(eventId: string): Promise<PurgeLogRecord[]>
}

// --- lineup: stages (design §5.2) ----------------------------------

export interface StageRecord {
  id: string
  eventId: string
  name: string
  sortOrder: number
}

export interface EventStageRepo {
  create(input: {
    id: string
    eventId: string
    name: string
    sortOrder?: number | undefined
  }): Promise<StageRecord>
  findById(id: string): Promise<StageRecord | null>
  listForEvent(eventId: string): Promise<StageRecord[]>
  update(
    id: string,
    fields: { name?: string | undefined; sortOrder?: number | undefined },
  ): Promise<StageRecord | null>
  delete(id: string): Promise<boolean>
}

// --- lineup: days (design §5.2) ------------------------------------

// `date` is the driver's 'YYYY-MM-DD' string, like EventRecord dates.
export interface DayRecord {
  id: string
  eventId: string
  dayLabel: string
  date: string
  // The day's own optional window, 'HH:MM' or null. Both null = all-day.
  startTime: string | null
  endTime: string | null
  sortOrder: number
}

export interface EventDayRepo {
  create(input: {
    id: string
    eventId: string
    dayLabel: string
    date: string
    startTime?: string | null | undefined
    endTime?: string | null | undefined
    sortOrder?: number | undefined
  }): Promise<DayRecord>
  // Atomic batch insert for quick-create-days. All rows commit together
  // or none do (one transaction); a unique collision aborts the batch.
  createMany(
    rows: { id: string; eventId: string; dayLabel: string; date: string; sortOrder?: number | undefined }[],
  ): Promise<DayRecord[]>
  findById(id: string): Promise<DayRecord | null>
  listForEvent(eventId: string): Promise<DayRecord[]>
  // Batch variant of listForEvent: every day row for the given event ids in
  // a single round-trip (avoids an N+1 over a user's group events, #307).
  // Returns all rows flat — callers group by `eventId`. Empty input → [].
  listForEventsIn(eventIds: string[]): Promise<DayRecord[]>
  update(
    id: string,
    fields: {
      dayLabel?: string | undefined
      date?: string | undefined
      startTime?: string | null | undefined
      endTime?: string | null | undefined
      sortOrder?: number | undefined
    },
  ): Promise<DayRecord | null>
  delete(id: string): Promise<boolean>
}

// --- artists: global cross-event catalog (design §5.2) -------------

export interface ArtistLinks {
  soundcloud?: string | null | undefined
  spotify?: string | null | undefined
  appleMusic?: string | null | undefined
  youtubeMusic?: string | null | undefined
  instagram?: string | null | undefined
}

export interface ArtistRecord {
  id: string
  name: string
  soundcloud: string | null
  spotify: string | null
  appleMusic: string | null
  youtubeMusic: string | null
  instagram: string | null
  updatedAt: Date
}

export interface ArtistRepo {
  create(input: { id: string; name: string } & ArtistLinks): Promise<ArtistRecord>
  findById(id: string): Promise<ArtistRecord | null>
  // Case-insensitive lookup against the unique(lower(name)) index —
  // backs the route's find-or-create.
  findByName(name: string): Promise<ArtistRecord | null>
  // Prefix/substring search for the editor's artist picker.
  search(query: string, limit: number): Promise<ArtistRecord[]>
  update(id: string, fields: { name?: string | undefined } & ArtistLinks): Promise<ArtistRecord | null>
}

// --- event_artists: lineup slots (design §5.2) ---------------------

// `startTime`/`endTime` are the driver's 'HH:MM:SS' strings. The PK is
// (eventId, artistId, dayId), so an artist on multiple days has one
// row per day.
export interface EventArtistRecord {
  eventId: string
  artistId: string
  dayId: string
  stageId: string | null
  tier: string | null
  genre: string | null
  startTime: string | null
  endTime: string | null
  displayName: string | null
}

export interface EventArtistRepo {
  // Insert-or-replace on the (eventId, artistId, dayId) PK.
  upsert(input: EventArtistRecord): Promise<EventArtistRecord>
  // Atomic batch upsert for the editor's bulk-assign flow.
  bulkUpsert(rows: EventArtistRecord[]): Promise<EventArtistRecord[]>
  // Atomic batch upsert + delete for the editor's "save changes" grid.
  bulkApply(
    eventId: string,
    input: {
      upserts: EventArtistRecord[]
      deletes: { artistId: string; dayId: string }[]
    },
  ): Promise<{ upserted: EventArtistRecord[]; deleted: number }>
  find(eventId: string, artistId: string, dayId: string): Promise<EventArtistRecord | null>
  listForEvent(eventId: string): Promise<EventArtistRecord[]>
  delete(eventId: string, artistId: string, dayId: string): Promise<boolean>
  // Non-destructive restore from a snapshot (#191 Phase 2): in one
  // transaction, upsert every `rows` entry, then delete only the current
  // rows whose (artistId, dayId) key is absent from `rows`. Surviving
  // slots keep their identity (and any attendee set-stars FK'd to them).
  // Returns the post-restore row set.
  replaceAll(eventId: string, rows: EventArtistRecord[]): Promise<EventArtistRecord[]>
}

// --- event sessions: schedulable activities (design §5.3) ----------

export type SessionApprovalStatus = 'approved' | 'pending' | 'rejected'
export type SessionVisibility = 'admin' | 'private' | 'group' | 'custom'

// `startTime`/`endTime` are the driver's 'HH:MM:SS' strings (like
// EventArtistRecord). `sharedWith` is the parsed jsonb array of user_ids
// (visibility='custom'); null otherwise.
export interface SessionRecord {
  id: string
  eventId: string
  title: string
  description: string | null
  location: string | null
  dayId: string | null
  stageId: string | null
  startTime: string | null
  endTime: string | null
  category: string | null
  host: string | null
  approvalStatus: SessionApprovalStatus
  visibility: SessionVisibility
  groupId: string | null
  sharedWith: string[] | null
  createdByUserId: string
  submittedByUserId: string | null
  approvedByUserId: string | null
  approvedAt: Date | null
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

export interface CreateSessionInput {
  id: string
  eventId: string
  title: string
  description?: string | null
  location?: string | null
  dayId?: string | null
  stageId?: string | null
  startTime?: string | null
  endTime?: string | null
  category?: string | null
  host?: string | null
  approvalStatus: SessionApprovalStatus
  visibility: SessionVisibility
  groupId?: string | null
  sharedWith?: string[] | null
  createdByUserId: string
  submittedByUserId?: string | null
  // Owner-authored sessions land pre-approved; the approver stamp is
  // written in the SAME insert (no separate setApproval round-trip) so
  // the approved row can't briefly exist un-stamped — important for the
  // bulk path where the stamp would otherwise fall outside the txn.
  approvedByUserId?: string | null
  approvedAt?: Date | null
}

// Patch fields: `undefined` = leave alone; `null` = clear nullable
// columns. Approval state is NOT patchable here — it moves only through
// setApproval so the workflow stays the single writer of those columns.
export interface PatchSessionInput {
  title?: string | undefined
  description?: string | null | undefined
  location?: string | null | undefined
  dayId?: string | null | undefined
  stageId?: string | null | undefined
  startTime?: string | null | undefined
  endTime?: string | null | undefined
  category?: string | null | undefined
  host?: string | null | undefined
  visibility?: SessionVisibility | undefined
  groupId?: string | null | undefined
  sharedWith?: string[] | null | undefined
}

export interface ListSessionsOptions {
  includeDeleted?: boolean | undefined
  approvalStatus?: SessionApprovalStatus | undefined
  dayId?: string | undefined
}

export interface BulkApplySessionsInput {
  // The owning event. Updates and deletes are scoped to this event id
  // (and to non-deleted rows) so a foreign session id can't be mutated
  // or soft-deleted through another event's bulk endpoint.
  eventId: string
  creates: CreateSessionInput[]
  updates: Array<{ id: string; patch: PatchSessionInput }>
  deletes: string[]
}

export interface BulkApplySessionsResult {
  created: SessionRecord[]
  updated: SessionRecord[]
}

export interface EventSessionRepo {
  create(input: CreateSessionInput): Promise<SessionRecord>
  // Returns the row regardless of soft-delete state; callers decide.
  findById(id: string): Promise<SessionRecord | null>
  // Newest first. Filters out soft-deleted unless includeDeleted; can
  // narrow by approvalStatus and/or dayId.
  listForEvent(eventId: string, opts?: ListSessionsOptions): Promise<SessionRecord[]>
  patch(id: string, fields: PatchSessionInput): Promise<SessionRecord | null>
  // The sole writer of approval_status + approver columns. Stamps
  // approved_by_user_id/approved_at on approve/reject; pass null for
  // both to clear them on the submit→pending transition. When
  // submittedByUserId is provided it overwrites submitted_by_user_id
  // (a re-submit records the new submitter); undefined leaves it.
  setApproval(
    id: string,
    input: {
      status: SessionApprovalStatus
      approvedByUserId: string | null
      approvedAt: Date | null
      submittedByUserId?: string | null
    },
  ): Promise<SessionRecord | null>
  softDelete(id: string, when: Date): Promise<void>
  // Transactional bulk create + update + delete in one call (slice 1C).
  // Creates are inserted; updates apply the patch fields; deletes are
  // soft-deleted. All operations run inside a single transaction so a
  // partial failure rolls back everything.
  bulkApply(input: BulkApplySessionsInput): Promise<BulkApplySessionsResult>
  // Non-destructive restore from a snapshot (#191 Phase 2): in one
  // transaction, upsert every `rows` entry by id (clearing deleted_at,
  // stamping updated_at), then soft-delete only the currently-active
  // rows whose id is absent from `rows`. Returns the active row set
  // after the restore.
  restoreActive(eventId: string, rows: SessionRecord[], when: Date): Promise<SessionRecord[]>
}

// --- sessions (events-side session store, design §3.13) ------------

export interface EventsSessionRecord {
  idHash: string
  userId: string
  rpidBearerCiphertext: Buffer
  rpidBearerNonce: Buffer
  rpidBearerKeyVersion: number
  createdAt: Date
  lastSeenAt: Date
  absoluteExpiresAt: Date
  ipHash: string
  uaHash: string
}

export interface EventsSessionRepo {
  create(record: Omit<EventsSessionRecord, 'createdAt' | 'lastSeenAt'> & {
    createdAt?: Date
    lastSeenAt?: Date
  }): Promise<void>
  findByIdHash(idHash: string): Promise<EventsSessionRecord | null>
  touchLastSeen(idHash: string, when: Date): Promise<void>
  deleteByIdHash(idHash: string): Promise<void>
  /**
   * Hard-delete every session whose absolute_expires_at is at or
   * before `cutoff`. Returns the count purged. Called from the
   * events pruner so the table doesn't grow unbounded — sessions are
   * invalidated on the in-memory cache as their absolute TTL passes,
   * but the DB row only goes when its bearer next presents (which it
   * never will). See issue #91.
   */
  deleteExpiredBefore(cutoff: Date): Promise<number>
}

// --- maps (design §5.4) --------------------------------------------

export type MapLayer = 'site' | 'camp' | 'full'

export interface MapRecord {
  id: string
  eventId: string
  layer: string
  objectKey: string
  contentType: string
  bytes: number
  widthPx: number
  heightPx: number
  uploadedByUserId: string
  uploadedAt: Date
}

export interface EventMapRepo {
  // Throws UniqueConstraintError (constraintName = the real PG constraint) on
  // the (event_id, layer) clash → route maps 409 map_layer_taken.
  create(input: {
    id: string
    eventId: string
    layer: string
    objectKey: string
    contentType: string
    bytes: number
    widthPx: number
    heightPx: number
    uploadedByUserId: string
  }): Promise<MapRecord>
  findById(id: string): Promise<MapRecord | null>
  listForEvent(eventId: string): Promise<MapRecord[]>
  delete(id: string): Promise<boolean>
}

// --- POIs (design §5.4) --------------------------------------------

// numeric(8,5)/(9,6) columns come back as strings (like EventRecord
// lat/lng); the route converts at its boundary. x_pct/y_pct are
// always present (notNull); lat/lng are nullable.
export interface PoiRecord {
  id: string
  eventId: string
  mapId: string | null
  categoryId: string
  name: string
  description: string | null
  xPct: string
  yPct: string
  lat: string | null
  lng: string | null
  sortOrder: number
  createdAt: Date
  updatedAt: Date
}

export interface PatchPoiInput {
  mapId?: string | null | undefined
  categoryId?: string | undefined
  name?: string | undefined
  description?: string | null | undefined
  xPct?: number | undefined
  yPct?: number | undefined
  lat?: number | null | undefined
  lng?: number | null | undefined
  sortOrder?: number | undefined
}

export interface EventPoiRepo {
  create(input: {
    id: string
    eventId: string
    mapId?: string | null
    categoryId: string
    name: string
    description?: string | null
    xPct: number
    yPct: number
    lat?: number | null
    lng?: number | null
    sortOrder?: number | undefined
  }): Promise<PoiRecord>
  findById(id: string): Promise<PoiRecord | null>
  listForEvent(eventId: string): Promise<PoiRecord[]>
  update(id: string, fields: PatchPoiInput): Promise<PoiRecord | null>
  delete(id: string): Promise<boolean>
}

// --- no-go zones (design §5.4) -------------------------------------

export interface ZoneVertex {
  xPct: number
  yPct: number
}

export interface ZoneRecord {
  id: string
  eventId: string
  mapId: string
  polygon: ZoneVertex[]
}

export interface PatchZoneInput {
  mapId?: string | undefined
  polygon?: ZoneVertex[] | undefined
}

export interface EventNoGoZoneRepo {
  create(input: {
    id: string
    eventId: string
    mapId: string
    polygon: ZoneVertex[]
  }): Promise<ZoneRecord>
  findById(id: string): Promise<ZoneRecord | null>
  listForEvent(eventId: string): Promise<ZoneRecord[]>
  update(id: string, fields: PatchZoneInput): Promise<ZoneRecord | null>
  delete(id: string): Promise<boolean>
}

// --- groups (design §5.5) -------------------------------------------

export type GroupRole = 'owner' | 'sidekick' | 'member'
export type AssignableGroupRole = 'sidekick' | 'member'

// Dates come back from the driver as 'YYYY-MM-DD' strings (like
// EventRecord). owner_user_id is a `user_<ulid>` (not FK'd). Groups
// hard-delete — there is no soft-delete column.
export interface GroupRecord {
  id: string
  eventId: string
  name: string
  description: string | null
  startDate: string | null
  endDate: string | null
  joinCodeHash: string
  // #440: 6-char human-friendly code; null for pre-#440 rows until
  // lazily backfilled.
  shortCode: string | null
  ownerUserId: string
  createdAt: Date
  updatedAt: Date
}

export interface CreateGroupInput {
  id: string
  eventId: string
  name: string
  description?: string | null
  startDate?: string | null
  endDate?: string | null
  joinCodeHash: string
  shortCode?: string | null
  ownerUserId: string
}

// Patch fields: `undefined` = leave alone; `null` = clear nullable
// columns. name is non-nullable so it takes a value or stays absent.
export interface PatchGroupInput {
  name?: string | undefined
  description?: string | null | undefined
  startDate?: string | null | undefined
  endDate?: string | null | undefined
}

export interface GroupRepo {
  // Throws UniqueConstraintError (constraintName = the real PG constraint) on
  // a unique clash — e.g. groups_event_name_idx on (event_id, name) or
  // groups_join_code_hash_idx on join_code_hash → route maps 409 group_name_taken.
  create(input: CreateGroupInput): Promise<GroupRecord>
  findById(id: string): Promise<GroupRecord | null>
  // Backs the join-by-code resolver's FIRST lookup (design §5.5):
  // an active group join code wins over a stale invite.
  findByJoinCodeHash(joinCodeHash: string): Promise<GroupRecord | null>
  // #440: 6-char short-code lookup (uppercase, pre-normalized).
  findByShortCode(shortCode: string): Promise<GroupRecord | null>
  // #440: one batched lookup backing My Events' attendee routing —
  // for each of the given events, the FIRST group (by join order)
  // the user is a member of. Map key = eventId, value = groupId.
  listUserGroupIdsByEvent(userId: string, eventIds: string[]): Promise<Map<string, string>>
  // #440: lazy backfill for pre-#440 groups. Throws
  // UniqueConstraintError on a collision so the caller can retry.
  setShortCode(id: string, shortCode: string): Promise<GroupRecord | null>
  listForEvent(eventId: string): Promise<GroupRecord[]>
  patch(id: string, fields: PatchGroupInput): Promise<GroupRecord | null>
  // Hard-delete a group. group_members + group_invites disappear via their
  // ON DELETE CASCADE FKs; event_sessions.group_id is SET NULL. Returns
  // true iff a row was deleted.
  delete(id: string): Promise<boolean>
  // Atomic group-ownership swap: groups.owner_user_id → newOwner, the new
  // owner's member row becomes 'owner', the old owner's member row
  // becomes 'sidekick'. All in one transaction.
  transferOwnership(input: {
    groupId: string
    newOwnerUserId: string
    oldOwnerUserId: string
  }): Promise<void>
  // Atomic create-with-owner (#171). Writes the group row, the owner
  // member row, and (when the creator isn't the event owner) the
  // attendee row in one transaction. Throws UniqueConstraintError
  // (constraintName = real PG constraint) on name collision so the
  // route's existing catch block still maps 409 group_name_taken.
  // `attendeeId: null` skips the attendee write (event owner — owner
  // doesn't carry an event_attendees row by Phase 0 design).
  createWithOwner(input: {
    group: CreateGroupInput
    ownerMemberId: string
    attendeeId: string | null
  }): Promise<GroupRecord>
  // Atomic join-with-attendee (#171, cap dropped #313). Folds invite
  // consumption (when joining via an invite code) and the attendee
  // upsert into the same operation. Re-admission: when an existing
  // member row is found AND the user's event_attendees row is
  // soft-removed, the join returns `{ ok: true, readmitted: true }`
  // and clears `removed_at` via the upsert. Groups are uncapped.
  // `inviteId: null` for the standing-join-code path.
  // `attendeeId: null` for the event-owner path (no attendees row).
  joinWithAttendee(input: {
    memberId: string
    groupId: string
    userId: string
    inviteId: string | null
    attendeeId: string | null
    eventId: string
  }): Promise<
    { ok: true; readmitted: boolean } | { ok: false; reason: 'duplicate_active' }
  >
}

// --- group members --------------------------------------------------

export interface GroupMemberRecord {
  id: string
  groupId: string
  userId: string
  role: GroupRole
  joinedAt: Date
}

export interface GroupMemberRepo {
  add(input: { id: string; groupId: string; userId: string; role: GroupRole }): Promise<GroupMemberRecord>
  findByGroupAndUser(groupId: string, userId: string): Promise<GroupMemberRecord | null>
  listForGroup(groupId: string): Promise<GroupMemberRecord[]>
  // Display/count helper — used by serializeGroup and the group list
  // route to surface member counts. Cap enforcement dropped (#313).
  countForGroup(groupId: string): Promise<number>
  updateRole(groupId: string, userId: string, role: GroupRole): Promise<void>
  remove(groupId: string, userId: string): Promise<boolean>
}

// --- group invites --------------------------------------------------

// No role column — accept always lands the joiner as 'member' (§5.5).
export interface GroupInviteRecord {
  id: string
  groupId: string
  codeHash: string
  invitedByUserId: string
  invitedEmail: string | null
  createdAt: Date
  expiresAt: Date
  consumedAt: Date | null
  consumedByUserId: string | null
}

export interface GroupInviteRepo {
  create(input: {
    id: string
    groupId: string
    codeHash: string
    invitedByUserId: string
    invitedEmail: string | null
    expiresAt: Date
  }): Promise<GroupInviteRecord>
  // The join-by-code resolver's SECOND lookup (design §5.5), checked
  // only after groups.findByJoinCodeHash misses.
  findByCodeHash(codeHash: string): Promise<GroupInviteRecord | null>
  markConsumed(id: string, consumedByUserId: string, when: Date): Promise<void>
  listForGroup(groupId: string): Promise<GroupInviteRecord[]>
}

// --- rallies (slice 9b) --------------------------------------------

export type RallyStatus = 'proposed' | 'active' | 'cancelled'
export type RallyRsvpStatus = 'going' | 'maybe' | 'out'

export interface RallyRecord {
  id: string
  groupId: string
  eventId: string
  title: string
  description: string | null
  dayId: string | null
  // Postgres `time` round-trips as a string (e.g. '18:30:00').
  startTime: string | null
  poiId: string | null
  locationLabel: string | null
  // Postgres `numeric` round-trips as a string to preserve precision.
  lat: string | null
  lng: string | null
  status: RallyStatus
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

export interface CreateRallyInput {
  id: string
  groupId: string
  eventId: string
  title: string
  description?: string | null
  dayId?: string | null
  startTime?: string | null
  poiId?: string | null
  locationLabel?: string | null
  lat?: string | null
  lng?: string | null
  status?: RallyStatus
  createdBy: string
}

// Patch fields: `undefined` = leave alone; `null` = clear nullable
// columns. title/status are non-nullable so they take a value or stay
// absent.
export interface PatchRallyInput {
  title?: string | undefined
  description?: string | null | undefined
  dayId?: string | null | undefined
  startTime?: string | null | undefined
  poiId?: string | null | undefined
  locationLabel?: string | null | undefined
  lat?: string | null | undefined
  lng?: string | null | undefined
  status?: RallyStatus | undefined
}

export interface RallyRepo {
  create(input: CreateRallyInput): Promise<RallyRecord>
  findById(id: string): Promise<RallyRecord | null>
  listForGroup(groupId: string): Promise<RallyRecord[]>
  patch(id: string, fields: PatchRallyInput): Promise<RallyRecord | null>
  // Hard-delete a rally. rally_attendees disappear via ON DELETE
  // CASCADE. Returns true iff a row was deleted.
  delete(id: string): Promise<boolean>
}

export interface RallyAttendeeRecord {
  id: string
  rallyId: string
  userId: string
  status: RallyRsvpStatus
  respondedAt: Date
}

export interface RallyAttendeeRepo {
  // Upsert on (rally_id, user_id): re-RSVPing updates status +
  // responded_at rather than inserting a duplicate.
  upsert(input: {
    id: string
    rallyId: string
    userId: string
    status: RallyRsvpStatus
  }): Promise<RallyAttendeeRecord>
  listForRally(rallyId: string): Promise<RallyAttendeeRecord[]>
  // Batch fetch for the per-group listing (avoids N+1 over rallies).
  listForRallies(rallyIds: string[]): Promise<RallyAttendeeRecord[]>
  // Drop a user's RSVPs across all of a group's rallies. Called when
  // the user leaves / is removed from the group so stale rows don't
  // keep inflating rsvp_summary. Returns the number of rows removed.
  deleteForUserInGroup(groupId: string, userId: string): Promise<number>
}

// --- chat messages (slice 10, #72) ---------------------------------

export interface ChatMessageRecord {
  id: string
  groupId: string
  userId: string
  body: string
  createdAt: Date
}

export interface CreateChatMessageInput {
  id: string
  groupId: string
  userId: string
  body: string
}

export interface ListChatOptions {
  // Reverse-chron page boundary: return messages strictly OLDER than the
  // message with this id (load-older cursor). Absent → newest page.
  before?: string | undefined
  limit: number
}

export interface ChatMessageRepo {
  create(input: CreateChatMessageInput): Promise<ChatMessageRecord>
  findById(id: string): Promise<ChatMessageRecord | null>
  // Newest first. `before` pages backwards from a known message id; rows
  // older than that message's created_at are returned (ties broken by id).
  listForGroup(groupId: string, opts: ListChatOptions): Promise<ChatMessageRecord[]>
}

// --- event set stars (issue #194) ---------------------------------

// A star key identifies the (eventId, artistId, dayId) triple that
// a user starred. Mirrors the event_artists composite PK.
export interface SetStarKey {
  eventId: string
  artistId: string
  dayId: string
}

export interface EventSetStarRepo {
  // Idempotent star: INSERT … ON CONFLICT DO NOTHING. Returns true if
  // a new row was written, false if the star already existed.
  star(userId: string, key: SetStarKey): Promise<boolean>
  // Unstar: DELETE WHERE (userId, eventId, artistId, dayId). Returns
  // true iff a row was removed.
  unstar(userId: string, key: SetStarKey): Promise<boolean>
  // List all set keys starred by the user for a given event.
  listForUserEvent(userId: string, eventId: string): Promise<SetStarKey[]>
  // Check whether a specific set is starred by the user.
  isStarred(userId: string, key: SetStarKey): Promise<boolean>
}

// --- event_weather (slice 12) -------------------------------------

export interface EventWeatherRecord {
  eventId: string
  forecast: unknown | null // see services/weather/types.WeatherForecastDto
  airQuality: unknown | null // see services/weather/types.AirQualityDto
  fetchedLat: string | null
  fetchedLng: string | null
  fetchedAt: Date
  errorAt: Date | null
  errorCode: string | null
  updatedAt: Date
}

export interface UpsertEventWeatherInput {
  eventId: string
  forecast: unknown | null
  airQuality: unknown | null
  fetchedLat: string | null
  fetchedLng: string | null
  // Pass null clears any prior error stamp. The repo upserts the
  // success row and zeroes error_at/error_code at the same time.
  errorAt?: Date | null
  errorCode?: string | null
}

export interface EventWeatherRepo {
  findByEventId(eventId: string): Promise<EventWeatherRecord | null>
  // Insert-or-update by event_id. updated_at is always stamped to now.
  // When `errorAt` is undefined, the call treats it as a successful
  // refresh and clears any prior error fields.
  upsert(input: UpsertEventWeatherInput): Promise<EventWeatherRecord>
  // Mark a refresh attempt as failed without clobbering the cached
  // forecast/air_quality from the last good response.
  markError(eventId: string, errorCode: string, when: Date): Promise<void>
}

// --- event snapshots: bulk-edit version history (#191 Phase 2) ------

export type SnapshotKind = 'lineup' | 'sessions'

// One captured version of an entity set for an event. `data` is the
// raw jsonb array of records as they were at capture time (lineup =
// EventArtistRecord[] of pure strings; sessions = SessionRecord[] with
// dates serialised as ISO strings — deserialised on restore).
export interface SnapshotRecord {
  id: string
  eventId: string
  kind: SnapshotKind
  data: unknown
  reason: string
  itemCount: number
  createdByUserId: string
  createdAt: Date
}

export interface CreateSnapshotInput {
  id: string
  eventId: string
  kind: SnapshotKind
  data: unknown
  reason: string
  itemCount: number
  createdByUserId: string
}

// Metadata-only view for the history list (omits the heavy `data`).
export interface SnapshotSummary {
  id: string
  eventId: string
  kind: SnapshotKind
  reason: string
  itemCount: number
  createdByUserId: string
  createdAt: Date
}

export interface EventSnapshotRepo {
  create(input: CreateSnapshotInput): Promise<SnapshotRecord>
  findById(id: string): Promise<SnapshotRecord | null>
  // Newest-first metadata list for an (event, kind).
  listForEvent(eventId: string, kind: SnapshotKind): Promise<SnapshotSummary[]>
  // Retention: keep the newest `keep` snapshots for an (event, kind),
  // hard-delete the rest. Returns the count pruned.
  prune(eventId: string, kind: SnapshotKind, keep: number): Promise<number>
}

// --- personal tickets (Planner slice 3) ----------------------------

// personal_tickets rows — ticket-file attachments for personal events.
// id is `pkt_<ulid>`. objectKey is never surfaced to API callers.
export interface PersonalTicketRecord {
  id: string
  eventId: string
  objectKey: string
  contentType: string
  bytes: number
  fileName: string | null
  uploadedByUserId: string
  uploadedAt: Date
}

export interface CreatePersonalTicketInput {
  id: string
  eventId: string
  objectKey: string
  contentType: string
  bytes: number
  fileName?: string | null | undefined
  uploadedByUserId: string
}

export interface PersonalTicketRepo {
  create(input: CreatePersonalTicketInput): Promise<PersonalTicketRecord>
  listForEvent(eventId: string): Promise<PersonalTicketRecord[]>
  findById(id: string): Promise<PersonalTicketRecord | null>
}

// --- event planner prefs (per-user "show in planner" flag) ---------

// event_planner_prefs — one row per (user, event). show_in_planner
// controls whether the group event surfaces in the Planner sidebar.
// Per-user overlay: user A flagging an event has no effect on user B's view.
export interface EventPlannerPrefRepo {
  // INSERT … ON CONFLICT DO UPDATE — idempotent, single round-trip.
  upsert(eventId: string, userId: string, show: boolean): Promise<void>
  // Returns event_id values where show_in_planner = true for this user.
  flaggedEventIdsForActor(userId: string): Promise<string[]>
}

// --- rate limiting (sliding-window per-IP and per-user) -------------

// Imported from @rallypoint/rate-limit at the implementation layer;
// the interface is declared there. We re-export the type alias here so
// it sits alongside the rest of the repo bag without pulling in the
// implementation package at the interface level.
import type { RateLimitRepo } from '@rallypoint/rate-limit'
export type { RateLimitRepo }

// --- the bag -------------------------------------------------------

export interface Repos {
  events: EventRepo
  members: EventMemberRepo
  invites: EventInviteRepo
  attendees: EventAttendeeRepo
  tickets: EventTicketRepo
  activity: EventActivityRepo
  purgeLog: EventPurgeLogRepo
  stages: EventStageRepo
  days: EventDayRepo
  artists: ArtistRepo
  eventArtists: EventArtistRepo
  eventSessions: EventSessionRepo
  sessions: EventsSessionRepo
  maps: EventMapRepo
  pois: EventPoiRepo
  noGoZones: EventNoGoZoneRepo
  groups: GroupRepo
  groupMembers: GroupMemberRepo
  groupInvites: GroupInviteRepo
  rallies: RallyRepo
  rallyAttendees: RallyAttendeeRepo
  chatMessages: ChatMessageRepo
  eventWeather: EventWeatherRepo
  eventSetStars: EventSetStarRepo
  eventSnapshots: EventSnapshotRepo
  personalTickets: PersonalTicketRepo
  eventPlannerPrefs: EventPlannerPrefRepo
  rateLimit: RateLimitRepo
}
