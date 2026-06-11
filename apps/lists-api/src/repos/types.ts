import type {
  DayCode,
  FieldDefOptions,
  FieldType,
  GroupRole,
  ListType,
  RecurrenceFreq,
  ScopeType,
  TaskPriority,
  TaskStatus,
  ValidatedFilter,
  ValidatedSort,
  ViewConfig,
  Visibility,
} from '@rallypoint/lists-shared'
import type { RateLimitRepo } from '@rallypoint/rate-limit'

// Locked repo shapes for lists-api. Each interface has a Postgres impl
// (repos/pg/*) and an in-memory impl (repos/memory.ts) for unit tests.
// lists-api writes ONLY to the lists_v1 schema — it takes no dependency
// on @rallypoint/db; the RPID side is reached over HTTP via the
// services layer.

// --- lists ---------------------------------------------------------

// created_by holds a Rallypoint ID `user_<ulid>`; scope_id holds an
// Events group_id (scope_type=group) or a Lists-local list_groups id
// (scope_type=list_group). Neither is a cross-schema FK.
export interface ListRecord {
  id: string
  tenantId: string
  scopeType: ScopeType
  scopeId: string
  listType: ListType
  name: string
  visibility: Visibility
  color: string | null
  createdBy: string
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
  // Count of live (non-deleted, non-completed) items in this list.
  // Populated by listForScope (the SDK list read); create/findById
  // report 0 since they don't aggregate items.
  incompleteCount: number
}

export interface CreateListInput {
  id: string
  tenantId: string
  scopeType: ScopeType
  scopeId: string
  listType: ListType
  name: string
  visibility: Visibility
  color?: string | null
  createdBy: string
}

export interface ListScope {
  tenantId: string
  scopeType: ScopeType
  scopeId: string
}

export interface ListRepo {
  create(input: CreateListInput): Promise<ListRecord>
  findById(id: string): Promise<ListRecord | null>
  // Batch lookup by ids. Returns one entry per id in input order; missing
  // or hard-deleted ids map to null. Soft-deleted rows are returned as-is
  // (callers gate on deletedAt). Preserves input ordering.
  findByIds(ids: string[]): Promise<(ListRecord | null)[]>
  // Active (non-deleted) lists within a scope, newest first.
  listForScope(scope: ListScope): Promise<ListRecord[]>
  softDelete(id: string, when: Date): Promise<void>
  // Atomic share-invite acceptance (#128, mirrors events-api
  // EventRepo.acceptInvite from #171). Inserts a list_shares row +
  // marks the list_invite consumed in one transaction. A concurrent
  // double-accept hits the (list_id, user_id) unique index and surfaces
  // as `already_shared` so the route can 409 it. The route does the
  // invite-liveness pre-reads (expired/consumed) outside the tx —
  // accepted TOCTOU, mirrors the events flow.
  acceptInvite(input: {
    shareId: string
    inviteId: string
    listId: string
    userId: string
    // Audit field for the resulting list_shares row: who created the
    // share. Usually the invite's `invited_by_user_id` (the list
    // creator who minted the invite), NOT the accepting user.
    addedByUserId: string
  }): Promise<
    | { ok: true }
    | { ok: false; reason: 'already_shared' | 'invite_already_consumed' }
  >
  // Outcomes:
  //   ok:true                       — first-time accept; share created.
  //   reason='invite_already_consumed' — loser of a concurrent-accept
  //                                    race (some other user's tx
  //                                    won the invite-consume UPDATE).
  //   reason='already_shared'       — idempotent re-accept by the same
  //                                    user (the invite was already
  //                                    consumed by them, and a share
  //                                    row already exists).
}

// --- list items ----------------------------------------------------

// The generic item primitive. assigned_to holds a Rallypoint ID
// `user_<ulid>` (single owner) and is NOT a cross-schema FK. completed/
// completedAt is the check-off state; position is per-list integer
// ordering. deletedAt is the soft-delete marker (30-day restore window).
// status/priority/dueDate are the task-type extension fields (slice 3);
// null on non-task items. For a task list `status` drives completed.
export interface ListItemRecord {
  id: string
  tenantId: string
  listId: string
  title: string
  notes: string | null
  assignedTo: string | null
  completed: boolean
  completedAt: Date | null
  status: TaskStatus | null
  priority: TaskPriority | null
  dueDate: Date | null
  // Lists v2 typed values keyed by field-def id (`lfd_…`). Defaults to
  // `{}`; inert on a list with no field defs.
  customFields: Record<string, unknown>
  position: number
  // Non-null when this item is an occurrence materialized from a recurring
  // series (`lse_…`); null for one-off items.
  seriesId: string | null
  createdBy: string
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

export interface CreateListItemInput {
  id: string
  tenantId: string
  listId: string
  title: string
  notes?: string | null | undefined
  assignedTo?: string | null | undefined
  status?: TaskStatus | null | undefined
  priority?: TaskPriority | null | undefined
  dueDate?: Date | null | undefined
  // Pre-validated by the route (validateCustomFields); the repo writes it
  // verbatim. Omit to default to `{}`.
  customFields?: Record<string, unknown> | undefined
  // Omit to append at max(position)+1 within the list.
  position?: number | undefined
  createdBy: string
}

// Sparse patch. Only defined keys are written. `completed` toggling
// drives completedAt (set on true, cleared on false) in the repo; when
// `status` is supplied the repo also mirrors completed/completedAt off
// it. `listId` is a cross-list move (repo re-appends at the target's
// max+1); `createdBy` lets the route apply ownership-on-move transfer.
export interface UpdateListItemInput {
  title?: string | undefined
  notes?: string | null | undefined
  assignedTo?: string | null | undefined
  completed?: boolean | undefined
  status?: TaskStatus | null | undefined
  priority?: TaskPriority | null | undefined
  dueDate?: Date | null | undefined
  // Pre-merged + validated by the route (the full intended value map);
  // the repo overwrites the JSONB column verbatim when present.
  customFields?: Record<string, unknown> | undefined
  position?: number | undefined
  listId?: string | undefined
  createdBy?: string | undefined
}

export interface ListItemRepo {
  create(input: CreateListItemInput): Promise<ListItemRecord>
  // Returns the item regardless of deletedAt (callers gate on it).
  findById(id: string): Promise<ListItemRecord | null>
  // Items for a list. Default order is (position, createdAt, id);
  // `sort` prepends field-driven ordering before that stable tiebreak.
  // `filters` narrows the result (built-in columns + custom_fields).
  // Both are pre-validated against the list's defs (Lists v2 slice 4),
  // so the repo trusts the resolved kinds. Excludes soft-deleted rows
  // unless includeDeleted is set.
  // `limit` caps the number of rows returned/scanned (opt-in — used by the
  // items listing route to bound an unfiltered/`has_any` scan; callers that
  // need every row, e.g. bulk-update id resolution, leave it unset).
  listForList(
    listId: string,
    opts?: {
      includeDeleted?: boolean
      filters?: ValidatedFilter[]
      sort?: ValidatedSort[]
      limit?: number
    },
  ): Promise<ListItemRecord[]>
  update(id: string, fields: UpdateListItemInput): Promise<ListItemRecord | null>
  softDelete(id: string, when: Date): Promise<void>
  restore(id: string): Promise<void>
  // --- bulk (Lists v2 slice 6) -------------------------------------
  // Apply one patch to many items, scoped to `listId`, in a single
  // transaction. Ids not belonging to the list (or already soft-deleted)
  // are silently skipped — only live members of `listId` are touched.
  // Each item gets the SAME patch; `customFields` is the pre-merged +
  // pre-validated value map for that item (the route merges/validates
  // per item before calling, so the repo writes verbatim). When the patch
  // carries no per-item customFields, pass `patch` once and `perItem`
  // empty. Returns the ids actually updated, in input order.
  bulkUpdate(
    listId: string,
    items: { id: string; fields: UpdateListItemInput }[],
  ): Promise<string[]>
  // Soft-delete many items scoped to `listId` in a single transaction.
  // Ids outside the list (or already deleted) are skipped. Returns the
  // ids actually deleted.
  bulkSoftDelete(listId: string, itemIds: string[], when: Date): Promise<string[]>
}

// --- list field defs (Lists v2) ------------------------------------

// A user-defined custom field on a list. `key` is the stable per-list
// slug; `label` is the renameable display name; values key off `id`.
// fieldType is immutable. options carries select choices / the text
// multiline flag. defaultValue is reserved (slice 3 wires it).
export interface FieldDefRecord {
  id: string
  tenantId: string
  listId: string
  key: string
  label: string
  fieldType: FieldType
  options: FieldDefOptions
  required: boolean
  defaultValue: unknown
  position: number
  createdBy: string
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

export interface CreateFieldDefInput {
  id: string
  tenantId: string
  listId: string
  key: string
  label: string
  fieldType: FieldType
  options: FieldDefOptions
  required?: boolean | undefined
  defaultValue?: unknown
  // Omit to append at max(position)+1 within the list.
  position?: number | undefined
  createdBy: string
}

// Sparse patch. Only defined keys are written. fieldType is immutable so
// it is absent. options is pre-merged by the route (it owns the
// anti-orphan choice merge); the repo writes it verbatim when present.
export interface UpdateFieldDefInput {
  label?: string | undefined
  options?: FieldDefOptions | undefined
  required?: boolean | undefined
  position?: number | undefined
}

export interface FieldDefRepo {
  create(input: CreateFieldDefInput): Promise<FieldDefRecord>
  // Returns the def regardless of deletedAt (callers gate on it).
  findById(id: string): Promise<FieldDefRecord | null>
  // Defs for a list ordered by (position, createdAt). Excludes
  // soft-deleted rows unless includeDeleted is set.
  listForList(listId: string, opts?: { includeDeleted?: boolean }): Promise<FieldDefRecord[]>
  update(id: string, fields: UpdateFieldDefInput): Promise<FieldDefRecord | null>
  softDelete(id: string, when: Date): Promise<void>
}

// --- list views (Lists v2 slice 5) ---------------------------------

// A saved filter/sort/columns/mode configuration for a list. v2 views
// are per-list and SHARED (any reader sees them; only the list creator
// edits). `config` is the structurally-validated ViewConfig blob; stale
// specs inside it are tolerated and resolved at apply time.
export interface ListViewRecord {
  id: string
  tenantId: string
  listId: string
  name: string
  config: ViewConfig
  position: number
  createdBy: string
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

export interface CreateListViewInput {
  id: string
  tenantId: string
  listId: string
  name: string
  config: ViewConfig
  // Omit to append at max(position)+1 within the list.
  position?: number | undefined
  createdBy: string
}

// Sparse patch. Only defined keys are written.
export interface UpdateListViewInput {
  name?: string | undefined
  config?: ViewConfig | undefined
  position?: number | undefined
}

export interface ListViewRepo {
  create(input: CreateListViewInput): Promise<ListViewRecord>
  // Returns the view regardless of deletedAt (callers gate on it).
  findById(id: string): Promise<ListViewRecord | null>
  // Views for a list ordered by (position, createdAt). Excludes
  // soft-deleted rows unless includeDeleted is set.
  listForList(listId: string, opts?: { includeDeleted?: boolean }): Promise<ListViewRecord[]>
  update(id: string, fields: UpdateListViewInput): Promise<ListViewRecord | null>
  softDelete(id: string, when: Date): Promise<void>
}

// --- list groups ---------------------------------------------------

export interface GroupRecord {
  id: string
  tenantId: string
  name: string
  description: string | null
  createdBy: string
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

export interface GroupMemberRecord {
  id: string
  groupId: string
  userId: string
  role: GroupRole
  joinedAt: Date
}

export interface CreateGroupInput {
  id: string
  tenantId: string
  name: string
  description?: string | null | undefined
  createdBy: string
  // Membership row id for the creator (auto-enrolled as 'owner').
  ownerMemberId: string
}

export interface UpdateGroupInput {
  name?: string | undefined
  description?: string | null | undefined
}

export interface AddGroupMemberInput {
  id: string
  groupId: string
  userId: string
  role: GroupRole
}

export interface GroupRepo {
  // Inserts the group AND the creator's 'owner' membership atomically.
  // Conflict-tolerant (#277): if a LIVE group already exists with the
  // same (createdBy, name), returns the pre-existing winner group rather
  // than erroring. This lets concurrent first-writes (e.g. two simultaneous
  // planner resolvePersonalScope() calls for a new user) converge to the
  // same group id without leaking an orphaned stray.
  create(input: CreateGroupInput): Promise<GroupRecord>
  findById(id: string): Promise<GroupRecord | null>
  // Active (non-deleted) groups the user belongs to, newest first.
  listForUser(userId: string): Promise<GroupRecord[]>
  update(id: string, fields: UpdateGroupInput): Promise<GroupRecord | null>
  softDelete(id: string, when: Date): Promise<void>
  addMember(input: AddGroupMemberInput): Promise<GroupMemberRecord>
  listMembers(groupId: string): Promise<GroupMemberRecord[]>
  findMembership(groupId: string, userId: string): Promise<GroupMemberRecord | null>
}

// --- list shares + invites (#128) ----------------------------------

// list_shares — who has read access to a `visibility='private'` list
// beyond the creator. Distinct from list_group_members (scope-level
// membership): a share grants per-list visibility, not scope access.
export interface ListShareRecord {
  id: string
  listId: string
  userId: string
  addedByUserId: string
  createdAt: Date
}

export interface ListShareRepo {
  add(input: {
    id: string
    listId: string
    userId: string
    addedByUserId: string
  }): Promise<ListShareRecord>
  findByListAndUser(listId: string, userId: string): Promise<ListShareRecord | null>
  listForList(listId: string): Promise<ListShareRecord[]>
  // Lists every share row belonging to a user, newest first. Backs the
  // "Shared with me" surface — the caller joins these to list rows to
  // present the actual list names.
  listForUser(userId: string): Promise<ListShareRecord[]>
  remove(listId: string, userId: string): Promise<boolean>
}

// list_invites — pending share-by-email invites. Mirrors the events-
// api invites table shape. The raw code leaves once in the
// create-invite response and is never re-derivable (we store sha256).
export interface ListInviteRecord {
  id: string
  listId: string
  codeHash: string
  invitedByUserId: string
  invitedEmail: string
  createdAt: Date
  expiresAt: Date
  consumedAt: Date | null
  consumedByUserId: string | null
}

export interface ListInviteRepo {
  create(input: {
    id: string
    listId: string
    codeHash: string
    invitedByUserId: string
    invitedEmail: string
    expiresAt: Date
  }): Promise<ListInviteRecord>
  findByCodeHash(codeHash: string): Promise<ListInviteRecord | null>
  findById(id: string): Promise<ListInviteRecord | null>
  // Updates consumed_at + consumed_by_user_id atomically.
  markConsumed(id: string, consumedByUserId: string, when: Date): Promise<void>
  listForList(listId: string): Promise<ListInviteRecord[]>
  // Hard-deletes an invite. Returns true iff a row existed and was unconsumed.
  deletePending(id: string): Promise<boolean>
}

// --- sessions (lists-side session store, events-v1 design §3.13) ---

export interface ListsSessionRecord {
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

export interface ListsSessionRepo {
  create(record: Omit<ListsSessionRecord, 'createdAt' | 'lastSeenAt'> & {
    createdAt?: Date
    lastSeenAt?: Date
  }): Promise<void>
  findByIdHash(idHash: string): Promise<ListsSessionRecord | null>
  touchLastSeen(idHash: string, when: Date): Promise<void>
  deleteByIdHash(idHash: string): Promise<void>
}

// --- list item series (Planner slice 1b) --------------------------

// Mirrors the list_item_series table. All timestamps are JS Dates;
// dtstart/until/occurrenceDate are plain YYYY-MM-DD strings (date cols).
// timeOfDay is HH:MM or HH:MM:SS (time col), null when absent.
export interface ListItemSeriesRecord {
  id: string
  tenantId: string
  listId: string
  // Template fields stamped onto each generated occurrence.
  title: string
  notes: string | null
  assignedTo: string | null
  priority: string | null
  // Recurrence rule.
  freq: RecurrenceFreq
  interval: number
  byDay: DayCode[] | null
  dtstart: string
  until: string | null
  count: number | null
  timeOfDay: string | null
  createdBy: string
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

// Input to create a series. Actor is passed as the `actor` parameter
// (not a field here), matching how listItems routes pass createdBy.
export interface CreateListItemSeriesInput {
  title: string
  notes?: string | null | undefined
  assignedTo?: string | null | undefined
  priority?: string | null | undefined
  freq: RecurrenceFreq
  interval: number
  byDay?: DayCode[] | null | undefined
  dtstart: string
  until?: string | null | undefined
  count?: number | null | undefined
  timeOfDay?: string | null | undefined
}

// Sparse patch. Only defined keys are written. The repo re-projects
// occurrences from the merged rule after update.
export interface UpdateListItemSeriesInput {
  title?: string | undefined
  notes?: string | null | undefined
  assignedTo?: string | null | undefined
  priority?: string | null | undefined
  freq?: RecurrenceFreq | undefined
  interval?: number | undefined
  byDay?: DayCode[] | null | undefined
  dtstart?: string | undefined
  until?: string | null | undefined
  count?: number | null | undefined
  timeOfDay?: string | null | undefined
}

export interface ListItemSeriesRepo {
  // Create the series row + project occurrences into list_items.
  // Returns the series record (NOT the generated items). tenantId is
  // resolved by the route from the parent list so series + occurrences
  // inherit the list's tenant rather than the column default.
  create(
    listId: string,
    input: CreateListItemSeriesInput,
    actor: string,
    tenantId: string,
  ): Promise<ListItemSeriesRecord>
  // Look up a single series row (deleted or not) by id. Returns null when the
  // id does not exist. Used by routes that need the listId for access checks
  // before calling update() or softDelete().
  findById(id: string): Promise<ListItemSeriesRecord | null>
  // Active (non-deleted) series for a list.
  list(listId: string): Promise<ListItemSeriesRecord[]>
  // Sparse update; re-projects future non-exception occurrences.
  // Returns null when the series doesn't exist.
  update(id: string, patch: UpdateListItemSeriesInput, actor: string): Promise<ListItemSeriesRecord | null>
  // Soft-deletes the series row + future non-exception occurrences.
  // Past and exception occurrences are preserved.
  softDelete(id: string, actor: string): Promise<boolean>
}

// --- list planner prefs (per-user "show in planner" flag) ----------

// list_planner_prefs — one row per (user, list). show_in_planner
// controls whether the list surfaces in the Planner sidebar. Designed
// as a per-user overlay: user A flagging a shared list has no effect
// on user B's view.
export interface ListPlannerPrefRepo {
  // INSERT … ON CONFLICT DO UPDATE — idempotent, single round-trip.
  upsert(userId: string, listId: string, show: boolean): Promise<void>
  // Returns list_id values where show_in_planner = true for this user.
  flaggedListIdsForActor(userId: string): Promise<string[]>
}

// --- repo bag ------------------------------------------------------

export interface Repos {
  lists: ListRepo
  listItems: ListItemRepo
  fieldDefs: FieldDefRepo
  listViews: ListViewRepo
  groups: GroupRepo
  listShares: ListShareRepo
  listInvites: ListInviteRepo
  sessions: ListsSessionRepo
  series: ListItemSeriesRepo
  listPlannerPrefs: ListPlannerPrefRepo
  rateLimit: RateLimitRepo
}
