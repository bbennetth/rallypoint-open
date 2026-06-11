import { InMemoryRateLimitRepo } from '@rallypoint/rate-limit'

import type {
  ActivityRecord,
  ArtistLinks,
  ArtistRecord,
  ArtistRepo,
  BulkApplySessionsInput,
  BulkApplySessionsResult,
  CreateGroupInput,
  CreateEventInput,
  CreateSessionInput,
  GroupInviteRecord,
  GroupInviteRepo,
  GroupMemberRecord,
  GroupMemberRepo,
  GroupRecord,
  GroupRepo,
  GroupRole,
  PatchGroupInput,
  DayRecord,
  EventActivityRepo,
  EventArtistRecord,
  EventArtistRepo,
  EventDayRepo,
  EventAttendeeRepo,
  EventInviteRepo,
  EventMemberRepo,
  EventTicketRepo,
  AttendeeRecord,
  CreateTicketInput,
  PatchTicketInput,
  PersonalTicketRecord,
  PersonalTicketRepo,
  CreatePersonalTicketInput,
  TicketRecord,
  EventRecord,
  EventRepo,
  EventMapRepo,
  EventNoGoZoneRepo,
  EventPoiRepo,
  EventSessionRepo,
  EventStageRepo,
  EventsSessionRecord,
  EventsSessionRepo,
  InviteRecord,
  MapRecord,
  PatchPoiInput,
  PatchZoneInput,
  PoiRecord,
  ZoneRecord,
  ZoneVertex,
  CreateRallyInput,
  PatchRallyInput,
  RallyRecord,
  RallyRepo,
  RallyRsvpStatus,
  RallyAttendeeRecord,
  RallyAttendeeRepo,
  ChatMessageRecord,
  ChatMessageRepo,
  CreateChatMessageInput,
  EventWeatherRecord,
  EventWeatherRepo,
  EventSetStarRepo,
  SetStarKey,
  EventPlannerPrefRepo,
  EventSnapshotRepo,
  CreateSnapshotInput,
  SnapshotKind,
  SnapshotRecord,
  SnapshotSummary,
  ListChatOptions,
  ListEventsOptions,
  ListEventsPage,
  ListSessionsOptions,
  MemberRecord,
  PatchEventInput,
  PatchSessionInput,
  EventPurgeLogRepo,
  PurgeLogRecord,
  Repos,
  ScopeType,
  SessionApprovalStatus,
  SessionRecord,
  StageRecord,
  UpsertEventWeatherInput,
} from './types.js'

import { UniqueConstraintError } from './errors.js'

// In-memory repo impls for unit tests and local stubbing. They
// mirror the Postgres impls' observable behaviour (soft-delete
// filtering, slug collision, cursor ordering, transfer atomicity)
// but hold everything in Maps. Integration tests run the d1 impls
// under @cloudflare/vitest-pool-workers (Miniflare D1); these are for
// fast logic-level tests.

export { UniqueConstraintError } from './errors.js'

function num(n: number | null | undefined): string | null {
  return n === null || n === undefined ? null : String(n)
}

// Cursor over (createdAt DESC, id DESC). Encodes the boundary row.
function encodeCursor(e: EventRecord): string {
  return Buffer.from(`${e.createdAt.toISOString()}|${e.id}`, 'utf8').toString('base64url')
}
function decodeCursor(c: string): { iso: string; id: string } | null {
  try {
    const [iso, id] = Buffer.from(c, 'base64url').toString('utf8').split('|')
    if (!iso || !id) return null
    return { iso, id }
  } catch {
    return null
  }
}
// True if a sorts strictly after b under (createdAt DESC, id DESC),
// i.e. a comes later in the list and belongs on a later page.
function afterBoundary(a: EventRecord, iso: string, id: string): boolean {
  const at = a.createdAt.toISOString()
  if (at !== iso) return at < iso
  return a.id < id
}

export class MemoryEventRepo implements EventRepo {
  private byId = new Map<string, EventRecord>()
  // Back-refs for #171 acceptInvite. Set in buildMemoryRepos so the
  // method can sequence event_members + event_attendees + event_invites
  // mutations the same way the PG impl does inside a transaction.
  attendees?: MemoryEventAttendeeRepo
  invites?: MemoryEventInviteRepo

  constructor(private readonly members?: MemoryEventMemberRepo) {}

  async create(input: CreateEventInput): Promise<EventRecord> {
    for (const e of this.byId.values()) {
      if (e.tenantId === input.tenantId && e.slug === input.slug) {
        throw new UniqueConstraintError('events_tenant_slug_idx')
      }
    }
    const now = new Date()
    const rec: EventRecord = {
      id: input.id,
      tenantId: input.tenantId,
      ownerUserId: input.ownerUserId,
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      timezone: input.timezone,
      locationLabel: input.locationLabel ?? null,
      locationLat: num(input.locationLat),
      locationLng: num(input.locationLng),
      privacyMode: input.privacyMode,
      publicPageConfig: null,
      scopeType: (input.scopeType ?? 'personal') as ScopeType,
      startAt: input.startAt ?? null,
      endAt: input.endAt ?? null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      // The in-memory event repo can't see personal_tickets (separate repo),
      // so the count stays 0 here; the pg repo computes it via subquery.
      ticketCount: 0,
      ticketPlatform: input.ticketPlatform ?? null,
      ticketAccountEmail: input.ticketAccountEmail ?? null,
    }
    this.byId.set(rec.id, rec)
    return { ...rec }
  }

  async findById(id: string): Promise<EventRecord | null> {
    const r = this.byId.get(id)
    return r ? { ...r } : null
  }

  async findBySlug(tenantId: string, slug: string): Promise<EventRecord | null> {
    for (const e of this.byId.values()) {
      if (e.tenantId === tenantId && e.slug === slug) return { ...e }
    }
    return null
  }

  async listForUser(userId: string, opts: ListEventsOptions): Promise<ListEventsPage> {
    const memberEventIds = new Set(
      (this.members?.allForUser(userId) ?? []).map((m) => m.eventId),
    )
    let rows = [...this.byId.values()].filter(
      (e) => e.ownerUserId === userId || memberEventIds.has(e.id),
    )
    if (!opts.includeDeleted) rows = rows.filter((e) => e.deletedAt === null)
    rows.sort((a, b) => {
      const at = a.createdAt.toISOString()
      const bt = b.createdAt.toISOString()
      if (at !== bt) return at < bt ? 1 : -1
      return a.id < b.id ? 1 : -1
    })
    if (opts.cursor) {
      const dec = decodeCursor(opts.cursor)
      if (dec) rows = rows.filter((e) => afterBoundary(e, dec.iso, dec.id))
    }
    const page = rows.slice(0, opts.limit)
    const nextCursor =
      rows.length > opts.limit && page.length > 0 ? encodeCursor(page[page.length - 1]!) : null
    return { items: page.map((e) => ({ ...e })), nextCursor }
  }

  async patch(id: string, fields: PatchEventInput): Promise<EventRecord | null> {
    const r = this.byId.get(id)
    if (!r) return null
    if (fields.slug !== undefined && fields.slug !== r.slug) {
      for (const e of this.byId.values()) {
        if (e.id !== id && e.tenantId === r.tenantId && e.slug === fields.slug) {
          throw new UniqueConstraintError('events_tenant_slug_idx')
        }
      }
    }
    if (fields.name !== undefined) r.name = fields.name
    if (fields.slug !== undefined) r.slug = fields.slug
    if (fields.description !== undefined) r.description = fields.description
    if (fields.startDate !== undefined) r.startDate = fields.startDate
    if (fields.endDate !== undefined) r.endDate = fields.endDate
    if (fields.startAt !== undefined) r.startAt = fields.startAt
    if (fields.endAt !== undefined) r.endAt = fields.endAt
    if (fields.timezone !== undefined) r.timezone = fields.timezone
    if (fields.locationLabel !== undefined) r.locationLabel = fields.locationLabel
    if (fields.locationLat !== undefined) r.locationLat = num(fields.locationLat)
    if (fields.locationLng !== undefined) r.locationLng = num(fields.locationLng)
    if (fields.privacyMode !== undefined) r.privacyMode = fields.privacyMode
    if (fields.publicPageConfig !== undefined) r.publicPageConfig = fields.publicPageConfig
    if (fields.ticketPlatform !== undefined) r.ticketPlatform = fields.ticketPlatform
    if (fields.ticketAccountEmail !== undefined) r.ticketAccountEmail = fields.ticketAccountEmail
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

  async restore(id: string): Promise<void> {
    const r = this.byId.get(id)
    if (r) {
      r.deletedAt = null
      r.updatedAt = new Date()
    }
  }

  async listSoftDeletedBefore(cutoff: Date): Promise<EventRecord[]> {
    return [...this.byId.values()]
      .filter((e) => e.deletedAt !== null && e.deletedAt.getTime() < cutoff.getTime())
      .sort((a, b) => a.deletedAt!.getTime() - b.deletedAt!.getTime())
      .map((e) => ({ ...e }))
  }

  async listForWeatherRefresh(input: {
    windowStart: Date
    windowEnd: Date
    limit: number
  }): Promise<EventRecord[]> {
    const windowStartMs = input.windowStart.getTime()
    const windowEndMs = input.windowEnd.getTime()
    const rows = [...this.byId.values()].filter((e) => {
      if (e.deletedAt !== null) return false
      if (e.locationLat === null || e.locationLng === null) return false
      const startMs = e.startDate ? new Date(e.startDate).getTime() : null
      const endMs = e.endDate ? new Date(e.endDate).getTime() : startMs
      if (startMs !== null && !Number.isNaN(startMs) && startMs > windowEndMs) return false
      if (endMs !== null && !Number.isNaN(endMs) && endMs < windowStartMs) return false
      return true
    })
    rows.sort((a, b) => {
      const ad = a.startDate ?? ''
      const bd = b.startDate ?? ''
      if (ad !== bd) return ad < bd ? -1 : 1
      return a.id < b.id ? -1 : 1
    })
    return rows.slice(0, input.limit).map((e) => ({ ...e }))
  }

  async hardDelete(id: string): Promise<boolean> {
    // Memory repos don't model FK cascade; the pg impl relies on
    // ON DELETE CASCADE and that path is covered by the testcontainers
    // pruner test. Here we only drop the event row.
    return this.byId.delete(id)
  }

  async listPersonalForUser(
    ownerUserId: string,
    opts: { from?: Date | null | undefined; to?: Date | null | undefined },
  ): Promise<EventRecord[]> {
    let rows = [...this.byId.values()].filter(
      (e) =>
        e.tenantId === 'rallypoint' &&
        e.scopeType === 'personal' &&
        e.ownerUserId === ownerUserId &&
        e.deletedAt === null,
    )
    if (opts.from) {
      const fromMs = opts.from.getTime()
      rows = rows.filter((e) => e.startAt !== null && e.startAt.getTime() >= fromMs)
    }
    if (opts.to) {
      const toMs = opts.to.getTime()
      rows = rows.filter((e) => e.startAt !== null && e.startAt.getTime() < toMs)
    }
    rows.sort((a, b) => {
      // nulls last
      if (a.startAt === null && b.startAt === null) return a.id < b.id ? -1 : 1
      if (a.startAt === null) return 1
      if (b.startAt === null) return -1
      const diff = a.startAt.getTime() - b.startAt.getTime()
      if (diff !== 0) return diff
      return a.id < b.id ? -1 : 1
    })
    return rows.map((e) => ({ ...e }))
  }

  async listGroupForUser(userId: string): Promise<EventRecord[]> {
    const relatedIds = new Set([
      ...(this.members?.allForUser(userId) ?? []).map((m) => m.eventId),
      ...(this.attendees?.currentEventIdsForUser(userId) ?? []),
    ])
    const rows = [...this.byId.values()].filter(
      (e) =>
        e.tenantId === 'rallypoint' &&
        e.scopeType === 'group' &&
        e.deletedAt === null &&
        (e.ownerUserId === userId || relatedIds.has(e.id)),
    )
    rows.sort((a, b) => {
      // start_date ASC NULLS LAST, then id ASC
      if (a.startDate === null && b.startDate === null) return a.id < b.id ? -1 : 1
      if (a.startDate === null) return 1
      if (b.startDate === null) return -1
      if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1
      return a.id < b.id ? -1 : 1
    })
    return rows.map((e) => ({ ...e }))
  }

  async transferOwnership(input: {
    eventId: string
    newOwnerUserId: string
    oldOwnerUserId: string
    oldOwnerMemberId: string
  }): Promise<void> {
    const r = this.byId.get(input.eventId)
    if (!r) return
    r.ownerUserId = input.newOwnerUserId
    r.updatedAt = new Date()
    this.members?.removeByEventAndUser(input.eventId, input.newOwnerUserId)
    await this.members?.add({
      id: input.oldOwnerMemberId,
      eventId: input.eventId,
      userId: input.oldOwnerUserId,
      role: 'editor',
    })
  }

  async acceptInvite(input: {
    memberId: string
    attendeeId: string
    eventId: string
    userId: string
    role: MemberRecord['role']
    inviteId: string
    skipMemberAdd: boolean
  }): Promise<
    { ok: true; readmitted: boolean } | { ok: false; reason: 'already_active_member' }
  > {
    // #171: mirror PG semantics. `members.add` throws
    // UniqueConstraintError on duplicate which the PG layer maps to
    // `already_active_member`; do the same here.
    if (!input.skipMemberAdd) {
      try {
        await this.members?.add({
          id: input.memberId,
          eventId: input.eventId,
          userId: input.userId,
          role: input.role,
        })
      } catch (err) {
        if (err instanceof UniqueConstraintError) {
          return { ok: false, reason: 'already_active_member' }
        }
        throw err
      }
    }
    await this.attendees?.upsert({
      id: input.attendeeId,
      eventId: input.eventId,
      userId: input.userId,
    })
    await this.invites?.markConsumed(input.inviteId, input.userId, new Date())
    return { ok: true, readmitted: input.skipMemberAdd }
  }
}

export class MemoryEventMemberRepo implements EventMemberRepo {
  private rows: MemberRecord[] = []

  async add(input: {
    id: string
    eventId: string
    userId: string
    role: MemberRecord['role']
  }): Promise<MemberRecord> {
    if (this.rows.some((m) => m.eventId === input.eventId && m.userId === input.userId)) {
      throw new UniqueConstraintError('event_members_event_user_idx')
    }
    const rec: MemberRecord = { ...input, joinedAt: new Date() }
    this.rows.push(rec)
    return { ...rec }
  }

  async findByEventAndUser(eventId: string, userId: string): Promise<MemberRecord | null> {
    const m = this.rows.find((r) => r.eventId === eventId && r.userId === userId)
    return m ? { ...m } : null
  }

  async updateRole(eventId: string, userId: string, role: MemberRecord['role']): Promise<void> {
    const m = this.rows.find((r) => r.eventId === eventId && r.userId === userId)
    if (m) m.role = role
  }

  async listForEvent(eventId: string): Promise<MemberRecord[]> {
    return this.rows.filter((r) => r.eventId === eventId).map((r) => ({ ...r }))
  }

  // Helpers used by MemoryEventRepo (not part of the interface).
  allForUser(userId: string): MemberRecord[] {
    return this.rows.filter((r) => r.userId === userId)
  }
  removeByEventAndUser(eventId: string, userId: string): void {
    this.rows = this.rows.filter((r) => !(r.eventId === eventId && r.userId === userId))
  }
}

export class MemoryEventInviteRepo implements EventInviteRepo {
  private rows: InviteRecord[] = []

  async create(input: {
    id: string
    eventId: string
    codeHash: string
    invitedByUserId: string
    invitedEmail: string | null
    role: 'editor' | 'viewer'
    expiresAt: Date
  }): Promise<InviteRecord> {
    if (this.rows.some((r) => r.codeHash === input.codeHash)) {
      throw new UniqueConstraintError('event_invites_code_hash_idx')
    }
    const rec: InviteRecord = {
      ...input,
      createdAt: new Date(),
      consumedAt: null,
      consumedByUserId: null,
    }
    this.rows.push(rec)
    return { ...rec }
  }

  async findByCodeHash(codeHash: string): Promise<InviteRecord | null> {
    const r = this.rows.find((x) => x.codeHash === codeHash)
    return r ? { ...r } : null
  }

  async markConsumed(id: string, consumedByUserId: string, when: Date): Promise<void> {
    const r = this.rows.find((x) => x.id === id)
    if (r) {
      r.consumedAt = when
      r.consumedByUserId = consumedByUserId
    }
  }

  async listForEvent(eventId: string): Promise<InviteRecord[]> {
    return this.rows.filter((r) => r.eventId === eventId).map((r) => ({ ...r }))
  }

  async findById(id: string): Promise<InviteRecord | null> {
    const r = this.rows.find((x) => x.id === id)
    return r ? { ...r } : null
  }

  async deletePending(id: string): Promise<boolean> {
    const idx = this.rows.findIndex((x) => x.id === id && x.consumedAt === null)
    if (idx < 0) return false
    this.rows.splice(idx, 1)
    return true
  }
}

export class MemoryEventTicketRepo implements EventTicketRepo {
  private rows: TicketRecord[] = []

  async create(input: CreateTicketInput): Promise<TicketRecord> {
    if (
      this.rows.some(
        (t) =>
          t.eventId === input.eventId && t.name === input.name && t.deletedAt === null,
      )
    ) {
      throw new UniqueConstraintError('event_tickets_event_name_idx')
    }
    const now = new Date()
    const rec: TicketRecord = {
      id: input.id,
      eventId: input.eventId,
      name: input.name,
      description: input.description ?? null,
      priceCents: input.priceCents,
      quantity: input.quantity ?? null,
      soldCount: 0,
      sortOrder: input.sortOrder ?? 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    this.rows.push(rec)
    return { ...rec }
  }

  async findById(id: string): Promise<TicketRecord | null> {
    const r = this.rows.find((t) => t.id === id)
    return r ? { ...r } : null
  }

  async listForEvent(eventId: string): Promise<TicketRecord[]> {
    return this.rows
      .filter((t) => t.eventId === eventId)
      .sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
        return a.createdAt.getTime() - b.createdAt.getTime()
      })
      .map((t) => ({ ...t }))
  }

  async patch(id: string, fields: PatchTicketInput): Promise<TicketRecord | null> {
    const t = this.rows.find((r) => r.id === id)
    if (!t) return null
    if (fields.name !== undefined) t.name = fields.name
    if (fields.description !== undefined) t.description = fields.description
    if (fields.priceCents !== undefined) t.priceCents = fields.priceCents
    if (fields.quantity !== undefined) t.quantity = fields.quantity
    if (fields.sortOrder !== undefined) t.sortOrder = fields.sortOrder
    t.updatedAt = new Date()
    return { ...t }
  }

  async softDelete(id: string, when: Date): Promise<'ok' | 'sold' | 'not_found'> {
    const t = this.rows.find((r) => r.id === id && r.deletedAt === null)
    if (!t) return 'not_found'
    if (t.soldCount > 0) return 'sold'
    t.deletedAt = when
    t.updatedAt = new Date()
    return 'ok'
  }

  async restore(id: string): Promise<TicketRecord | null> {
    const t = this.rows.find((r) => r.id === id)
    if (!t) return null
    t.deletedAt = null
    t.updatedAt = new Date()
    return { ...t }
  }
}

export class MemoryEventAttendeeRepo implements EventAttendeeRepo {
  private rows: AttendeeRecord[] = []

  async upsert(input: {
    id: string
    eventId: string
    userId: string
  }): Promise<AttendeeRecord> {
    const existing = this.rows.find(
      (r) => r.eventId === input.eventId && r.userId === input.userId,
    )
    if (existing) {
      if (existing.removedAt !== null) {
        existing.removedAt = null
        existing.joinedAt = new Date()
      }
      return { ...existing }
    }
    const rec: AttendeeRecord = {
      id: input.id,
      eventId: input.eventId,
      userId: input.userId,
      joinedAt: new Date(),
      removedAt: null,
    }
    this.rows.push(rec)
    return { ...rec }
  }

  async findByEventAndUser(
    eventId: string,
    userId: string,
  ): Promise<AttendeeRecord | null> {
    const r = this.rows.find((x) => x.eventId === eventId && x.userId === userId)
    return r ? { ...r } : null
  }

  async softRemove(eventId: string, userId: string, when: Date): Promise<void> {
    const r = this.rows.find(
      (x) => x.eventId === eventId && x.userId === userId && x.removedAt === null,
    )
    if (r) r.removedAt = when
  }

  async listForEvent(
    eventId: string,
    opts: { limit: number; cursor: Date | null },
  ): Promise<{ items: AttendeeRecord[]; nextCursor: Date | null }> {
    const filtered = this.rows
      .filter((r) => r.eventId === eventId && r.removedAt === null)
      .filter((r) => (opts.cursor ? r.joinedAt > opts.cursor : true))
      .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())
    const items = filtered.slice(0, opts.limit).map((r) => ({ ...r }))
    const nextCursor =
      filtered.length > opts.limit ? items[opts.limit - 1]!.joinedAt : null
    return { items, nextCursor }
  }

  // Helper used by MemoryEventRepo.listGroupForUser (not part of the
  // interface): the events the user currently attends (removed_at null).
  currentEventIdsForUser(userId: string): string[] {
    return this.rows
      .filter((r) => r.userId === userId && r.removedAt === null)
      .map((r) => r.eventId)
  }
}

export class MemoryEventActivityRepo implements EventActivityRepo {
  rows: ActivityRecord[] = []

  async record(input: {
    id: string
    eventId: string
    actorUserId: string
    eventType: string
    meta?: Record<string, unknown>
  }): Promise<void> {
    this.rows.push({
      id: input.id,
      eventId: input.eventId,
      actorUserId: input.actorUserId,
      eventType: input.eventType,
      meta: input.meta ?? {},
      createdAt: new Date(),
    })
  }

  async listForEvent(eventId: string): Promise<ActivityRecord[]> {
    return this.rows.filter((r) => r.eventId === eventId).map((r) => ({ ...r }))
  }
}

export class MemoryEventPurgeLogRepo implements EventPurgeLogRepo {
  rows: PurgeLogRecord[] = []

  async record(input: {
    id: string
    eventId: string
    ownerUserId: string
    tenantId: string
    deletedAt: Date
    daysAfterGrace: number
    objectsReaped: number
    objectsFailed: number
    meta?: Record<string, unknown>
  }): Promise<void> {
    this.rows.push({
      id: input.id,
      eventId: input.eventId,
      ownerUserId: input.ownerUserId,
      tenantId: input.tenantId,
      deletedAt: input.deletedAt,
      purgedAt: new Date(),
      daysAfterGrace: input.daysAfterGrace,
      objectsReaped: input.objectsReaped,
      objectsFailed: input.objectsFailed,
      meta: input.meta ?? {},
    })
  }

  async listForEvent(eventId: string): Promise<PurgeLogRecord[]> {
    return this.rows.filter((r) => r.eventId === eventId).map((r) => ({ ...r }))
  }
}

export class MemoryEventStageRepo implements EventStageRepo {
  private rows: StageRecord[] = []

  async create(input: {
    id: string
    eventId: string
    name: string
    sortOrder?: number
  }): Promise<StageRecord> {
    if (this.rows.some((s) => s.eventId === input.eventId && s.name === input.name)) {
      throw new UniqueConstraintError('event_stages_event_name_idx')
    }
    const rec: StageRecord = {
      id: input.id,
      eventId: input.eventId,
      name: input.name,
      sortOrder: input.sortOrder ?? 0,
    }
    this.rows.push(rec)
    return { ...rec }
  }

  async findById(id: string): Promise<StageRecord | null> {
    const s = this.rows.find((r) => r.id === id)
    return s ? { ...s } : null
  }

  async listForEvent(eventId: string): Promise<StageRecord[]> {
    return this.rows
      .filter((r) => r.eventId === eventId)
      .sort((a, b) => a.sortOrder - b.sortOrder || (a.name < b.name ? -1 : 1))
      .map((r) => ({ ...r }))
  }

  async update(
    id: string,
    fields: { name?: string; sortOrder?: number },
  ): Promise<StageRecord | null> {
    const s = this.rows.find((r) => r.id === id)
    if (!s) return null
    if (fields.name !== undefined && fields.name !== s.name) {
      if (this.rows.some((r) => r.id !== id && r.eventId === s.eventId && r.name === fields.name)) {
        throw new UniqueConstraintError('event_stages_event_name_idx')
      }
      s.name = fields.name
    }
    if (fields.sortOrder !== undefined) s.sortOrder = fields.sortOrder
    return { ...s }
  }

  async delete(id: string): Promise<boolean> {
    const before = this.rows.length
    this.rows = this.rows.filter((r) => r.id !== id)
    return this.rows.length < before
  }
}

export class MemoryEventDayRepo implements EventDayRepo {
  private rows: DayRecord[] = []

  async create(input: {
    id: string
    eventId: string
    dayLabel: string
    date: string
    startTime?: string | null
    endTime?: string | null
    sortOrder?: number
  }): Promise<DayRecord> {
    if (
      this.rows.some(
        (d) =>
          d.eventId === input.eventId &&
          (d.dayLabel === input.dayLabel || d.date === input.date),
      )
    ) {
      throw new UniqueConstraintError('event_days_unique')
    }
    const rec: DayRecord = {
      id: input.id,
      eventId: input.eventId,
      dayLabel: input.dayLabel,
      date: input.date,
      startTime: input.startTime ?? null,
      endTime: input.endTime ?? null,
      sortOrder: input.sortOrder ?? 0,
    }
    this.rows.push(rec)
    return { ...rec }
  }

  async createMany(
    rows: { id: string; eventId: string; dayLabel: string; date: string; sortOrder?: number }[],
  ): Promise<DayRecord[]> {
    // All-or-nothing (mirrors the PG transaction): snapshot, and on any
    // collision roll back so no partial rows survive.
    const snapshot = this.rows.slice()
    try {
      const out: DayRecord[] = []
      for (const input of rows) out.push(await this.create(input))
      return out
    } catch (err) {
      this.rows = snapshot
      throw err
    }
  }

  async findById(id: string): Promise<DayRecord | null> {
    const d = this.rows.find((r) => r.id === id)
    return d ? { ...d } : null
  }

  async listForEvent(eventId: string): Promise<DayRecord[]> {
    return this.rows
      .filter((r) => r.eventId === eventId)
      .sort((a, b) => a.sortOrder - b.sortOrder || (a.date < b.date ? -1 : 1))
      .map((r) => ({ ...r }))
  }

  async listForEventsIn(eventIds: string[]): Promise<DayRecord[]> {
    const ids = new Set(eventIds)
    return this.rows
      .filter((r) => ids.has(r.eventId))
      .sort((a, b) => a.sortOrder - b.sortOrder || (a.date < b.date ? -1 : 1))
      .map((r) => ({ ...r }))
  }

  async update(
    id: string,
    fields: {
      dayLabel?: string
      date?: string
      startTime?: string | null
      endTime?: string | null
      sortOrder?: number
    },
  ): Promise<DayRecord | null> {
    const d = this.rows.find((r) => r.id === id)
    if (!d) return null
    const nextLabel = fields.dayLabel ?? d.dayLabel
    const nextDate = fields.date ?? d.date
    if (
      this.rows.some(
        (r) =>
          r.id !== id &&
          r.eventId === d.eventId &&
          (r.dayLabel === nextLabel || r.date === nextDate),
      )
    ) {
      throw new UniqueConstraintError('event_days_unique')
    }
    if (fields.dayLabel !== undefined) d.dayLabel = fields.dayLabel
    if (fields.date !== undefined) d.date = fields.date
    if (fields.startTime !== undefined) d.startTime = fields.startTime
    if (fields.endTime !== undefined) d.endTime = fields.endTime
    if (fields.sortOrder !== undefined) d.sortOrder = fields.sortOrder
    return { ...d }
  }

  async delete(id: string): Promise<boolean> {
    const before = this.rows.length
    this.rows = this.rows.filter((r) => r.id !== id)
    return this.rows.length < before
  }
}

export class MemoryArtistRepo implements ArtistRepo {
  private rows: ArtistRecord[] = []

  async create(input: { id: string; name: string } & ArtistLinks): Promise<ArtistRecord> {
    if (this.rows.some((a) => a.name.toLowerCase() === input.name.toLowerCase())) {
      throw new UniqueConstraintError('artists_lower_name_idx')
    }
    const rec: ArtistRecord = {
      id: input.id,
      name: input.name,
      soundcloud: input.soundcloud ?? null,
      spotify: input.spotify ?? null,
      appleMusic: input.appleMusic ?? null,
      youtubeMusic: input.youtubeMusic ?? null,
      instagram: input.instagram ?? null,
      updatedAt: new Date(),
    }
    this.rows.push(rec)
    return { ...rec }
  }

  async findById(id: string): Promise<ArtistRecord | null> {
    const a = this.rows.find((r) => r.id === id)
    return a ? { ...a } : null
  }

  async findByName(name: string): Promise<ArtistRecord | null> {
    const a = this.rows.find((r) => r.name.toLowerCase() === name.toLowerCase())
    return a ? { ...a } : null
  }

  async search(query: string, limit: number): Promise<ArtistRecord[]> {
    const q = query.toLowerCase()
    return this.rows
      .filter((r) => r.name.toLowerCase().includes(q))
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .slice(0, limit)
      .map((r) => ({ ...r }))
  }

  async update(
    id: string,
    fields: { name?: string } & ArtistLinks,
  ): Promise<ArtistRecord | null> {
    const a = this.rows.find((r) => r.id === id)
    if (!a) return null
    if (fields.name !== undefined && fields.name.toLowerCase() !== a.name.toLowerCase()) {
      if (this.rows.some((r) => r.id !== id && r.name.toLowerCase() === fields.name!.toLowerCase())) {
        throw new UniqueConstraintError('artists_lower_name_idx')
      }
    }
    if (fields.name !== undefined) a.name = fields.name
    if (fields.soundcloud !== undefined) a.soundcloud = fields.soundcloud
    if (fields.spotify !== undefined) a.spotify = fields.spotify
    if (fields.appleMusic !== undefined) a.appleMusic = fields.appleMusic
    if (fields.youtubeMusic !== undefined) a.youtubeMusic = fields.youtubeMusic
    if (fields.instagram !== undefined) a.instagram = fields.instagram
    a.updatedAt = new Date()
    return { ...a }
  }
}

export class MemoryEventArtistRepo implements EventArtistRepo {
  private rows: EventArtistRecord[] = []
  // Back-reference set in buildMemoryRepos so delete can mirror the DB's
  // event_set_stars → event_artists onDelete('cascade') FK (#201).
  eventSetStars: MemoryEventSetStarRepo | null = null

  private indexOf(eventId: string, artistId: string, dayId: string): number {
    return this.rows.findIndex(
      (r) => r.eventId === eventId && r.artistId === artistId && r.dayId === dayId,
    )
  }

  async upsert(input: EventArtistRecord): Promise<EventArtistRecord> {
    const i = this.indexOf(input.eventId, input.artistId, input.dayId)
    if (i >= 0) this.rows[i] = { ...input }
    else this.rows.push({ ...input })
    return { ...input }
  }

  async bulkUpsert(rows: EventArtistRecord[]): Promise<EventArtistRecord[]> {
    const out: EventArtistRecord[] = []
    for (const r of rows) out.push(await this.upsert(r))
    return out
  }

  async bulkApply(
    eventId: string,
    input: {
      upserts: EventArtistRecord[]
      deletes: { artistId: string; dayId: string }[]
    },
  ): Promise<{ upserted: EventArtistRecord[]; deleted: number }> {
    const snapshot = this.rows.slice()
    try {
      const upserted: EventArtistRecord[] = []
      for (const r of input.upserts) upserted.push(await this.upsert(r))
      let deleted = 0
      for (const d of input.deletes) {
        if (await this.delete(eventId, d.artistId, d.dayId)) deleted++
      }
      return { upserted, deleted }
    } catch (err) {
      this.rows = snapshot
      throw err
    }
  }

  async find(
    eventId: string,
    artistId: string,
    dayId: string,
  ): Promise<EventArtistRecord | null> {
    const i = this.indexOf(eventId, artistId, dayId)
    return i >= 0 ? { ...this.rows[i]! } : null
  }

  async listForEvent(eventId: string): Promise<EventArtistRecord[]> {
    return this.rows
      .filter((r) => r.eventId === eventId)
      .sort(
        (a, b) =>
          (a.dayId < b.dayId ? -1 : a.dayId > b.dayId ? 1 : 0) ||
          (a.startTime ?? '').localeCompare(b.startTime ?? ''),
      )
      .map((r) => ({ ...r }))
  }

  async delete(eventId: string, artistId: string, dayId: string): Promise<boolean> {
    const i = this.indexOf(eventId, artistId, dayId)
    if (i < 0) return false
    this.rows.splice(i, 1)
    // Cascade: mirror the DB's event_set_stars → event_artists onDelete('cascade') (#201).
    this.eventSetStars?.deleteForSlot(eventId, artistId, dayId)
    return true
  }

  async replaceAll(eventId: string, rows: EventArtistRecord[]): Promise<EventArtistRecord[]> {
    const snapshot = this.rows.slice()
    try {
      const keep = new Set(rows.map((r) => `${r.artistId} ${r.dayId}`))
      for (const r of rows) await this.upsert(r)
      const current = this.rows.filter((r) => r.eventId === eventId)
      for (const c of current) {
        if (keep.has(`${c.artistId} ${c.dayId}`)) continue
        await this.delete(eventId, c.artistId, c.dayId)
      }
      return this.listForEvent(eventId)
    } catch (err) {
      this.rows = snapshot
      throw err
    }
  }
}

export class MemoryEventSessionRepo implements EventSessionRepo {
  private byId = new Map<string, SessionRecord>()

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const now = new Date()
    const rec: SessionRecord = {
      id: input.id,
      eventId: input.eventId,
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      dayId: input.dayId ?? null,
      startTime: input.startTime ?? null,
      endTime: input.endTime ?? null,
      category: input.category ?? null,
      host: input.host ?? null,
      approvalStatus: input.approvalStatus,
      visibility: input.visibility,
      groupId: input.groupId ?? null,
      sharedWith: input.sharedWith ?? null,
      createdByUserId: input.createdByUserId,
      submittedByUserId: input.submittedByUserId ?? null,
      approvedByUserId: input.approvedByUserId ?? null,
      approvedAt: input.approvedAt ?? null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    this.byId.set(rec.id, rec)
    return { ...rec }
  }

  async findById(id: string): Promise<SessionRecord | null> {
    const r = this.byId.get(id)
    return r ? { ...r } : null
  }

  async listForEvent(eventId: string, opts?: ListSessionsOptions): Promise<SessionRecord[]> {
    let rows = [...this.byId.values()].filter((r) => r.eventId === eventId)
    if (!opts?.includeDeleted) rows = rows.filter((r) => r.deletedAt === null)
    if (opts?.approvalStatus) rows = rows.filter((r) => r.approvalStatus === opts.approvalStatus)
    if (opts?.dayId) rows = rows.filter((r) => r.dayId === opts.dayId)
    return rows
      .sort((a, b) => {
        const at = a.createdAt.toISOString()
        const bt = b.createdAt.toISOString()
        if (at !== bt) return at < bt ? 1 : -1
        return a.id < b.id ? 1 : -1
      })
      .map((r) => ({ ...r }))
  }

  async patch(id: string, fields: PatchSessionInput): Promise<SessionRecord | null> {
    const r = this.byId.get(id)
    if (!r) return null
    if (fields.title !== undefined) r.title = fields.title
    if (fields.description !== undefined) r.description = fields.description
    if (fields.location !== undefined) r.location = fields.location
    if (fields.dayId !== undefined) r.dayId = fields.dayId
    if (fields.startTime !== undefined) r.startTime = fields.startTime
    if (fields.endTime !== undefined) r.endTime = fields.endTime
    if (fields.category !== undefined) r.category = fields.category
    if (fields.host !== undefined) r.host = fields.host
    if (fields.visibility !== undefined) r.visibility = fields.visibility
    if (fields.groupId !== undefined) r.groupId = fields.groupId
    if (fields.sharedWith !== undefined) r.sharedWith = fields.sharedWith
    r.updatedAt = new Date()
    return { ...r }
  }

  async setApproval(
    id: string,
    input: {
      status: SessionApprovalStatus
      approvedByUserId: string | null
      approvedAt: Date | null
      submittedByUserId?: string | null
    },
  ): Promise<SessionRecord | null> {
    const r = this.byId.get(id)
    if (!r) return null
    r.approvalStatus = input.status
    r.approvedByUserId = input.approvedByUserId
    r.approvedAt = input.approvedAt
    if (input.submittedByUserId !== undefined) r.submittedByUserId = input.submittedByUserId
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

  async bulkApply(input: BulkApplySessionsInput): Promise<BulkApplySessionsResult> {
    // Snapshot for rollback on any error.
    const snapshot = new Map(
      [...this.byId.entries()].map(([k, v]) => [k, { ...v }]),
    )
    try {
      const created: SessionRecord[] = []
      const updated: SessionRecord[] = []
      const now = new Date()

      for (const c of input.creates) {
        const rec: SessionRecord = {
          id: c.id,
          eventId: c.eventId,
          title: c.title,
          description: c.description ?? null,
          location: c.location ?? null,
          dayId: c.dayId ?? null,
          startTime: c.startTime ?? null,
          endTime: c.endTime ?? null,
          category: c.category ?? null,
          host: c.host ?? null,
          approvalStatus: c.approvalStatus,
          visibility: c.visibility,
          groupId: c.groupId ?? null,
          sharedWith: c.sharedWith ?? null,
          createdByUserId: c.createdByUserId,
          submittedByUserId: c.submittedByUserId ?? null,
          approvedByUserId: c.approvedByUserId ?? null,
          approvedAt: c.approvedAt ?? null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        }
        this.byId.set(rec.id, rec)
        created.push({ ...rec })
      }

      for (const u of input.updates) {
        const r = this.byId.get(u.id)
        // Scope to this event + non-deleted (parity with the PG where-clause).
        if (!r || r.eventId !== input.eventId || r.deletedAt !== null) continue
        const fields = u.patch
        if (fields.title !== undefined) r.title = fields.title
        if (fields.description !== undefined) r.description = fields.description
        if (fields.location !== undefined) r.location = fields.location
        if (fields.dayId !== undefined) r.dayId = fields.dayId
        if (fields.startTime !== undefined) r.startTime = fields.startTime
        if (fields.endTime !== undefined) r.endTime = fields.endTime
        if (fields.category !== undefined) r.category = fields.category
        if (fields.host !== undefined) r.host = fields.host
        if (fields.visibility !== undefined) r.visibility = fields.visibility
        if (fields.groupId !== undefined) r.groupId = fields.groupId
        if (fields.sharedWith !== undefined) r.sharedWith = fields.sharedWith
        r.updatedAt = now
        updated.push({ ...r })
      }

      for (const id of input.deletes) {
        const r = this.byId.get(id)
        // Scope to this event + non-deleted (parity with the PG where-clause).
        if (r && r.eventId === input.eventId && r.deletedAt === null) {
          r.deletedAt = now
          r.updatedAt = now
        }
      }

      return { created, updated }
    } catch (err) {
      // Restore snapshot on any error (memory rollback parity).
      this.byId = snapshot
      throw err
    }
  }

  async restoreActive(
    eventId: string,
    rows: SessionRecord[],
    when: Date,
  ): Promise<SessionRecord[]> {
    const snapshot = new Map([...this.byId.entries()].map(([k, v]) => [k, { ...v }]))
    try {
      const keep = new Set(rows.map((r) => r.id))
      for (const r of rows) {
        this.byId.set(r.id, { ...r, updatedAt: when, deletedAt: null })
      }
      for (const r of this.byId.values()) {
        if (r.eventId !== eventId || r.deletedAt !== null) continue
        if (keep.has(r.id)) continue
        r.deletedAt = when
        r.updatedAt = when
      }
      return this.listForEvent(eventId)
    } catch (err) {
      this.byId = snapshot
      throw err
    }
  }
}

export class MemoryEventsSessionRepo implements EventsSessionRepo {
  private byIdHash = new Map<string, EventsSessionRecord>()

  async create(
    record: Omit<EventsSessionRecord, 'createdAt' | 'lastSeenAt'> & {
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

  async findByIdHash(idHash: string): Promise<EventsSessionRecord | null> {
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

  async deleteExpiredBefore(cutoff: Date): Promise<number> {
    let n = 0
    for (const [k, v] of this.byIdHash) {
      if (v.absoluteExpiresAt.getTime() <= cutoff.getTime()) {
        this.byIdHash.delete(k)
        n++
      }
    }
    return n
  }
}

export class MemoryEventMapRepo implements EventMapRepo {
  private rows: MapRecord[] = []

  async create(input: {
    id: string
    eventId: string
    layer: string
    objectKey: string
    contentType: string
    bytes: number
    widthPx: number
    heightPx: number
    uploadedByUserId: string
  }): Promise<MapRecord> {
    if (this.rows.some((m) => m.eventId === input.eventId && m.layer === input.layer)) {
      throw new UniqueConstraintError('event_maps_event_layer_idx')
    }
    const rec: MapRecord = { ...input, uploadedAt: new Date() }
    this.rows.push(rec)
    return { ...rec }
  }

  async findById(id: string): Promise<MapRecord | null> {
    const m = this.rows.find((r) => r.id === id)
    return m ? { ...m } : null
  }

  async listForEvent(eventId: string): Promise<MapRecord[]> {
    return this.rows
      .filter((r) => r.eventId === eventId)
      .sort((a, b) => (a.layer < b.layer ? -1 : a.layer > b.layer ? 1 : 0))
      .map((r) => ({ ...r }))
  }

  async delete(id: string): Promise<boolean> {
    const before = this.rows.length
    this.rows = this.rows.filter((r) => r.id !== id)
    // Mirror the FK: a POI's map_id is SET NULL, a zone cascades.
    if (this.rows.length < before) {
      for (const p of this.pois?.all() ?? []) if (p.mapId === id) p.mapId = null
      this.zones?.removeByMap(id)
    }
    return this.rows.length < before
  }

  // Wired by buildMemoryRepos so a map delete can mirror the DB's
  // ON DELETE SET NULL (pois) / CASCADE (zones) behaviour.
  pois?: MemoryEventPoiRepo
  zones?: MemoryEventNoGoZoneRepo
}

export class MemoryEventPoiRepo implements EventPoiRepo {
  private rows: PoiRecord[] = []

  async create(input: {
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
    sortOrder?: number
  }): Promise<PoiRecord> {
    const now = new Date()
    const rec: PoiRecord = {
      id: input.id,
      eventId: input.eventId,
      mapId: input.mapId ?? null,
      categoryId: input.categoryId,
      name: input.name,
      description: input.description ?? null,
      xPct: String(input.xPct),
      yPct: String(input.yPct),
      lat: num(input.lat),
      lng: num(input.lng),
      sortOrder: input.sortOrder ?? 0,
      createdAt: now,
      updatedAt: now,
    }
    this.rows.push(rec)
    return { ...rec }
  }

  async findById(id: string): Promise<PoiRecord | null> {
    const p = this.rows.find((r) => r.id === id)
    return p ? { ...p } : null
  }

  async listForEvent(eventId: string): Promise<PoiRecord[]> {
    return this.rows
      .filter((r) => r.eventId === eventId)
      .sort(
        (a, b) =>
          a.sortOrder - b.sortOrder ||
          (a.createdAt.getTime() - b.createdAt.getTime()),
      )
      .map((r) => ({ ...r }))
  }

  async update(id: string, fields: PatchPoiInput): Promise<PoiRecord | null> {
    const p = this.rows.find((r) => r.id === id)
    if (!p) return null
    if (fields.mapId !== undefined) p.mapId = fields.mapId
    if (fields.categoryId !== undefined) p.categoryId = fields.categoryId
    if (fields.name !== undefined) p.name = fields.name
    if (fields.description !== undefined) p.description = fields.description
    if (fields.xPct !== undefined) p.xPct = String(fields.xPct)
    if (fields.yPct !== undefined) p.yPct = String(fields.yPct)
    if (fields.lat !== undefined) p.lat = num(fields.lat)
    if (fields.lng !== undefined) p.lng = num(fields.lng)
    if (fields.sortOrder !== undefined) p.sortOrder = fields.sortOrder
    p.updatedAt = new Date()
    return { ...p }
  }

  async delete(id: string): Promise<boolean> {
    const before = this.rows.length
    this.rows = this.rows.filter((r) => r.id !== id)
    return this.rows.length < before
  }

  // Helper for MemoryEventMapRepo's SET-NULL mirror (not in the interface).
  all(): PoiRecord[] {
    return this.rows
  }
}

export class MemoryEventNoGoZoneRepo implements EventNoGoZoneRepo {
  private rows: ZoneRecord[] = []

  async create(input: {
    id: string
    eventId: string
    mapId: string
    polygon: ZoneVertex[]
  }): Promise<ZoneRecord> {
    const rec: ZoneRecord = {
      id: input.id,
      eventId: input.eventId,
      mapId: input.mapId,
      polygon: input.polygon.map((v) => ({ ...v })),
    }
    this.rows.push(rec)
    return { ...rec, polygon: rec.polygon.map((v) => ({ ...v })) }
  }

  async findById(id: string): Promise<ZoneRecord | null> {
    const z = this.rows.find((r) => r.id === id)
    return z ? { ...z, polygon: z.polygon.map((v) => ({ ...v })) } : null
  }

  async listForEvent(eventId: string): Promise<ZoneRecord[]> {
    return this.rows
      .filter((r) => r.eventId === eventId)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((r) => ({ ...r, polygon: r.polygon.map((v) => ({ ...v })) }))
  }

  async update(id: string, fields: PatchZoneInput): Promise<ZoneRecord | null> {
    const z = this.rows.find((r) => r.id === id)
    if (!z) return null
    if (fields.mapId !== undefined) z.mapId = fields.mapId
    if (fields.polygon !== undefined) z.polygon = fields.polygon.map((v) => ({ ...v }))
    return { ...z, polygon: z.polygon.map((v) => ({ ...v })) }
  }

  async delete(id: string): Promise<boolean> {
    const before = this.rows.length
    this.rows = this.rows.filter((r) => r.id !== id)
    return this.rows.length < before
  }

  // Helper for MemoryEventMapRepo's CASCADE mirror (not in the interface).
  removeByMap(mapId: string): void {
    this.rows = this.rows.filter((r) => r.mapId !== mapId)
  }
}

export class MemoryGroupRepo implements GroupRepo {
  private byId = new Map<string, GroupRecord>()
  // Back-reference set in buildMemoryRepos so group delete can mirror the
  // rallies.group_id ON DELETE CASCADE (which in turn cascades attendees).
  rallies?: MemoryRallyRepo
  // Likewise for chat_messages.group_id ON DELETE CASCADE.
  chat?: MemoryChatMessageRepo
  // Back-reference for #171: createWithOwner + joinWithAttendee need to
  // write event_attendees inside the same logical "transaction" (which
  // in memory is just a sequence of synchronous mutations).
  attendees?: MemoryEventAttendeeRepo

  constructor(
    private readonly members?: MemoryGroupMemberRepo,
    private readonly invites?: MemoryGroupInviteRepo,
  ) {}

  async create(input: CreateGroupInput): Promise<GroupRecord> {
    for (const c of this.byId.values()) {
      if (c.eventId === input.eventId && c.name === input.name) {
        throw new UniqueConstraintError('groups_event_name_idx')
      }
      if (c.joinCodeHash === input.joinCodeHash) {
        throw new UniqueConstraintError('groups_join_code_hash_idx')
      }
    }
    const now = new Date()
    const rec: GroupRecord = {
      id: input.id,
      eventId: input.eventId,
      name: input.name,
      description: input.description ?? null,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      joinCodeHash: input.joinCodeHash,
      ownerUserId: input.ownerUserId,
      createdAt: now,
      updatedAt: now,
    }
    this.byId.set(rec.id, rec)
    return { ...rec }
  }

  async findById(id: string): Promise<GroupRecord | null> {
    const c = this.byId.get(id)
    return c ? { ...c } : null
  }

  async findByJoinCodeHash(joinCodeHash: string): Promise<GroupRecord | null> {
    for (const c of this.byId.values()) {
      if (c.joinCodeHash === joinCodeHash) return { ...c }
    }
    return null
  }

  async listForEvent(eventId: string): Promise<GroupRecord[]> {
    return [...this.byId.values()]
      .filter((c) => c.eventId === eventId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
      .map((c) => ({ ...c }))
  }

  async patch(id: string, fields: PatchGroupInput): Promise<GroupRecord | null> {
    const c = this.byId.get(id)
    if (!c) return null
    if (fields.name !== undefined && fields.name !== c.name) {
      for (const other of this.byId.values()) {
        if (other.id !== id && other.eventId === c.eventId && other.name === fields.name) {
          throw new UniqueConstraintError('groups_event_name_idx')
        }
      }
      c.name = fields.name
    }
    if (fields.description !== undefined) c.description = fields.description
    if (fields.startDate !== undefined) c.startDate = fields.startDate
    if (fields.endDate !== undefined) c.endDate = fields.endDate
    c.updatedAt = new Date()
    return { ...c }
  }

  async delete(id: string): Promise<boolean> {
    const existed = this.byId.delete(id)
    // Mirror the FK cascades: group_members + group_invites + rallies (which
    // themselves cascade rally_attendees) + chat_messages disappear.
    if (existed) {
      this.members?.removeByGroup(id)
      this.invites?.removeByGroup(id)
      if (this.rallies) {
        for (const rallyId of this.rallies.groupRallyIds(id)) await this.rallies.delete(rallyId)
      }
      this.chat?.removeByGroup(id)
    }
    return existed
  }

  async transferOwnership(input: {
    groupId: string
    newOwnerUserId: string
    oldOwnerUserId: string
  }): Promise<void> {
    const c = this.byId.get(input.groupId)
    if (!c) return
    c.ownerUserId = input.newOwnerUserId
    c.updatedAt = new Date()
    await this.members?.updateRole(input.groupId, input.newOwnerUserId, 'owner')
    await this.members?.updateRole(input.groupId, input.oldOwnerUserId, 'sidekick')
  }

  async createWithOwner(input: {
    group: CreateGroupInput
    ownerMemberId: string
    attendeeId: string | null
  }): Promise<GroupRecord> {
    // #171: in-memory atomicity comes from single-threaded JS. The
    // create call will throw before any subsequent mutations on the
    // duplicate-name path (matches the PG impl's 23505-only rollback).
    const group = await this.create(input.group)
    await this.members?.add({
      id: input.ownerMemberId,
      groupId: group.id,
      userId: input.group.ownerUserId,
      role: 'owner',
    })
    if (input.attendeeId !== null) {
      await this.attendees?.upsert({
        id: input.attendeeId,
        eventId: input.group.eventId,
        userId: input.group.ownerUserId,
      })
    }
    return group
  }

  async joinWithAttendee(input: {
    memberId: string
    groupId: string
    userId: string
    inviteId: string | null
    attendeeId: string | null
    eventId: string
  }): Promise<
    { ok: true; readmitted: boolean } | { ok: false; reason: 'duplicate_active' }
  > {
    // #171: mirror PG semantics — duplicate member + soft-removed
    // attendee → re-admission, else duplicate_active. Cap dropped (#313):
    // groups are uncapped; just insert + (optional) invite consume +
    // (optional) attendee upsert.
    const existing = await this.members?.findByGroupAndUser(input.groupId, input.userId)
    let readmitted = false
    if (existing) {
      if (input.attendeeId === null) {
        return { ok: false, reason: 'duplicate_active' }
      }
      const attendee = await this.attendees?.findByEventAndUser(input.eventId, input.userId)
      if (!attendee || attendee.removedAt === null) {
        return { ok: false, reason: 'duplicate_active' }
      }
      readmitted = true
    } else {
      await this.members?.add({
        id: input.memberId,
        groupId: input.groupId,
        userId: input.userId,
        role: 'member',
      })
    }
    if (input.inviteId !== null) {
      await this.invites?.markConsumed(input.inviteId, input.userId, new Date())
    }
    if (input.attendeeId !== null) {
      await this.attendees?.upsert({
        id: input.attendeeId,
        eventId: input.eventId,
        userId: input.userId,
      })
    }
    return { ok: true, readmitted }
  }
}

export class MemoryGroupMemberRepo implements GroupMemberRepo {
  private rows: GroupMemberRecord[] = []

  async add(input: {
    id: string
    groupId: string
    userId: string
    role: GroupRole
  }): Promise<GroupMemberRecord> {
    if (this.rows.some((m) => m.groupId === input.groupId && m.userId === input.userId)) {
      throw new UniqueConstraintError('group_members_group_user_idx')
    }
    const rec: GroupMemberRecord = { ...input, joinedAt: new Date() }
    this.rows.push(rec)
    return { ...rec }
  }

  async findByGroupAndUser(groupId: string, userId: string): Promise<GroupMemberRecord | null> {
    const m = this.rows.find((r) => r.groupId === groupId && r.userId === userId)
    return m ? { ...m } : null
  }

  async listForGroup(groupId: string): Promise<GroupMemberRecord[]> {
    return this.rows
      .filter((r) => r.groupId === groupId)
      .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())
      .map((r) => ({ ...r }))
  }

  async countForGroup(groupId: string): Promise<number> {
    return this.rows.filter((r) => r.groupId === groupId).length
  }

  async updateRole(groupId: string, userId: string, role: GroupRole): Promise<void> {
    const m = this.rows.find((r) => r.groupId === groupId && r.userId === userId)
    if (m) m.role = role
  }

  async remove(groupId: string, userId: string): Promise<boolean> {
    const before = this.rows.length
    this.rows = this.rows.filter((r) => !(r.groupId === groupId && r.userId === userId))
    return this.rows.length < before
  }

  // Helper for MemoryGroupRepo's CASCADE mirror (not in the interface).
  removeByGroup(groupId: string): void {
    this.rows = this.rows.filter((r) => r.groupId !== groupId)
  }
}

export class MemoryGroupInviteRepo implements GroupInviteRepo {
  private rows: GroupInviteRecord[] = []

  async create(input: {
    id: string
    groupId: string
    codeHash: string
    invitedByUserId: string
    invitedEmail: string | null
    expiresAt: Date
  }): Promise<GroupInviteRecord> {
    if (this.rows.some((r) => r.codeHash === input.codeHash)) {
      throw new UniqueConstraintError('group_invites_code_hash_idx')
    }
    const rec: GroupInviteRecord = {
      ...input,
      createdAt: new Date(),
      consumedAt: null,
      consumedByUserId: null,
    }
    this.rows.push(rec)
    return { ...rec }
  }

  async findByCodeHash(codeHash: string): Promise<GroupInviteRecord | null> {
    const r = this.rows.find((x) => x.codeHash === codeHash)
    return r ? { ...r } : null
  }

  async markConsumed(id: string, consumedByUserId: string, when: Date): Promise<void> {
    const r = this.rows.find((x) => x.id === id)
    if (r) {
      r.consumedAt = when
      r.consumedByUserId = consumedByUserId
    }
  }

  async listForGroup(groupId: string): Promise<GroupInviteRecord[]> {
    return this.rows
      .filter((r) => r.groupId === groupId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => ({ ...r }))
  }

  // Helper for MemoryGroupRepo's CASCADE mirror (not in the interface).
  removeByGroup(groupId: string): void {
    this.rows = this.rows.filter((r) => r.groupId !== groupId)
  }
}

export class MemoryRallyRepo implements RallyRepo {
  private byId = new Map<string, RallyRecord>()

  constructor(private readonly attendees?: MemoryRallyAttendeeRepo) {}

  async create(input: CreateRallyInput): Promise<RallyRecord> {
    const now = new Date()
    const rec: RallyRecord = {
      id: input.id,
      groupId: input.groupId,
      eventId: input.eventId,
      title: input.title,
      description: input.description ?? null,
      dayId: input.dayId ?? null,
      startTime: input.startTime ?? null,
      poiId: input.poiId ?? null,
      locationLabel: input.locationLabel ?? null,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      status: input.status ?? 'proposed',
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    }
    this.byId.set(rec.id, rec)
    return { ...rec }
  }

  async findById(id: string): Promise<RallyRecord | null> {
    const r = this.byId.get(id)
    return r ? { ...r } : null
  }

  async listForGroup(groupId: string): Promise<RallyRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.groupId === groupId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
      .map((r) => ({ ...r }))
  }

  async patch(id: string, fields: PatchRallyInput): Promise<RallyRecord | null> {
    const r = this.byId.get(id)
    if (!r) return null
    if (fields.title !== undefined) r.title = fields.title
    if (fields.description !== undefined) r.description = fields.description
    if (fields.dayId !== undefined) r.dayId = fields.dayId
    if (fields.startTime !== undefined) r.startTime = fields.startTime
    if (fields.poiId !== undefined) r.poiId = fields.poiId
    if (fields.locationLabel !== undefined) r.locationLabel = fields.locationLabel
    if (fields.lat !== undefined) r.lat = fields.lat
    if (fields.lng !== undefined) r.lng = fields.lng
    if (fields.status !== undefined) r.status = fields.status
    r.updatedAt = new Date()
    return { ...r }
  }

  async delete(id: string): Promise<boolean> {
    const existed = this.byId.delete(id)
    // Mirror the FK cascade: rally_attendees disappear.
    if (existed) this.attendees?.removeByRally(id)
    return existed
  }

  // Synchronous lookup used by MemoryRallyAttendeeRepo.deleteForUserInGroup
  // (the attendee repo holds no group↔rally mapping of its own).
  groupRallyIds(groupId: string): Set<string> {
    const ids = new Set<string>()
    for (const r of this.byId.values()) if (r.groupId === groupId) ids.add(r.id)
    return ids
  }
}

export class MemoryRallyAttendeeRepo implements RallyAttendeeRepo {
  private rows: RallyAttendeeRecord[] = []
  // Back-reference set in buildMemoryRepos so deleteForUserInGroup can
  // resolve which rallies belong to the group (mirrors maps.pois wiring).
  rallies?: MemoryRallyRepo

  async upsert(input: {
    id: string
    rallyId: string
    userId: string
    status: RallyRsvpStatus
  }): Promise<RallyAttendeeRecord> {
    const existing = this.rows.find((r) => r.rallyId === input.rallyId && r.userId === input.userId)
    if (existing) {
      existing.status = input.status
      existing.respondedAt = new Date()
      return { ...existing }
    }
    const rec: RallyAttendeeRecord = {
      id: input.id,
      rallyId: input.rallyId,
      userId: input.userId,
      status: input.status,
      respondedAt: new Date(),
    }
    this.rows.push(rec)
    return { ...rec }
  }

  async listForRally(rallyId: string): Promise<RallyAttendeeRecord[]> {
    return this.rows
      .filter((r) => r.rallyId === rallyId)
      .sort((a, b) => a.respondedAt.getTime() - b.respondedAt.getTime())
      .map((r) => ({ ...r }))
  }

  async listForRallies(rallyIds: string[]): Promise<RallyAttendeeRecord[]> {
    const set = new Set(rallyIds)
    return this.rows
      .filter((r) => set.has(r.rallyId))
      .sort((a, b) => a.respondedAt.getTime() - b.respondedAt.getTime())
      .map((r) => ({ ...r }))
  }

  async deleteForUserInGroup(groupId: string, userId: string): Promise<number> {
    const groupRallies = this.rallies?.groupRallyIds(groupId) ?? new Set<string>()
    const before = this.rows.length
    this.rows = this.rows.filter((r) => !(r.userId === userId && groupRallies.has(r.rallyId)))
    return before - this.rows.length
  }

  // Helper for MemoryRallyRepo's CASCADE mirror (not in the interface).
  removeByRally(rallyId: string): void {
    this.rows = this.rows.filter((r) => r.rallyId !== rallyId)
  }
}

export class MemoryChatMessageRepo implements ChatMessageRepo {
  private byId = new Map<string, ChatMessageRecord>()
  // Monotonic counter so messages created in the same millisecond keep a
  // stable insertion order (the pg impl tie-breaks on id; ULIDs sort by
  // time, but tests insert fast enough to share a Date).
  private seq = 0
  private order = new Map<string, number>()

  async create(input: CreateChatMessageInput): Promise<ChatMessageRecord> {
    const rec: ChatMessageRecord = {
      id: input.id,
      groupId: input.groupId,
      userId: input.userId,
      body: input.body,
      createdAt: new Date(),
    }
    this.byId.set(rec.id, rec)
    this.order.set(rec.id, this.seq++)
    return { ...rec }
  }

  async findById(id: string): Promise<ChatMessageRecord | null> {
    const m = this.byId.get(id)
    return m ? { ...m } : null
  }

  async listForGroup(groupId: string, opts: ListChatOptions): Promise<ChatMessageRecord[]> {
    const sorted = [...this.byId.values()]
      .filter((m) => m.groupId === groupId)
      .sort((a, b) => this.order.get(b.id)! - this.order.get(a.id)!) // newest first
    // Only honour a cursor that belongs to this group (the pg impl scopes the
    // cursor lookup by group_id; a foreign id must not bound this group's page).
    const cursorRow = opts.before ? this.byId.get(opts.before) : undefined
    const cursorRank =
      cursorRow && cursorRow.groupId === groupId ? this.order.get(opts.before!) : undefined
    const page = (cursorRank === undefined
      ? sorted
      : sorted.filter((m) => this.order.get(m.id)! < cursorRank)
    ).slice(0, opts.limit)
    return page.map((m) => ({ ...m }))
  }

  // Helper for MemoryGroupRepo's CASCADE mirror (not in the interface).
  removeByGroup(groupId: string): void {
    for (const [id, m] of this.byId) {
      if (m.groupId === groupId) {
        this.byId.delete(id)
        this.order.delete(id)
      }
    }
  }
}

export class MemoryEventWeatherRepo implements EventWeatherRepo {
  rows = new Map<string, EventWeatherRecord>()

  async findByEventId(eventId: string): Promise<EventWeatherRecord | null> {
    const r = this.rows.get(eventId)
    return r ? { ...r } : null
  }

  async upsert(input: UpsertEventWeatherInput): Promise<EventWeatherRecord> {
    const now = new Date()
    const errorAt = input.errorAt === undefined ? null : input.errorAt
    const errorCode = input.errorCode === undefined ? null : input.errorCode
    const rec: EventWeatherRecord = {
      eventId: input.eventId,
      forecast: input.forecast,
      airQuality: input.airQuality,
      fetchedLat: input.fetchedLat,
      fetchedLng: input.fetchedLng,
      fetchedAt: now,
      errorAt,
      errorCode,
      updatedAt: now,
    }
    this.rows.set(rec.eventId, rec)
    return { ...rec }
  }

  async markError(eventId: string, errorCode: string, when: Date): Promise<void> {
    const existing = this.rows.get(eventId)
    const next: EventWeatherRecord = existing
      ? { ...existing, errorAt: when, errorCode, updatedAt: when }
      : {
          eventId,
          forecast: null,
          airQuality: null,
          fetchedLat: null,
          fetchedLng: null,
          fetchedAt: when,
          errorAt: when,
          errorCode,
          updatedAt: when,
        }
    this.rows.set(eventId, next)
  }
}

export class MemoryEventSetStarRepo implements EventSetStarRepo {
  // Key: `${userId}:${eventId}:${artistId}:${dayId}`
  private rows = new Map<string, SetStarKey & { userId: string }>()

  private key(userId: string, k: SetStarKey): string {
    return `${userId}:${k.eventId}:${k.artistId}:${k.dayId}`
  }

  async star(userId: string, key: SetStarKey): Promise<boolean> {
    const k = this.key(userId, key)
    if (this.rows.has(k)) return false
    this.rows.set(k, { userId, ...key })
    return true
  }

  async unstar(userId: string, key: SetStarKey): Promise<boolean> {
    return this.rows.delete(this.key(userId, key))
  }

  async listForUserEvent(userId: string, eventId: string): Promise<SetStarKey[]> {
    const results: SetStarKey[] = []
    for (const [, r] of this.rows) {
      if (r.userId === userId && r.eventId === eventId) {
        results.push({ eventId: r.eventId, artistId: r.artistId, dayId: r.dayId })
      }
    }
    return results
  }

  async isStarred(userId: string, key: SetStarKey): Promise<boolean> {
    return this.rows.has(this.key(userId, key))
  }

  // Called by MemoryEventArtistRepo.delete to mirror FK cascade.
  deleteForSlot(eventId: string, artistId: string, dayId: string): void {
    for (const [k, r] of this.rows) {
      if (r.eventId === eventId && r.artistId === artistId && r.dayId === dayId) {
        this.rows.delete(k)
      }
    }
  }
}

export class MemoryEventSnapshotRepo implements EventSnapshotRepo {
  private byId = new Map<string, SnapshotRecord>()

  async create(input: CreateSnapshotInput): Promise<SnapshotRecord> {
    const rec: SnapshotRecord = {
      id: input.id,
      eventId: input.eventId,
      kind: input.kind,
      data: input.data,
      reason: input.reason,
      itemCount: input.itemCount,
      createdByUserId: input.createdByUserId,
      createdAt: new Date(),
    }
    this.byId.set(rec.id, rec)
    return { ...rec }
  }

  async findById(id: string): Promise<SnapshotRecord | null> {
    const r = this.byId.get(id)
    return r ? { ...r } : null
  }

  async listForEvent(eventId: string, kind: SnapshotKind): Promise<SnapshotSummary[]> {
    return [...this.byId.values()]
      .filter((r) => r.eventId === eventId && r.kind === kind)
      .sort((a, b) => {
        const at = a.createdAt.toISOString()
        const bt = b.createdAt.toISOString()
        if (at !== bt) return at < bt ? 1 : -1
        return a.id < b.id ? 1 : -1
      })
      .map((r) => ({
        id: r.id,
        eventId: r.eventId,
        kind: r.kind,
        reason: r.reason,
        itemCount: r.itemCount,
        createdByUserId: r.createdByUserId,
        createdAt: r.createdAt,
      }))
  }

  async prune(eventId: string, kind: SnapshotKind, keep: number): Promise<number> {
    const ordered = [...this.byId.values()]
      .filter((r) => r.eventId === eventId && r.kind === kind)
      .sort((a, b) => {
        const at = a.createdAt.toISOString()
        const bt = b.createdAt.toISOString()
        if (at !== bt) return at < bt ? 1 : -1
        return a.id < b.id ? 1 : -1
      })
    const drop = ordered.slice(keep)
    for (const r of drop) this.byId.delete(r.id)
    return drop.length
  }
}

export class MemoryPersonalTicketRepo implements PersonalTicketRepo {
  private rows: PersonalTicketRecord[] = []

  async create(input: CreatePersonalTicketInput): Promise<PersonalTicketRecord> {
    const rec: PersonalTicketRecord = {
      id: input.id,
      eventId: input.eventId,
      objectKey: input.objectKey,
      contentType: input.contentType,
      bytes: input.bytes,
      fileName: input.fileName ?? null,
      uploadedByUserId: input.uploadedByUserId,
      uploadedAt: new Date(),
    }
    this.rows.push(rec)
    return { ...rec }
  }

  async findById(id: string): Promise<PersonalTicketRecord | null> {
    const r = this.rows.find((row) => row.id === id)
    return r ? { ...r } : null
  }

  async listForEvent(eventId: string): Promise<PersonalTicketRecord[]> {
    return this.rows
      .filter((r) => r.eventId === eventId)
      .sort(
        (a, b) =>
          a.uploadedAt.getTime() - b.uploadedAt.getTime() ||
          (a.id < b.id ? -1 : 1),
      )
      .map((r) => ({ ...r }))
  }
}

export class MemoryEventPlannerPrefRepo implements EventPlannerPrefRepo {
  // keyed `${userId}:${eventId}` → show
  private prefs = new Map<string, boolean>()

  async upsert(eventId: string, userId: string, show: boolean): Promise<void> {
    this.prefs.set(`${userId}:${eventId}`, show)
  }

  async flaggedEventIdsForActor(userId: string): Promise<string[]> {
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
  const members = new MemoryEventMemberRepo()
  const maps = new MemoryEventMapRepo()
  const pois = new MemoryEventPoiRepo()
  const zones = new MemoryEventNoGoZoneRepo()
  // Mirror the FK cascade/set-null behaviour on map delete.
  maps.pois = pois
  maps.zones = zones
  const groupMembers = new MemoryGroupMemberRepo()
  const groupInvites = new MemoryGroupInviteRepo()
  const groups = new MemoryGroupRepo(groupMembers, groupInvites)
  const rallyAttendees = new MemoryRallyAttendeeRepo()
  const rallies = new MemoryRallyRepo(rallyAttendees)
  // Back-reference so attendee cleanup can resolve the group's rallies.
  rallyAttendees.rallies = rallies
  // Back-reference so group delete cascades its rallies (mirrors PG FK).
  groups.rallies = rallies
  const chatMessages = new MemoryChatMessageRepo()
  // Back-reference so group delete cascades its chat (mirrors PG FK).
  groups.chat = chatMessages
  // #171 — hoist event-level invite/attendee repos so the new
  // transactional methods (groups.createWithOwner / joinWithAttendee
  // and events.acceptInvite) can call into them via back-refs.
  const attendees = new MemoryEventAttendeeRepo()
  const invites = new MemoryEventInviteRepo()
  groups.attendees = attendees
  const events = new MemoryEventRepo(members)
  events.attendees = attendees
  events.invites = invites
  const eventArtists = new MemoryEventArtistRepo()
  const eventSetStars = new MemoryEventSetStarRepo()
  // Mirror the DB's event_set_stars → event_artists onDelete('cascade') FK (#201).
  eventArtists.eventSetStars = eventSetStars
  return {
    events,
    members,
    invites,
    attendees,
    tickets: new MemoryEventTicketRepo(),
    activity: new MemoryEventActivityRepo(),
    purgeLog: new MemoryEventPurgeLogRepo(),
    stages: new MemoryEventStageRepo(),
    days: new MemoryEventDayRepo(),
    artists: new MemoryArtistRepo(),
    eventArtists,
    eventSessions: new MemoryEventSessionRepo(),
    sessions: new MemoryEventsSessionRepo(),
    maps,
    pois,
    noGoZones: zones,
    groups,
    groupMembers,
    groupInvites,
    rallies,
    rallyAttendees,
    chatMessages,
    eventWeather: new MemoryEventWeatherRepo(),
    eventSetStars,
    eventSnapshots: new MemoryEventSnapshotRepo(),
    personalTickets: new MemoryPersonalTicketRepo(),
    eventPlannerPrefs: new MemoryEventPlannerPrefRepo(),
    rateLimit: new InMemoryRateLimitRepo(),
  }
}
