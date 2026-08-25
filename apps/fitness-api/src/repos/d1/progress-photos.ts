import { and, desc, eq, gte, lt, lte, or } from 'drizzle-orm'
import { PROGRESS_PHOTO_DEFAULT_LIMIT } from '@rallypoint/fitness-shared'
import { progressPhotos } from '@rallypoint/fitness-db'
import type {
  NewProgressPhoto,
  PatchProgressPhotoFields,
  ProgressPhotoListFilter,
  ProgressPhotoRecord,
  ProgressPhotoRepo,
} from '../types.js'
import type { Db } from './db.js'

type ProgressPhotoRow = typeof progressPhotos.$inferSelect

function rowToRecord(row: ProgressPhotoRow): ProgressPhotoRecord {
  return {
    id: row.id,
    userId: row.userId,
    setId: row.setId ?? null,
    takenAt: row.takenAt,
    pose: row.pose,
    objectKey: row.objectKey,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    note: row.note ?? null,
    createdAt: row.createdAt,
  }
}

export class D1ProgressPhotoRepo implements ProgressPhotoRepo {
  constructor(private readonly db: Db) {}

  async listForActor(
    userId: string,
    filter: ProgressPhotoListFilter,
  ): Promise<ProgressPhotoRecord[]> {
    const limit = Math.min(filter.limit ?? PROGRESS_PHOTO_DEFAULT_LIMIT, 500)

    const conds = [eq(progressPhotos.userId, userId)]
    if (filter.pose) conds.push(eq(progressPhotos.pose, filter.pose))
    if (filter.from) conds.push(gte(progressPhotos.takenAt, filter.from))
    if (filter.to) conds.push(lte(progressPhotos.takenAt, filter.to))
    if (filter.before) {
      // Strictly after the cursor in (takenAt DESC, id DESC) order —
      // the id tiebreak keeps equal-takenAt rows from being skipped.
      conds.push(
        or(
          lt(progressPhotos.takenAt, filter.before.takenAt),
          and(
            eq(progressPhotos.takenAt, filter.before.takenAt),
            lt(progressPhotos.id, filter.before.id),
          ),
        )!,
      )
    }

    const rows = await this.db
      .select()
      .from(progressPhotos)
      .where(and(...conds))
      .orderBy(desc(progressPhotos.takenAt), desc(progressPhotos.id))
      .limit(limit)

    return rows.map(rowToRecord)
  }

  async getForActor(userId: string, id: string): Promise<ProgressPhotoRecord | null> {
    const rows = await this.db
      .select()
      .from(progressPhotos)
      .where(and(eq(progressPhotos.id, id), eq(progressPhotos.userId, userId)))
      .limit(1)

    const row = rows[0]
    return row ? rowToRecord(row) : null
  }

  async create(input: NewProgressPhoto): Promise<ProgressPhotoRecord> {
    const now = new Date()
    const insertRow: typeof progressPhotos.$inferInsert = {
      id: input.id,
      userId: input.userId,
      setId: input.setId,
      takenAt: input.takenAt,
      pose: input.pose,
      objectKey: input.objectKey,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      createdAt: now,
    }
    if (input.note !== undefined) insertRow.note = input.note

    await this.db.insert(progressPhotos).values(insertRow)

    return {
      id: input.id,
      userId: input.userId,
      setId: input.setId,
      takenAt: input.takenAt,
      pose: input.pose,
      objectKey: input.objectKey,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      note: input.note ?? null,
      createdAt: now,
    }
  }

  async update(
    userId: string,
    id: string,
    fields: PatchProgressPhotoFields,
  ): Promise<ProgressPhotoRecord | null> {
    // Verify ownership first.
    const existing = await this.getForActor(userId, id)
    if (!existing) return null

    const updateVals: Partial<typeof progressPhotos.$inferInsert> = {}
    if (fields.pose !== undefined) updateVals.pose = fields.pose
    if (fields.takenAt !== undefined) updateVals.takenAt = fields.takenAt
    if ('note' in fields) updateVals.note = fields.note ?? null
    if (Object.keys(updateVals).length === 0) return existing

    await this.db.update(progressPhotos).set(updateVals).where(eq(progressPhotos.id, id))

    return {
      ...existing,
      ...(fields.pose !== undefined ? { pose: fields.pose } : {}),
      ...(fields.takenAt !== undefined ? { takenAt: fields.takenAt } : {}),
      ...('note' in fields ? { note: fields.note ?? null } : {}),
    }
  }

  async delete(userId: string, id: string): Promise<ProgressPhotoRecord | null> {
    const existing = await this.getForActor(userId, id)
    if (!existing) return null

    await this.db.delete(progressPhotos).where(eq(progressPhotos.id, id))
    return existing
  }

  async distinctPoses(userId: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ pose: progressPhotos.pose })
      .from(progressPhotos)
      .where(eq(progressPhotos.userId, userId))
      .orderBy(progressPhotos.pose)

    return rows.map((r) => r.pose)
  }
}
