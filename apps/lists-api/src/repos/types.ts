import type {
  DayCode,
  FieldDefOptions,
  FieldType,
  GroupRole,
  ListType,
  RecurrenceFreq,
  ScopeType,
  StatusCategory,
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
  // Custom-status linkage (`lst_…`); null for non-task items / unresolved
  // rows. Kept in lockstep with `status` (which holds the category slug).
  // RPL v1.0.0 slice 1.
  statusId: string | null
  // Sub-item parent (`lit_…`) in the same list; null for top-level items.
  // RPL v1.0.0 slice 4.
  parentId: string | null
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
  // Custom-status id (`lst_…`), resolved + dual-written with `status` by
  // the route. RPL v1.0.0 slice 1.
  statusId?: string | null | undefined
  // Sub-item parent (`lit_…`), validated by the route. RPL v1.0.0 slice 4.
  parentId?: string | null | undefined
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
  // Custom-status id (`lst_…`), resolved + dual-written with `status` by
  // the route. null clears the linkage. RPL v1.0.0 slice 1.
  statusId?: string | null | undefined
  // Sub-item parent (`lit_…`). null detaches to top-level. RPL v1.0.0 s4.
  parentId?: string | null | undefined
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
  // Detach every live child of `parentId` (set parent_id = null), scoped to
  // `listId`. Called when a parent is soft-deleted so children orphan to
  // top-level rather than dangle on a deleted parent. Returns the count.
  // RPL v1.0.0 slice 4.
  clearChildParent(listId: string, parentId: string): Promise<number>
  // Bulk variant: detach children of ANY of `parentIds` in one statement.
  // Used by the bulk soft-delete path so a bulk parent delete orphans its
  // children too. No-op on an empty list. Returns the count detached.
  bulkClearChildParent(listId: string, parentIds: string[]): Promise<number>
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

// --- list statuses (RPL v1.0.0 slice 1) ----------------------------

// A per-list, user-definable workflow state. `category` is the
// load-bearing classifier (completion, kanban grouping, GitHub
// auto-close key off it, never the renameable `name`). `color` is a
// free-form palette token owned by the UI.
export interface ListStatusRecord {
  id: string
  tenantId: string
  listId: string
  name: string
  color: string | null
  category: StatusCategory
  position: number
  createdBy: string
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

export interface CreateListStatusInput {
  id: string
  tenantId: string
  listId: string
  name: string
  color?: string | null | undefined
  category: StatusCategory
  // Omit to append at max(position)+1 within the list.
  position?: number | undefined
  createdBy: string
}

// Sparse patch. Only defined keys are written.
export interface UpdateListStatusInput {
  name?: string | undefined
  color?: string | null | undefined
  category?: StatusCategory | undefined
  position?: number | undefined
}

export interface ListStatusRepo {
  create(input: CreateListStatusInput): Promise<ListStatusRecord>
  // Returns the status regardless of deletedAt (callers gate on it).
  findById(id: string): Promise<ListStatusRecord | null>
  // Statuses for a list ordered by (position, createdAt). Excludes
  // soft-deleted rows unless includeDeleted is set.
  listForList(listId: string, opts?: { includeDeleted?: boolean }): Promise<ListStatusRecord[]>
  // Insert the default seed set for a list in one transaction and return
  // the created rows (ordered by position). Used by the lazy seed-on-
  // first-read path; the caller decides when the list has zero rows and
  // mints the ids (route owns id generation). `position` is the array
  // index.
  seedDefaults(
    listId: string,
    tenantId: string,
    createdBy: string,
    seeds: { id: string; name: string; color: string; category: StatusCategory }[],
  ): Promise<ListStatusRecord[]>
  update(id: string, fields: UpdateListStatusInput): Promise<ListStatusRecord | null>
  softDelete(id: string, when: Date): Promise<void>
  // Reassign every live item pointing at `fromStatusId` to `toStatusId`
  // (or clear to null) — used before deleting a status so no item is left
  // dangling. Scoped to the list. Returns the count reassigned.
  reassignItems(
    listId: string,
    fromStatusId: string,
    to: { statusId: string | null; status: StatusCategory | null; completed: boolean },
  ): Promise<number>
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
  // 'planner' for Planner-BFF-provisioned groups (read-only on the UI
  // surface); null for groups created in the Lists app.
  origin: string | null
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
  origin?: string | null | undefined
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

// --- mcp tokens (RPL v1.0.0 slice 11) ------------------------------

// A personal access token for the Lists MCP server. The raw value is
// never stored — only its sha256 (`idHash`). `id` is the non-secret
// handle for listing/revoking. A token is valid iff it is not revoked
// and not past `expiresAt`.
export interface McpTokenRecord {
  id: string
  tenantId: string
  idHash: string
  userId: string
  label: string
  createdAt: Date
  lastUsedAt: Date | null
  expiresAt: Date | null
  revokedAt: Date | null
}

export interface CreateMcpTokenInput {
  id: string
  tenantId: string
  idHash: string
  userId: string
  label: string
  expiresAt?: Date | null | undefined
}

export interface McpTokenRepo {
  create(input: CreateMcpTokenInput): Promise<McpTokenRecord>
  // Resolve a token by its hash. Returns the row regardless of
  // revoked/expired state (the caller decides); null if no such hash.
  findByHash(idHash: string): Promise<McpTokenRecord | null>
  // A user's tokens, newest first (includes revoked ones for the UI's
  // audit view).
  listForUser(userId: string): Promise<McpTokenRecord[]>
  // Stamp last_used_at on a successful resolve.
  touchLastUsed(id: string, when: Date): Promise<void>
  // Soft-revoke, scoped to the owner. Returns true iff a live token was
  // revoked (false when missing, not the owner's, or already revoked).
  revoke(id: string, userId: string, when: Date): Promise<boolean>
}

// --- list item comments (RPL v1.0.0 slice 7) ----------------------

// A comment on a list item. authorId holds a Rallypoint ID
// `user_<ulid>` (not a cross-schema FK). Soft-deleted comments are
// hidden from reads; the pruner hard-purges them alongside items.
export interface ListItemCommentRecord {
  id: string
  tenantId: string
  itemId: string
  authorId: string
  body: string
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

export interface CreateListItemCommentInput {
  id: string
  tenantId: string
  itemId: string
  authorId: string
  body: string
}

// Sparse patch. Only body is editable post-create.
export interface UpdateListItemCommentInput {
  body?: string | undefined
}

export interface ListItemCommentRepo {
  create(input: CreateListItemCommentInput): Promise<ListItemCommentRecord>
  // Returns the comment regardless of deletedAt (callers gate on it).
  findById(id: string): Promise<ListItemCommentRecord | null>
  // Live (non-deleted) comments for an item, oldest-first (thread order).
  // Pass includeDeleted to surface soft-deleted rows (internal use only).
  listForItem(itemId: string, opts?: { includeDeleted?: boolean }): Promise<ListItemCommentRecord[]>
  update(id: string, fields: UpdateListItemCommentInput): Promise<ListItemCommentRecord | null>
  softDelete(id: string, when: Date): Promise<void>
}

// --- list labels (RPL v1.0.0 slice 12) ----------------------------

// A per-list, user-definable colored label. `color` is a free-form
// palette token owned by the UI. Many-to-many with items via the
// `list_item_labels` join table (hard-delete on label soft-delete).
export interface ListLabelRecord {
  id: string
  tenantId: string
  listId: string
  name: string
  color: string | null
  position: number
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

export interface CreateLabelInput {
  id: string
  tenantId: string
  listId: string
  name: string
  color?: string | null | undefined
  // Omit to append at max(position)+1 within the list.
  position?: number | undefined
}

// Sparse patch. Only defined keys are written.
export interface UpdateLabelInput {
  name?: string | undefined
  color?: string | null | undefined
  position?: number | undefined
}

export interface ListLabelRepo {
  create(input: CreateLabelInput): Promise<ListLabelRecord>
  // Returns the label regardless of deletedAt (callers gate on it).
  findById(id: string): Promise<ListLabelRecord | null>
  // Labels for a list ordered by (position, createdAt). Excludes
  // soft-deleted rows unless includeDeleted is set.
  listForList(listId: string, opts?: { includeDeleted?: boolean }): Promise<ListLabelRecord[]>
  update(id: string, fields: UpdateLabelInput): Promise<ListLabelRecord | null>
  softDelete(id: string, when: Date): Promise<void>
  // --- join-table helpers ------------------------------------------
  // Replace the full label set for one item (delete-then-insert).
  setItemLabels(itemId: string, labelIds: string[]): Promise<void>
  // Batch lookup: map of itemId → label ids for those items. Used to
  // attach label_ids to item serializations in one query.
  labelsForItems(itemIds: string[]): Promise<Map<string, string[]>>
  // Hard-purge join rows for a label being soft-deleted so it stops
  // appearing on items immediately.
  removeLabelFromAllItems(labelId: string): Promise<void>
}

// --- repo bag ------------------------------------------------------

export interface Repos {
  lists: ListRepo
  listItems: ListItemRepo
  fieldDefs: FieldDefRepo
  listStatuses: ListStatusRepo
  listViews: ListViewRepo
  groups: GroupRepo
  listShares: ListShareRepo
  listInvites: ListInviteRepo
  sessions: ListsSessionRepo
  series: ListItemSeriesRepo
  mcpTokens: McpTokenRepo
  listItemComments: ListItemCommentRepo
  listLabels: ListLabelRepo
  rateLimit: RateLimitRepo
}
