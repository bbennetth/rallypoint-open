import {
  materializeOccurrences,
  occurrenceDueDate,
  MAX_INSTANCES_PER_SERIES,
  statusMirrorsCompleted,
  type ValidatedFilter,
  type ValidatedSort,
} from '@rallypoint/lists-shared'
import { ulid } from 'ulid'
import { InMemoryRateLimitRepo } from '@rallypoint/rate-limit'
import { applyItemFilters, applyItemSort } from './item-query.js'
import type {
  AddGroupMemberInput,
  CreateFieldDefInput,
  CreateGroupInput,
  CreateListInput,
  CreateListItemInput,
  CreateListItemSeriesInput,
  FieldDefRecord,
  FieldDefRepo,
  GroupMemberRecord,
  GroupRecord,
  GroupRepo,
  ListInviteRecord,
  ListInviteRepo,
  ListItemRecord,
  ListItemRepo,
  ListItemSeriesRecord,
  ListItemSeriesRepo,
  ListPlannerPrefRepo,
  ListRecord,
  ListRepo,
  ListScope,
  ListShareRecord,
  ListShareRepo,
  ListsSessionRecord,
  ListsSessionRepo,
  ListViewRecord,
  ListViewRepo,
  Repos,
  CreateListViewInput,
  UpdateFieldDefInput,
  UpdateGroupInput,
  UpdateListItemInput,
  UpdateListItemSeriesInput,
  UpdateListViewInput,
} from './types.js'
import { UniqueConstraintError } from './errors.js'

// In-memory repo impls for unit tests and local stubbing. They mirror
// the Postgres impls' observable behaviour (soft-delete filtering,
// newest-first ordering) but hold everything in Maps. Integration
// tests use the pg impls against a real Postgres; these are for fast
// logic-level tests.

export class MemoryListRepo implements ListRepo {
  private byId = new Map<string, ListRecord>()
  // Back-refs set in buildMemoryRepos so acceptInvite can sequence
  // list_shares insert + list_invites consume the same way the PG
  // impl does inside a transaction (single-threaded JS atomicity).
  shares?: MemoryListShareRepo
  invites?: MemoryListInviteRepo

  async create(input: CreateListInput): Promise<ListRecord> {
    const now = new Date()
    const rec: ListRecord = {
      id: input.id,
      tenantId: input.tenantId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      listType: input.listType,
      name: input.name,
      visibility: input.visibility,
      color: input.color ?? null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      // The in-memory list repo can't see list_items (separate repo), so the
      // count stays 0 here; the pg repo computes the real value via subquery.
      incompleteCount: 0,
    }
    this.byId.set(rec.id, rec)
    return { ...rec }
  }

  async findById(id: string): Promise<ListRecord | null> {
    const r = this.byId.get(id)
    return r ? { ...r } : null
  }

  async findByIds(ids: string[]): Promise<(ListRecord | null)[]> {
    return ids.map((id) => {
      const r = this.byId.get(id)
      return r ? { ...r } : null
    })
  }

  async listForScope(scope: ListScope): Promise<ListRecord[]> {
    return [...this.byId.values()]
      .filter(
        (l) =>
          l.deletedAt === null &&
          l.tenantId === scope.tenantId &&
          l.scopeType === scope.scopeType &&
          l.scopeId === scope.scopeId,
      )
      .sort((a, b) => {
        const at = a.createdAt.toISOString()
        const bt = b.createdAt.toISOString()
        if (at !== bt) return at < bt ? 1 : -1
        return a.id < b.id ? 1 : -1
      })
      .map((l) => ({ ...l }))
  }

  async softDelete(id: string, when: Date): Promise<void> {
    const r = this.byId.get(id)
    if (r) {
      r.deletedAt = when
      r.updatedAt = new Date()
    }
  }

  async acceptInvite(input: {
    shareId: string
    inviteId: string
    listId: string
    userId: string
    addedByUserId: string
  }): Promise<
    | { ok: true }
    | { ok: false; reason: 'already_shared' | 'invite_already_consumed' }
  > {
    // #128 — consume-first, then insert share. Mirrors the PG impl's
    // single-use invariant: the first concurrent accept wins the
    // invite consume; the loser sees `invite_already_consumed`.
    const invite = await this.invites?.findById(input.inviteId)
    if (!invite || invite.consumedAt !== null) {
      return { ok: false, reason: 'invite_already_consumed' }
    }
    await this.invites?.markConsumed(input.inviteId, input.userId, new Date())
    if (await this.shares?.findByListAndUser(input.listId, input.userId)) {
      return { ok: false, reason: 'already_shared' }
    }
    await this.shares?.add({
      id: input.shareId,
      listId: input.listId,
      userId: input.userId,
      addedByUserId: input.addedByUserId,
    })
    return { ok: true }
  }
}

export class MemoryListShareRepo implements ListShareRepo {
  private rows: ListShareRecord[] = []

  async add(input: {
    id: string
    listId: string
    userId: string
    addedByUserId: string
  }): Promise<ListShareRecord> {
    if (this.rows.some((r) => r.listId === input.listId && r.userId === input.userId)) {
      throw new UniqueConstraintError('list_shares_list_user_idx')
    }
    const rec: ListShareRecord = { ...input, createdAt: new Date() }
    this.rows.push(rec)
    return { ...rec }
  }

  async findByListAndUser(listId: string, userId: string): Promise<ListShareRecord | null> {
    const r = this.rows.find((x) => x.listId === listId && x.userId === userId)
    return r ? { ...r } : null
  }

  async listForList(listId: string): Promise<ListShareRecord[]> {
    return this.rows
      .filter((r) => r.listId === listId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((r) => ({ ...r }))
  }

  async listForUser(userId: string): Promise<ListShareRecord[]> {
    return this.rows
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => ({ ...r }))
  }

  async remove(listId: string, userId: string): Promise<boolean> {
    const before = this.rows.length
    this.rows = this.rows.filter((r) => !(r.listId === listId && r.userId === userId))
    return this.rows.length < before
  }
}

export class MemoryListInviteRepo implements ListInviteRepo {
  private rows: ListInviteRecord[] = []

  async create(input: {
    id: string
    listId: string
    codeHash: string
    invitedByUserId: string
    invitedEmail: string
    expiresAt: Date
  }): Promise<ListInviteRecord> {
    if (this.rows.some((r) => r.codeHash === input.codeHash)) {
      throw new UniqueConstraintError('list_invites_code_hash_idx')
    }
    const rec: ListInviteRecord = {
      ...input,
      createdAt: new Date(),
      consumedAt: null,
      consumedByUserId: null,
    }
    this.rows.push(rec)
    return { ...rec }
  }

  async findByCodeHash(codeHash: string): Promise<ListInviteRecord | null> {
    const r = this.rows.find((x) => x.codeHash === codeHash)
    return r ? { ...r } : null
  }

  async findById(id: string): Promise<ListInviteRecord | null> {
    const r = this.rows.find((x) => x.id === id)
    return r ? { ...r } : null
  }

  async markConsumed(id: string, consumedByUserId: string, when: Date): Promise<void> {
    const r = this.rows.find((x) => x.id === id)
    if (r) {
      r.consumedAt = when
      r.consumedByUserId = consumedByUserId
    }
  }

  async listForList(listId: string): Promise<ListInviteRecord[]> {
    return this.rows
      .filter((r) => r.listId === listId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => ({ ...r }))
  }

  async deletePending(id: string): Promise<boolean> {
    const r = this.rows.find((x) => x.id === id)
    if (!r || r.consumedAt !== null) return false
    this.rows = this.rows.filter((x) => x.id !== id)
    return true
  }
}

export class MemoryListItemRepo implements ListItemRepo {
  private byId = new Map<string, ListItemRecord>()

  async create(input: CreateListItemInput): Promise<ListItemRecord> {
    const now = new Date()
    const position =
      input.position ??
      [...this.byId.values()]
        .filter((i) => i.listId === input.listId)
        .reduce((max, i) => Math.max(max, i.position), -1) + 1
    // Mirror status→completed at creation (parity with the pg repo): a
    // row born with status='done' must also read completed=true.
    const status = input.status ?? null
    const completedFromStatus = status !== null ? statusMirrorsCompleted(status).completed : false
    const rec: ListItemRecord = {
      id: input.id,
      tenantId: input.tenantId,
      listId: input.listId,
      title: input.title,
      notes: input.notes ?? null,
      assignedTo: input.assignedTo ?? null,
      completed: completedFromStatus,
      completedAt: completedFromStatus ? now : null,
      status,
      priority: input.priority ?? null,
      dueDate: input.dueDate ?? null,
      customFields: input.customFields ?? {},
      position,
      seriesId: null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    this.byId.set(rec.id, rec)
    return { ...rec }
  }

  async findById(id: string): Promise<ListItemRecord | null> {
    const r = this.byId.get(id)
    return r ? { ...r } : null
  }

  async listForList(
    listId: string,
    opts: {
      includeDeleted?: boolean
      filters?: ValidatedFilter[]
      sort?: ValidatedSort[]
      limit?: number
    } = {},
  ): Promise<ListItemRecord[]> {
    const base = [...this.byId.values()]
      .filter((i) => i.listId === listId && (opts.includeDeleted || i.deletedAt === null))
      .sort((a, b) => {
        if (a.position !== b.position) return a.position - b.position
        const at = a.createdAt.toISOString()
        const bt = b.createdAt.toISOString()
        if (at !== bt) return at < bt ? -1 : 1
        return a.id < b.id ? -1 : 1
      })
    // Field filters/sort layer on top of the stable default order; the
    // sort is stable so unsorted ties keep (position, createdAt, id).
    const filtered = applyItemFilters(base, opts.filters ?? [])
    const sorted = applyItemSort(filtered, opts.sort ?? [])
    const capped = opts.limit !== undefined ? sorted.slice(0, opts.limit) : sorted
    return capped.map((i) => ({ ...i }))
  }

  // Apply a sparse patch to an in-place record. Shared by update() and
  // bulkUpdate() so the mapping (status↔completed mirror, move re-append)
  // lives in one place.
  private applyPatch(r: ListItemRecord, fields: UpdateListItemInput): void {
    if (fields.title !== undefined) r.title = fields.title
    if (fields.notes !== undefined) r.notes = fields.notes
    if (fields.assignedTo !== undefined) r.assignedTo = fields.assignedTo
    if (fields.priority !== undefined) r.priority = fields.priority
    if (fields.dueDate !== undefined) r.dueDate = fields.dueDate
    if (fields.customFields !== undefined) r.customFields = fields.customFields
    if (fields.createdBy !== undefined) r.createdBy = fields.createdBy
    // completed applied BEFORE status so that when a patch carries both,
    // status — the task source of truth — wins.
    if (fields.completed !== undefined) {
      r.completed = fields.completed
      r.completedAt = fields.completed ? new Date() : null
    }
    // status drives completed/completedAt for task items.
    if (fields.status !== undefined) {
      r.status = fields.status
      if (fields.status !== null) {
        const { completed } = statusMirrorsCompleted(fields.status)
        r.completed = completed
        r.completedAt = completed ? new Date() : null
      }
    }
    // Cross-list move: re-home and re-append unless a position is pinned.
    if (fields.listId !== undefined) {
      r.listId = fields.listId
      if (fields.position === undefined) {
        r.position =
          [...this.byId.values()]
            .filter((i) => i.listId === fields.listId && i.id !== r.id)
            .reduce((max, i) => Math.max(max, i.position), -1) + 1
      }
    }
    if (fields.position !== undefined) r.position = fields.position
    r.updatedAt = new Date()
  }

  async update(id: string, fields: UpdateListItemInput): Promise<ListItemRecord | null> {
    const r = this.byId.get(id)
    if (!r) return null
    this.applyPatch(r, fields)
    return { ...r }
  }

  async softDelete(id: string, when: Date): Promise<void> {
    const r = this.byId.get(id)
    if (r) {
      r.deletedAt = when
      r.updatedAt = new Date()
    }
  }

  async restore(id: string): Promise<void> {
    const r = this.byId.get(id)
    if (r) {
      r.deletedAt = null
      r.updatedAt = new Date()
    }
  }

  async bulkUpdate(
    listId: string,
    items: { id: string; fields: UpdateListItemInput }[],
  ): Promise<string[]> {
    // Single-threaded JS gives us the pg transaction's atomicity for
    // free. Only live members of `listId` are touched; stray ids skip.
    const updated: string[] = []
    for (const { id, fields } of items) {
      const r = this.byId.get(id)
      if (!r || r.listId !== listId || r.deletedAt !== null) continue
      this.applyPatch(r, fields)
      updated.push(id)
    }
    return updated
  }

  async bulkSoftDelete(listId: string, itemIds: string[], when: Date): Promise<string[]> {
    const deleted: string[] = []
    for (const id of itemIds) {
      const r = this.byId.get(id)
      if (!r || r.listId !== listId || r.deletedAt !== null) continue
      r.deletedAt = when
      r.updatedAt = new Date()
      deleted.push(id)
    }
    return deleted
  }
}

export class MemoryFieldDefRepo implements FieldDefRepo {
  private byId = new Map<string, FieldDefRecord>()

  async create(input: CreateFieldDefInput): Promise<FieldDefRecord> {
    const now = new Date()
    const position =
      input.position ??
      [...this.byId.values()]
        .filter((d) => d.listId === input.listId)
        .reduce((max, d) => Math.max(max, d.position), -1) + 1
    const rec: FieldDefRecord = {
      id: input.id,
      tenantId: input.tenantId,
      listId: input.listId,
      key: input.key,
      label: input.label,
      fieldType: input.fieldType,
      options: input.options,
      required: input.required ?? false,
      defaultValue: input.defaultValue ?? null,
      position,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    this.byId.set(rec.id, rec)
    return { ...rec }
  }

  async findById(id: string): Promise<FieldDefRecord | null> {
    const r = this.byId.get(id)
    return r ? { ...r } : null
  }

  async listForList(
    listId: string,
    opts: { includeDeleted?: boolean } = {},
  ): Promise<FieldDefRecord[]> {
    return [...this.byId.values()]
      .filter((d) => d.listId === listId && (opts.includeDeleted || d.deletedAt === null))
      .sort((a, b) => {
        if (a.position !== b.position) return a.position - b.position
        const at = a.createdAt.toISOString()
        const bt = b.createdAt.toISOString()
        if (at !== bt) return at < bt ? -1 : 1
        return a.id < b.id ? -1 : 1
      })
      .map((d) => ({ ...d }))
  }

  async update(id: string, fields: UpdateFieldDefInput): Promise<FieldDefRecord | null> {
    const r = this.byId.get(id)
    if (!r) return null
    if (fields.label !== undefined) r.label = fields.label
    if (fields.options !== undefined) r.options = fields.options
    if (fields.required !== undefined) r.required = fields.required
    if (fields.position !== undefined) r.position = fields.position
    r.updatedAt = new Date()
    return { ...r }
  }

  async softDelete(id: string, when: Date): Promise<void> {
    const r = this.byId.get(id)
    if (r) {
      r.deletedAt = when
      r.updatedAt = new Date()
    }
  }
}

export class MemoryListViewRepo implements ListViewRepo {
  private byId = new Map<string, ListViewRecord>()

  async create(input: CreateListViewInput): Promise<ListViewRecord> {
    const now = new Date()
    const position =
      input.position ??
      [...this.byId.values()]
        .filter((v) => v.listId === input.listId)
        .reduce((max, v) => Math.max(max, v.position), -1) + 1
    const rec: ListViewRecord = {
      id: input.id,
      tenantId: input.tenantId,
      listId: input.listId,
      name: input.name,
      config: input.config,
      position,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    this.byId.set(rec.id, rec)
    return { ...rec }
  }

  async findById(id: string): Promise<ListViewRecord | null> {
    const r = this.byId.get(id)
    return r ? { ...r } : null
  }

  async listForList(
    listId: string,
    opts: { includeDeleted?: boolean } = {},
  ): Promise<ListViewRecord[]> {
    return [...this.byId.values()]
      .filter((v) => v.listId === listId && (opts.includeDeleted || v.deletedAt === null))
      .sort((a, b) => {
        if (a.position !== b.position) return a.position - b.position
        const at = a.createdAt.toISOString()
        const bt = b.createdAt.toISOString()
        if (at !== bt) return at < bt ? -1 : 1
        return a.id < b.id ? -1 : 1
      })
      .map((v) => ({ ...v }))
  }

  async update(id: string, fields: UpdateListViewInput): Promise<ListViewRecord | null> {
    const r = this.byId.get(id)
    if (!r) return null
    if (fields.name !== undefined) r.name = fields.name
    if (fields.config !== undefined) r.config = fields.config
    if (fields.position !== undefined) r.position = fields.position
    r.updatedAt = new Date()
    return { ...r }
  }

  async softDelete(id: string, when: Date): Promise<void> {
    const r = this.byId.get(id)
    if (r) {
      r.deletedAt = when
      r.updatedAt = new Date()
    }
  }
}

export class MemoryGroupRepo implements GroupRepo {
  private byId = new Map<string, GroupRecord>()
  private members = new Map<string, GroupMemberRecord>()

  async create(input: CreateGroupInput): Promise<GroupRecord> {
    // #277: mirror D1GroupRepo conflict-tolerant behaviour. If a LIVE group
    // with the same (createdBy, name) already exists, return the winner
    // (oldest by createdAt) instead of creating a duplicate. Single-threaded
    // JS means the "concurrent" race doesn't arise in the memory impl, but
    // the idempotent path is tested here so unit-level concurrency tests run
    // without a real D1 binding.
    const existing = [...this.byId.values()]
      .filter((g) => g.deletedAt === null && g.createdBy === input.createdBy && g.name === input.name)
      .sort((a, b) => {
        const at = a.createdAt.toISOString()
        const bt = b.createdAt.toISOString()
        if (at !== bt) return at < bt ? -1 : 1
        return a.id < b.id ? -1 : 1
      })[0]
    if (existing) return { ...existing }

    const now = new Date()
    const rec: GroupRecord = {
      id: input.id,
      tenantId: input.tenantId,
      name: input.name,
      description: input.description ?? null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    this.byId.set(rec.id, rec)
    this.members.set(input.ownerMemberId, {
      id: input.ownerMemberId,
      groupId: input.id,
      userId: input.createdBy,
      role: 'owner',
      joinedAt: now,
    })
    return { ...rec }
  }

  async findById(id: string): Promise<GroupRecord | null> {
    const r = this.byId.get(id)
    return r ? { ...r } : null
  }

  async listForUser(userId: string): Promise<GroupRecord[]> {
    const groupIds = new Set(
      [...this.members.values()].filter((m) => m.userId === userId).map((m) => m.groupId),
    )
    return [...this.byId.values()]
      .filter((g) => g.deletedAt === null && groupIds.has(g.id))
      .sort((a, b) => {
        const at = a.createdAt.toISOString()
        const bt = b.createdAt.toISOString()
        if (at !== bt) return at < bt ? 1 : -1
        return a.id < b.id ? 1 : -1
      })
      .map((g) => ({ ...g }))
  }

  async update(id: string, fields: UpdateGroupInput): Promise<GroupRecord | null> {
    const r = this.byId.get(id)
    if (!r) return null
    if (fields.name !== undefined) r.name = fields.name
    if (fields.description !== undefined) r.description = fields.description
    r.updatedAt = new Date()
    return { ...r }
  }

  async softDelete(id: string, when: Date): Promise<void> {
    const r = this.byId.get(id)
    if (r) {
      r.deletedAt = when
      r.updatedAt = new Date()
    }
  }

  async addMember(input: AddGroupMemberInput): Promise<GroupMemberRecord> {
    const rec: GroupMemberRecord = {
      id: input.id,
      groupId: input.groupId,
      userId: input.userId,
      role: input.role,
      joinedAt: new Date(),
    }
    this.members.set(rec.id, rec)
    return { ...rec }
  }

  async listMembers(groupId: string): Promise<GroupMemberRecord[]> {
    return [...this.members.values()]
      .filter((m) => m.groupId === groupId)
      .sort((a, b) => {
        const at = a.joinedAt.toISOString()
        const bt = b.joinedAt.toISOString()
        if (at !== bt) return at < bt ? -1 : 1
        return a.id < b.id ? -1 : 1
      })
      .map((m) => ({ ...m }))
  }

  async findMembership(groupId: string, userId: string): Promise<GroupMemberRecord | null> {
    const r = [...this.members.values()].find(
      (m) => m.groupId === groupId && m.userId === userId,
    )
    return r ? { ...r } : null
  }
}

export class MemoryListsSessionRepo implements ListsSessionRepo {
  private byIdHash = new Map<string, ListsSessionRecord>()

  async create(
    record: Omit<ListsSessionRecord, 'createdAt' | 'lastSeenAt'> & {
      createdAt?: Date
      lastSeenAt?: Date
    },
  ): Promise<void> {
    const now = new Date()
    this.byIdHash.set(record.idHash, {
      ...record,
      createdAt: record.createdAt ?? now,
      lastSeenAt: record.lastSeenAt ?? now,
    })
  }

  async findByIdHash(idHash: string): Promise<ListsSessionRecord | null> {
    const r = this.byIdHash.get(idHash)
    return r ? { ...r } : null
  }

  async touchLastSeen(idHash: string, when: Date): Promise<void> {
    const r = this.byIdHash.get(idHash)
    if (r) r.lastSeenAt = when
  }

  async deleteByIdHash(idHash: string): Promise<void> {
    this.byIdHash.delete(idHash)
  }
}

// Internal extension of ListItemRecord that carries the recurrence
// linkage fields the DB has but the interface omits.  Only the
// MemoryListItemSeriesRepo reads back these extra fields; nothing
// outside this file should rely on them.
interface ListItemRecordWithSeries extends ListItemRecord {
  seriesId: string | null
  occurrenceDate: string | null
  isException: boolean
}

export class MemoryListItemSeriesRepo implements ListItemSeriesRepo {
  private bySeries = new Map<string, ListItemSeriesRecord>()
  // Shared item store injected after construction so series projection
  // can insert into the same map the MemoryListItemRepo uses.
  items?: MemoryListItemRepo

  private seriesItems(): ListItemRecordWithSeries[] {
    if (!this.items) return []
    return [...(this.items as unknown as { byId: Map<string, ListItemRecord> })['byId'].values()] as unknown as ListItemRecordWithSeries[]
  }

  async create(
    listId: string,
    input: CreateListItemSeriesInput,
    actor: string,
    tenantId: string,
  ): Promise<ListItemSeriesRecord> {
    const now = new Date()
    const seriesId = `lse_${ulid()}`
    const todayISO = new Date().toISOString().slice(0, 10)

    const rec: ListItemSeriesRecord = {
      id: seriesId,
      tenantId,
      listId,
      title: input.title,
      notes: input.notes ?? null,
      assignedTo: input.assignedTo ?? null,
      priority: input.priority ?? null,
      freq: input.freq,
      interval: input.interval,
      byDay: input.byDay ?? null,
      dtstart: input.dtstart,
      until: input.until ?? null,
      count: input.count ?? null,
      timeOfDay: input.timeOfDay ?? null,
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    this.bySeries.set(seriesId, rec)

    const rule = {
      freq: input.freq,
      interval: input.interval,
      byDay: input.byDay ?? null,
      dtstart: input.dtstart,
      until: input.until ?? null,
      count: input.count ?? null,
    }
    const dates = materializeOccurrences(rule, {
      from: todayISO,
      limit: MAX_INSTANCES_PER_SERIES,
    })

    if (this.items) {
      const itemStore = (this.items as unknown as { byId: Map<string, ListItemRecord> })['byId']
      for (const dateStr of dates) {
        const existingInList = [...itemStore.values()].filter((i) => i.listId === listId)
        const position = existingInList.reduce((max, i) => Math.max(max, i.position), -1) + 1
        const dueDate = new Date(occurrenceDueDate(dateStr, input.timeOfDay ?? null))
        const taskPriority = (input.priority ?? null) as import('@rallypoint/lists-shared').TaskPriority | null
        const itemRec = {
          id: `lit_${ulid()}`,
          tenantId,
          listId,
          title: input.title,
          notes: input.notes ?? null,
          assignedTo: input.assignedTo ?? null,
          completed: false,
          completedAt: null,
          status: 'todo' as import('@rallypoint/lists-shared').TaskStatus,
          priority: taskPriority,
          dueDate,
          customFields: {} as Record<string, unknown>,
          position,
          createdBy: actor,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          seriesId,
          occurrenceDate: dateStr,
          isException: false,
        } satisfies ListItemRecordWithSeries
        itemStore.set(itemRec.id, itemRec as unknown as ListItemRecord)
      }
    }

    return { ...rec }
  }

  async list(listId: string): Promise<ListItemSeriesRecord[]> {
    return [...this.bySeries.values()]
      .filter((s) => s.listId === listId && s.deletedAt === null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((s) => ({ ...s }))
  }

  async findById(id: string): Promise<ListItemSeriesRecord | null> {
    const r = this.bySeries.get(id)
    return r ? { ...r } : null
  }

  async update(
    id: string,
    patch: UpdateListItemSeriesInput,
    _actor: string,
  ): Promise<ListItemSeriesRecord | null> {
    const r = this.bySeries.get(id)
    if (!r || r.deletedAt !== null) return null

    const todayISO = new Date().toISOString().slice(0, 10)

    if (patch.title !== undefined) r.title = patch.title
    if (patch.notes !== undefined) r.notes = patch.notes
    if (patch.assignedTo !== undefined) r.assignedTo = patch.assignedTo
    if (patch.priority !== undefined) r.priority = patch.priority
    if (patch.freq !== undefined) r.freq = patch.freq
    if (patch.interval !== undefined) r.interval = patch.interval
    if (patch.byDay !== undefined) r.byDay = patch.byDay
    if (patch.dtstart !== undefined) r.dtstart = patch.dtstart
    if (patch.until !== undefined) r.until = patch.until
    if (patch.count !== undefined) r.count = patch.count
    if (patch.timeOfDay !== undefined) r.timeOfDay = patch.timeOfDay
    r.updatedAt = new Date()

    // Dates we must NOT (re)create on re-projection — computed before the
    // soft-delete wipe so it doesn't pollute the EXDATE set (mirrors the PG
    // repo): live exception rows + soft-deleted non-exception EXDATEs.
    const excluded = new Set<string>()
    for (const item of this.seriesItems()) {
      if (item.seriesId !== id || item.occurrenceDate === null) continue
      if (item.occurrenceDate < todayISO) continue
      const liveException = item.isException && item.deletedAt === null
      const exdate = !item.isException && item.deletedAt !== null
      if (liveException || exdate) excluded.add(item.occurrenceDate)
    }

    // Soft-delete future non-exception occurrences.
    if (this.items) {
      const now = new Date()
      const itemStore = (this.items as unknown as { byId: Map<string, ListItemRecord> })['byId']
      for (const item of this.seriesItems()) {
        if (
          item.seriesId === id &&
          item.occurrenceDate !== null &&
          item.occurrenceDate >= todayISO &&
          !item.isException &&
          item.deletedAt === null
        ) {
          item.deletedAt = now
          item.updatedAt = now
          itemStore.set(item.id, item as unknown as ListItemRecord)
        }
      }
    }

    // Re-project.
    const rule = {
      freq: r.freq,
      interval: r.interval,
      byDay: r.byDay,
      dtstart: r.dtstart,
      until: r.until,
      count: r.count,
    }
    const dates = materializeOccurrences(rule, {
      from: todayISO,
      limit: MAX_INSTANCES_PER_SERIES,
    })

    if (this.items) {
      const now = new Date()
      const itemStore = (this.items as unknown as { byId: Map<string, ListItemRecord> })['byId']
      for (const dateStr of dates) {
        if (excluded.has(dateStr)) continue
        const existingInList = [...itemStore.values()].filter((i) => i.listId === r.listId)
        const position = existingInList.reduce((max, i) => Math.max(max, i.position), -1) + 1
        const dueDate = new Date(occurrenceDueDate(dateStr, r.timeOfDay))
        const taskPriority = (r.priority ?? null) as import('@rallypoint/lists-shared').TaskPriority | null
        const itemRec = {
          id: `lit_${ulid()}`,
          tenantId: r.tenantId,
          listId: r.listId,
          title: r.title,
          notes: r.notes,
          assignedTo: r.assignedTo,
          completed: false,
          completedAt: null,
          status: 'todo' as import('@rallypoint/lists-shared').TaskStatus,
          priority: taskPriority,
          dueDate,
          customFields: {} as Record<string, unknown>,
          position,
          createdBy: r.createdBy,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          seriesId: id,
          occurrenceDate: dateStr,
          isException: false,
        } satisfies ListItemRecordWithSeries
        itemStore.set(itemRec.id, itemRec as unknown as ListItemRecord)
      }
    }

    return { ...r }
  }

  async softDelete(id: string, _actor: string): Promise<boolean> {
    const r = this.bySeries.get(id)
    if (!r || r.deletedAt !== null) return false

    const todayISO = new Date().toISOString().slice(0, 10)
    const now = new Date()

    r.deletedAt = now
    r.updatedAt = now

    if (this.items) {
      const itemStore = (this.items as unknown as { byId: Map<string, ListItemRecord> })['byId']
      for (const item of this.seriesItems()) {
        if (
          item.seriesId === id &&
          item.occurrenceDate !== null &&
          item.occurrenceDate >= todayISO &&
          !item.isException &&
          item.deletedAt === null
        ) {
          item.deletedAt = now
          item.updatedAt = now
          itemStore.set(item.id, item as unknown as ListItemRecord)
        }
      }
    }

    return true
  }
}

export class MemoryListPlannerPrefRepo implements ListPlannerPrefRepo {
  // keyed `${userId}:${listId}` → show
  private prefs = new Map<string, boolean>()

  async upsert(userId: string, listId: string, show: boolean): Promise<void> {
    this.prefs.set(`${userId}:${listId}`, show)
  }

  async flaggedListIdsForActor(userId: string): Promise<string[]> {
    const prefix = `${userId}:`
    const result: string[] = []
    for (const [key, show] of this.prefs) {
      if (show && key.startsWith(prefix)) {
        result.push(key.slice(prefix.length))
      }
    }
    return result
  }
}

export function buildMemoryRepos(): Repos {
  // Hoist shares/invites construction so the lists repo's
  // acceptInvite back-refs are wired before the return.
  const lists = new MemoryListRepo()
  const listShares = new MemoryListShareRepo()
  const listInvites = new MemoryListInviteRepo()
  lists.shares = listShares
  lists.invites = listInvites
  const listItems = new MemoryListItemRepo()
  const series = new MemoryListItemSeriesRepo()
  series.items = listItems
  return {
    lists,
    listItems,
    fieldDefs: new MemoryFieldDefRepo(),
    listViews: new MemoryListViewRepo(),
    groups: new MemoryGroupRepo(),
    listShares,
    listInvites,
    sessions: new MemoryListsSessionRepo(),
    series,
    listPlannerPrefs: new MemoryListPlannerPrefRepo(),
    rateLimit: new InMemoryRateLimitRepo(),
  }
}
