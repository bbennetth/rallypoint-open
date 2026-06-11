import {
  and,
  asc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from 'drizzle-orm'
import {
  eventAttendees,
  eventInvites,
  eventMembers,
  events,
  personalTickets,
} from '@rallypoint/events-db'
import type {
  CreateEventInput,
  EventRecord,
  EventRepo,
  ListEventsOptions,
  ListEventsPage,
  MemberRole,
  PatchEventInput,
  PrivacyMode,
  ScopeType,
} from '../types.js'
import type { Db } from './db.js'
import { UniqueConstraintError } from '../errors.js'
import { mapUniqueViolation } from './_errors.js'

function num(n: number | null | undefined): number | null {
  return n === null || n === undefined ? null : n
}

// ticketCount: correlated subquery. personalTickets has no soft-delete.
const ticketCountSql = sql<number>`(
  select count(*) from ${personalTickets}
  where ${personalTickets.eventId} = ${events}.${sql.identifier('id')}
)`

function rowToEvent(
  row: typeof events.$inferSelect & { ticketCount?: number },
): EventRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ownerUserId: row.ownerUserId,
    slug: row.slug,
    name: row.name,
    description: row.description ?? null,
    startDate: row.startDate ?? null,
    endDate: row.endDate ?? null,
    timezone: row.timezone,
    locationLabel: row.locationLabel ?? null,
    // SQLite stores lat/lng as real — surface as strings to match the
    // types.ts contract (numeric(9,6) columns came back as strings in PG).
    locationLat: row.locationLat != null ? String(row.locationLat) : null,
    locationLng: row.locationLng != null ? String(row.locationLng) : null,
    privacyMode: row.privacyMode as PrivacyMode,
    publicPageConfig: row.publicPageConfig ?? null,
    scopeType: row.scopeType as ScopeType,
    startAt: row.startAt,
    endAt: row.endAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? null,
    ticketCount: (row.ticketCount as number | bigint | undefined)
      ? Number(row.ticketCount)
      : 0,
    ticketPlatform: row.ticketPlatform ?? null,
    ticketAccountEmail: row.ticketAccountEmail ?? null,
  }
}

function encodeCursor(e: EventRecord): string {
  return Buffer.from(`${e.createdAt.toISOString()}|${e.id}`, 'utf8').toString('base64url')
}
function decodeCursor(c: string): { at: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(c, 'base64url').toString('utf8').split('|')
    if (!iso || !id) return null
    const at = new Date(iso)
    return Number.isNaN(at.getTime()) ? null : { at, id }
  } catch {
    return null
  }
}

export class D1EventRepo implements EventRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateEventInput): Promise<EventRecord> {
    try {
      const [row] = await this.db
        .insert(events)
        .values({
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
          ...(input.scopeType !== undefined ? { scopeType: input.scopeType } : {}),
          startAt: input.startAt ?? null,
          endAt: input.endAt ?? null,
          ticketPlatform: input.ticketPlatform ?? null,
          ticketAccountEmail: input.ticketAccountEmail ?? null,
        })
        .returning()
      return rowToEvent(row!)
    } catch (err) {
      throw mapUniqueViolation(err)
    }
  }

  async findById(id: string): Promise<EventRecord | null> {
    const rows = await this.db
      .select({ ...getTableColumns(events), ticketCount: ticketCountSql })
      .from(events)
      .where(eq(events.id, id))
      .limit(1)
    return rows[0] ? rowToEvent(rows[0]) : null
  }

  async findBySlug(tenantId: string, slug: string): Promise<EventRecord | null> {
    const rows = await this.db
      .select()
      .from(events)
      .where(and(eq(events.tenantId, tenantId), eq(events.slug, slug)))
      .limit(1)
    return rows[0] ? rowToEvent(rows[0]) : null
  }

  async listForUser(userId: string, opts: ListEventsOptions): Promise<ListEventsPage> {
    const memberRows = await this.db
      .select({ eventId: eventMembers.eventId })
      .from(eventMembers)
      .where(eq(eventMembers.userId, userId))
    const memberEventIds = memberRows.map((r) => r.eventId)

    const visibility =
      memberEventIds.length > 0
        ? or(eq(events.ownerUserId, userId), inArray(events.id, memberEventIds))
        : eq(events.ownerUserId, userId)

    const conds = [visibility]
    if (!opts.includeDeleted) conds.push(isNull(events.deletedAt))

    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null
    if (cursor) {
      conds.push(
        or(
          lt(events.createdAt, cursor.at),
          and(eq(events.createdAt, cursor.at), lt(events.id, cursor.id)),
        ),
      )
    }

    const rows = await this.db
      .select()
      .from(events)
      .where(and(...conds))
      .orderBy(sql`${events.createdAt} desc, ${events.id} desc`)
      .limit(opts.limit + 1)

    const mapped = rows.map(rowToEvent)
    const hasMore = mapped.length > opts.limit
    const items = hasMore ? mapped.slice(0, opts.limit) : mapped
    const nextCursor = hasMore && items.length > 0 ? encodeCursor(items[items.length - 1]!) : null
    return { items, nextCursor }
  }

  async patch(id: string, fields: PatchEventInput): Promise<EventRecord | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (fields.name !== undefined) set.name = fields.name
    if (fields.slug !== undefined) set.slug = fields.slug
    if (fields.description !== undefined) set.description = fields.description
    if (fields.startDate !== undefined) set.startDate = fields.startDate
    if (fields.endDate !== undefined) set.endDate = fields.endDate
    if (fields.startAt !== undefined) set.startAt = fields.startAt
    if (fields.endAt !== undefined) set.endAt = fields.endAt
    if (fields.timezone !== undefined) set.timezone = fields.timezone
    if (fields.locationLabel !== undefined) set.locationLabel = fields.locationLabel
    if (fields.locationLat !== undefined) set.locationLat = num(fields.locationLat)
    if (fields.locationLng !== undefined) set.locationLng = num(fields.locationLng)
    if (fields.privacyMode !== undefined) set.privacyMode = fields.privacyMode
    if (fields.publicPageConfig !== undefined) set.publicPageConfig = fields.publicPageConfig
    if (fields.ticketPlatform !== undefined) set.ticketPlatform = fields.ticketPlatform
    if (fields.ticketAccountEmail !== undefined) set.ticketAccountEmail = fields.ticketAccountEmail

    try {
      const [row] = await this.db.update(events).set(set).where(eq(events.id, id)).returning()
      return row ? rowToEvent(row) : null
    } catch (err) {
      throw mapUniqueViolation(err)
    }
  }

  async softDelete(id: string, when: Date): Promise<void> {
    await this.db
      .update(events)
      .set({ deletedAt: when, updatedAt: new Date() })
      .where(eq(events.id, id))
  }

  async restore(id: string): Promise<void> {
    await this.db
      .update(events)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(eq(events.id, id))
  }

  async listSoftDeletedBefore(cutoff: Date): Promise<EventRecord[]> {
    const rows = await this.db
      .select()
      .from(events)
      .where(and(isNotNull(events.deletedAt), lt(events.deletedAt, cutoff)))
      .orderBy(events.deletedAt)
    return rows.map(rowToEvent)
  }

  async listForWeatherRefresh(input: {
    windowStart: Date
    windowEnd: Date
    limit: number
  }): Promise<EventRecord[]> {
    const windowStartIso = input.windowStart.toISOString().slice(0, 10)
    const windowEndIso = input.windowEnd.toISOString().slice(0, 10)
    const rows = await this.db
      .select()
      .from(events)
      .where(
        and(
          isNull(events.deletedAt),
          isNotNull(events.locationLat),
          isNotNull(events.locationLng),
          or(
            isNull(events.startDate),
            lt(events.startDate, windowEndIso),
            eq(events.startDate, windowEndIso),
          ),
          or(
            isNull(events.endDate),
            gte(events.endDate, windowStartIso),
          ),
        ),
      )
      .orderBy(asc(events.startDate), asc(events.id))
      .limit(input.limit)
    return rows.map(rowToEvent)
  }

  async hardDelete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(events)
      .where(eq(events.id, id))
      .returning({ id: events.id })
    return rows.length > 0
  }

  async listPersonalForUser(
    ownerUserId: string,
    opts: { from?: Date | null | undefined; to?: Date | null | undefined },
  ): Promise<EventRecord[]> {
    const conds = [
      eq(events.tenantId, 'rallypoint'),
      eq(events.scopeType, 'personal'),
      eq(events.ownerUserId, ownerUserId),
      isNull(events.deletedAt),
    ]
    if (opts.from) conds.push(gte(events.startAt, opts.from))
    if (opts.to) conds.push(lt(events.startAt, opts.to))
    const rows = await this.db
      .select({ ...getTableColumns(events), ticketCount: ticketCountSql })
      .from(events)
      .where(and(...conds))
      .orderBy(sql`${events.startAt} asc nulls last`, asc(events.id))
    return rows.map(rowToEvent)
  }

  async listGroupForUser(userId: string): Promise<EventRecord[]> {
    const [memberRows, attendeeRows] = await Promise.all([
      this.db
        .select({ eventId: eventMembers.eventId })
        .from(eventMembers)
        .where(eq(eventMembers.userId, userId)),
      this.db
        .select({ eventId: eventAttendees.eventId })
        .from(eventAttendees)
        .where(and(eq(eventAttendees.userId, userId), isNull(eventAttendees.removedAt))),
    ])
    const relatedIds = Array.from(
      new Set([...memberRows.map((r) => r.eventId), ...attendeeRows.map((r) => r.eventId)]),
    )

    const visibility =
      relatedIds.length > 0
        ? or(eq(events.ownerUserId, userId), inArray(events.id, relatedIds))
        : eq(events.ownerUserId, userId)

    const rows = await this.db
      .select()
      .from(events)
      .where(
        and(
          eq(events.tenantId, 'rallypoint'),
          eq(events.scopeType, 'group'),
          isNull(events.deletedAt),
          visibility,
        ),
      )
      .orderBy(sql`${events.startDate} asc nulls last`, asc(events.id))
    return rows.map(rowToEvent)
  }

  async transferOwnership(input: {
    eventId: string
    newOwnerUserId: string
    oldOwnerUserId: string
    oldOwnerMemberId: string
  }): Promise<void> {
    // Static write-set → db.batch([...]).
    const now = new Date()
    await this.db.batch([
      this.db
        .update(events)
        .set({ ownerUserId: input.newOwnerUserId, updatedAt: now })
        .where(eq(events.id, input.eventId)),
      this.db
        .delete(eventMembers)
        .where(
          and(
            eq(eventMembers.eventId, input.eventId),
            eq(eventMembers.userId, input.newOwnerUserId),
          ),
        ),
      this.db.insert(eventMembers).values({
        id: input.oldOwnerMemberId,
        eventId: input.eventId,
        userId: input.oldOwnerUserId,
        role: 'editor',
      }),
    ])
  }

  async acceptInvite(input: {
    memberId: string
    attendeeId: string
    eventId: string
    userId: string
    role: MemberRole
    inviteId: string
    skipMemberAdd: boolean
  }): Promise<
    { ok: true; readmitted: boolean } | { ok: false; reason: 'already_active_member' }
  > {
    const now = new Date()

    // Conditional member insert: if skipMemberAdd is false, try it solo
    // first so we can catch the unique violation for double-accept.
    if (!input.skipMemberAdd) {
      try {
        await this.db.insert(eventMembers).values({
          id: input.memberId,
          eventId: input.eventId,
          userId: input.userId,
          role: input.role,
        })
      } catch (err) {
        const mapped = mapUniqueViolation(err)
        if (mapped instanceof UniqueConstraintError) {
          return { ok: false as const, reason: 'already_active_member' as const }
        }
        throw err
      }
    }

    // Static write-set: attendee upsert + invite consume in one batch.
    // The member row is already inserted above (or skipped), so the
    // remaining writes are always the same two statements.
    await this.db.batch([
      this.db
        .insert(eventAttendees)
        .values({
          id: input.attendeeId,
          eventId: input.eventId,
          userId: input.userId,
        })
        .onConflictDoUpdate({
          target: [eventAttendees.eventId, eventAttendees.userId],
          set: {
            removedAt: null,
            // Re-admission: refresh joinedAt only when the row was removed.
            // app-side timestamp avoids now() in SQL (SQLite compatibility).
            joinedAt: sql`CASE WHEN ${eventAttendees.removedAt} IS NULL
                               THEN ${eventAttendees.joinedAt}
                               ELSE ${now.getTime()} END`,
          },
        }),
      this.db
        .update(eventInvites)
        .set({ consumedAt: now, consumedByUserId: input.userId })
        .where(eq(eventInvites.id, input.inviteId)),
    ])
    return { ok: true as const, readmitted: input.skipMemberAdd }
  }
}
