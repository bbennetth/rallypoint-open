import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { listGroupMembers, listGroups } from '@rallypoint/lists-db'
import type { GroupRole } from '@rallypoint/lists-shared'
import type {
  AddGroupMemberInput,
  CreateGroupInput,
  GroupMemberRecord,
  GroupRecord,
  GroupRepo,
  UpdateGroupInput,
} from '../types.js'
import type { Db } from './db.js'
import { mapUniqueViolation } from './_errors.js'
import { UniqueConstraintError } from '../errors.js'

type Stmt = BatchItem<'sqlite'>

function rowToGroup(row: typeof listGroups.$inferSelect): GroupRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    description: row.description,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  }
}

function rowToMember(row: typeof listGroupMembers.$inferSelect): GroupMemberRecord {
  return {
    id: row.id,
    groupId: row.groupId,
    userId: row.userId,
    role: row.role as GroupRole,
    joinedAt: row.joinedAt,
  }
}

export class D1GroupRepo implements GroupRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateGroupInput): Promise<GroupRecord> {
    // The group and the creator's 'owner' membership must land atomically
    // so a group can never exist without its owner.
    // D1 has no interactive db.transaction(); use db.batch() instead.
    const insertGroup = this.db
      .insert(listGroups)
      .values({
        id: input.id,
        tenantId: input.tenantId,
        name: input.name,
        description: input.description ?? null,
        createdBy: input.createdBy,
      })
      .returning() as Stmt

    const insertOwnerMember = this.db
      .insert(listGroupMembers)
      .values({
        id: input.ownerMemberId,
        groupId: input.id,
        userId: input.createdBy,
        role: 'owner',
      }) as Stmt

    try {
      const batchResult = await this.db.batch([insertGroup, insertOwnerMember])
      const groupRows = batchResult[0] as (typeof listGroups.$inferSelect)[]
      return rowToGroup(groupRows[0]!)
    } catch (err) {
      // #277: two concurrent first-writes for the same (created_by, name)
      // both observe "no personal group" and race to create it. The second
      // write hits the list_groups_created_by_name_uq partial unique index.
      // Re-select the winner (oldest matching live row) and return it so
      // the losing racer's resolvePersonalScope() gets the correct group id
      // rather than an error. The winner's batch already inserted its owner
      // membership, so we do NOT attempt a second membership insert here.
      const mapped = mapUniqueViolation(err)
      if (mapped instanceof UniqueConstraintError) {
        const winner = await this.#selectLiveGroupByCreatorAndName(
          input.createdBy,
          input.name,
        )
        if (winner) return winner
      }
      throw err
    }
  }

  // Select the oldest LIVE group for a given creator + name. Used by
  // create() to recover from a (created_by, name) unique-constraint
  // conflict — the loser racer must return the winner's record. Matches
  // the oldest-wins invariant in selectPersonalGroup() (planner-api).
  async #selectLiveGroupByCreatorAndName(
    createdBy: string,
    name: string,
  ): Promise<GroupRecord | null> {
    const rows = await this.db
      .select()
      .from(listGroups)
      .where(
        and(
          eq(listGroups.createdBy, createdBy),
          eq(listGroups.name, name),
          isNull(listGroups.deletedAt),
        ),
      )
      .orderBy(asc(listGroups.createdAt), asc(listGroups.id))
      .limit(1)
    return rows[0] ? rowToGroup(rows[0]) : null
  }

  async findById(id: string): Promise<GroupRecord | null> {
    const rows = await this.db.select().from(listGroups).where(eq(listGroups.id, id)).limit(1)
    return rows[0] ? rowToGroup(rows[0]) : null
  }

  async listForUser(userId: string): Promise<GroupRecord[]> {
    const rows = await this.db
      .select({ group: listGroups })
      .from(listGroups)
      .innerJoin(listGroupMembers, eq(listGroupMembers.groupId, listGroups.id))
      .where(and(eq(listGroupMembers.userId, userId), isNull(listGroups.deletedAt)))
      .orderBy(desc(listGroups.createdAt), desc(listGroups.id))
    return rows.map((r) => rowToGroup(r.group))
  }

  async update(id: string, fields: UpdateGroupInput): Promise<GroupRecord | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (fields.name !== undefined) set.name = fields.name
    if (fields.description !== undefined) set.description = fields.description
    const [row] = await this.db
      .update(listGroups)
      .set(set)
      .where(eq(listGroups.id, id))
      .returning()
    return row ? rowToGroup(row) : null
  }

  async softDelete(id: string, when: Date): Promise<void> {
    await this.db
      .update(listGroups)
      .set({ deletedAt: when, updatedAt: new Date() })
      .where(eq(listGroups.id, id))
  }

  async addMember(input: AddGroupMemberInput): Promise<GroupMemberRecord> {
    const [row] = await this.db
      .insert(listGroupMembers)
      .values({
        id: input.id,
        groupId: input.groupId,
        userId: input.userId,
        role: input.role,
      })
      .returning()
    return rowToMember(row!)
  }

  async listMembers(groupId: string): Promise<GroupMemberRecord[]> {
    const rows = await this.db
      .select()
      .from(listGroupMembers)
      .where(eq(listGroupMembers.groupId, groupId))
      .orderBy(asc(listGroupMembers.joinedAt), asc(listGroupMembers.id))
    return rows.map(rowToMember)
  }

  async findMembership(groupId: string, userId: string): Promise<GroupMemberRecord | null> {
    const rows = await this.db
      .select()
      .from(listGroupMembers)
      .where(and(eq(listGroupMembers.groupId, groupId), eq(listGroupMembers.userId, userId)))
      .limit(1)
    return rows[0] ? rowToMember(rows[0]) : null
  }
}
