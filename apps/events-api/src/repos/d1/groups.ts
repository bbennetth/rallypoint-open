import { and, asc, eq, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { eventAttendees, groupInvites, groupMembers, groups } from '@rallypoint/events-db'
import type { CreateGroupInput, GroupRecord, GroupRepo, PatchGroupInput } from '../types.js'
import type { Db } from './db.js'
import { UniqueConstraintError } from '../errors.js'
import { mapUniqueViolation } from './_errors.js'

function rowToGroup(row: typeof groups.$inferSelect): GroupRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    name: row.name,
    description: row.description ?? null,
    startDate: row.startDate ?? null,
    endDate: row.endDate ?? null,
    joinCodeHash: row.joinCodeHash,
    ownerUserId: row.ownerUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export class D1GroupRepo implements GroupRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateGroupInput): Promise<GroupRecord> {
    try {
      const [row] = await this.db
        .insert(groups)
        .values({
          id: input.id,
          eventId: input.eventId,
          name: input.name,
          description: input.description ?? null,
          startDate: input.startDate ?? null,
          endDate: input.endDate ?? null,
          joinCodeHash: input.joinCodeHash,
          ownerUserId: input.ownerUserId,
        })
        .returning()
      return rowToGroup(row!)
    } catch (err) {
      throw mapUniqueViolation(err)
    }
  }

  async findById(id: string): Promise<GroupRecord | null> {
    const rows = await this.db.select().from(groups).where(eq(groups.id, id)).limit(1)
    return rows[0] ? rowToGroup(rows[0]) : null
  }

  async findByJoinCodeHash(joinCodeHash: string): Promise<GroupRecord | null> {
    const rows = await this.db
      .select()
      .from(groups)
      .where(eq(groups.joinCodeHash, joinCodeHash))
      .limit(1)
    return rows[0] ? rowToGroup(rows[0]) : null
  }

  async listForEvent(eventId: string): Promise<GroupRecord[]> {
    const rows = await this.db
      .select()
      .from(groups)
      .where(eq(groups.eventId, eventId))
      .orderBy(asc(groups.createdAt))
    return rows.map(rowToGroup)
  }

  async patch(id: string, fields: PatchGroupInput): Promise<GroupRecord | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (fields.name !== undefined) set.name = fields.name
    if (fields.description !== undefined) set.description = fields.description
    if (fields.startDate !== undefined) set.startDate = fields.startDate
    if (fields.endDate !== undefined) set.endDate = fields.endDate

    try {
      const [row] = await this.db.update(groups).set(set).where(eq(groups.id, id)).returning()
      return row ? rowToGroup(row) : null
    } catch (err) {
      throw mapUniqueViolation(err)
    }
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db.delete(groups).where(eq(groups.id, id)).returning({ id: groups.id })
    return rows.length > 0
  }

  async createWithOwner(input: {
    group: CreateGroupInput
    ownerMemberId: string
    attendeeId: string | null
  }): Promise<GroupRecord> {
    // Static write-set → db.batch([...]).
    // A unique violation on the group insert (name collision) is caught and
    // re-thrown as UniqueConstraintError so the route's existing 409 mapping
    // still works. The member + attendee writes will not execute if the first
    // statement throws inside the batch.
    const now = new Date()
    try {
      const stmts: BatchItem<'sqlite'>[] = [
        this.db
          .insert(groups)
          .values({
            id: input.group.id,
            eventId: input.group.eventId,
            name: input.group.name,
            description: input.group.description ?? null,
            startDate: input.group.startDate ?? null,
            endDate: input.group.endDate ?? null,
            joinCodeHash: input.group.joinCodeHash,
            ownerUserId: input.group.ownerUserId,
          })
          .returning(),
        this.db.insert(groupMembers).values({
          id: input.ownerMemberId,
          groupId: input.group.id,
          userId: input.group.ownerUserId,
          role: 'owner',
          joinedAt: now,
        }),
      ]
      if (input.attendeeId !== null) {
        stmts.push(
          this.db
            .insert(eventAttendees)
            .values({
              id: input.attendeeId,
              eventId: input.group.eventId,
              userId: input.group.ownerUserId,
            })
            .onConflictDoUpdate({
              target: [eventAttendees.eventId, eventAttendees.userId],
              set: {
                removedAt: null,
                joinedAt: sql`CASE WHEN ${eventAttendees.removedAt} IS NULL
                                     THEN ${eventAttendees.joinedAt}
                                     ELSE ${now.getTime()} END`,
              },
            }),
        )
      }
      const results = await this.db.batch(
        stmts as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]
      )
      const groupRows = results[0] as typeof groups.$inferSelect[]
      return rowToGroup(groupRows[0]!)
    } catch (err) {
      throw mapUniqueViolation(err)
    }
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
    // CAP DROPPED: D1 has no FOR UPDATE / interactive transactions, and the
    // user decision is that groups are uncapped. The join becomes:
    //   1. Check for existing member (duplicate / re-admission detection).
    //   2. Static batch: member insert + optional invite consume + attendee upsert.
    //
    // Dup-rejection relies on the (group_id, user_id) UNIQUE index — a
    // concurrent double-join produces a unique violation that surfaces as
    // `duplicate_active`. Cap dropped (#313): groups are uncapped; the
    // `full` path is gone from the interface and this method.
    const now = new Date()

    // Pre-read: check for existing membership and re-admission.
    const dup = await this.db
      .select({ id: groupMembers.id })
      .from(groupMembers)
      .where(
        and(eq(groupMembers.groupId, input.groupId), eq(groupMembers.userId, input.userId)),
      )
      .limit(1)

    let readmitted = false
    if (dup[0]) {
      // Event owner has no event_attendees row → genuine duplicate.
      if (input.attendeeId === null) {
        return { ok: false as const, reason: 'duplicate_active' as const }
      }
      const attendee = await this.db
        .select({ removedAt: eventAttendees.removedAt })
        .from(eventAttendees)
        .where(
          and(
            eq(eventAttendees.eventId, input.eventId),
            eq(eventAttendees.userId, input.userId),
          ),
        )
        .limit(1)
      if (!attendee[0] || attendee[0].removedAt === null) {
        return { ok: false as const, reason: 'duplicate_active' as const }
      }
      // Re-admission path: member row exists but attendee was soft-removed.
      readmitted = true
    }

    // Static write-set → db.batch([...]).
    // If not re-admission: insert member row. The UNIQUE index on
    // (group_id, user_id) serialises concurrent joins — a second joiner
    // racing past the pre-read above hits a unique violation here, which
    // mapUniqueViolation converts to UniqueConstraintError; the route
    // maps that to a 409 duplicate_active.
    // Build the statement list dynamically; cast to the tuple type that
    // db.batch() requires. At runtime there is always at least one stmt
    // (either member insert or attendee upsert), so the cast is safe.
    const stmts: BatchItem<'sqlite'>[] = []
    if (!readmitted) {
      stmts.push(
        this.db.insert(groupMembers).values({
          id: input.memberId,
          groupId: input.groupId,
          userId: input.userId,
          role: 'member',
          joinedAt: now,
        }),
      )
    }
    if (input.inviteId !== null) {
      stmts.push(
        this.db
          .update(groupInvites)
          .set({ consumedAt: now, consumedByUserId: input.userId })
          .where(eq(groupInvites.id, input.inviteId)),
      )
    }
    if (input.attendeeId !== null) {
      stmts.push(
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
              joinedAt: sql`CASE WHEN ${eventAttendees.removedAt} IS NULL
                                   THEN ${eventAttendees.joinedAt}
                                   ELSE ${now.getTime()} END`,
            },
          }),
      )
    }

    if (stmts.length > 0) {
      try {
        await this.db.batch(
          stmts as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]
        )
      } catch (err) {
        const mapped = mapUniqueViolation(err)
        if (mapped instanceof UniqueConstraintError) {
          return { ok: false as const, reason: 'duplicate_active' as const }
        }
        throw err
      }
    }

    return { ok: true as const, readmitted }
  }

  async transferOwnership(input: {
    groupId: string
    newOwnerUserId: string
    oldOwnerUserId: string
  }): Promise<void> {
    // Static write-set → db.batch([...]).
    const now = new Date()
    await this.db.batch([
      this.db
        .update(groups)
        .set({ ownerUserId: input.newOwnerUserId, updatedAt: now })
        .where(eq(groups.id, input.groupId)),
      this.db
        .update(groupMembers)
        .set({ role: 'owner' })
        .where(
          and(
            eq(groupMembers.groupId, input.groupId),
            eq(groupMembers.userId, input.newOwnerUserId),
          ),
        ),
      this.db
        .update(groupMembers)
        .set({ role: 'sidekick' })
        .where(
          and(
            eq(groupMembers.groupId, input.groupId),
            eq(groupMembers.userId, input.oldOwnerUserId),
          ),
        ),
    ])
  }
}
