import { and, eq, desc, lt, or, type SQL } from 'drizzle-orm'
import { chatMessages } from '@rallypoint/events-db'
import type {
  ChatMessageRecord,
  ChatMessageRepo,
  CreateChatMessageInput,
  ListChatOptions,
} from '../types.js'
import type { Db } from './db.js'

function rowToMessage(row: typeof chatMessages.$inferSelect): ChatMessageRecord {
  return {
    id: row.id,
    groupId: row.groupId,
    userId: row.userId,
    body: row.body,
    createdAt: row.createdAt,
  }
}

export class D1ChatMessageRepo implements ChatMessageRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateChatMessageInput): Promise<ChatMessageRecord> {
    const [row] = await this.db
      .insert(chatMessages)
      .values({
        id: input.id,
        groupId: input.groupId,
        userId: input.userId,
        body: input.body,
      })
      .returning()
    return rowToMessage(row!)
  }

  async findById(id: string): Promise<ChatMessageRecord | null> {
    const rows = await this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, id))
      .limit(1)
    return rows[0] ? rowToMessage(rows[0]) : null
  }

  async listForGroup(groupId: string, opts: ListChatOptions): Promise<ChatMessageRecord[]> {
    const cursor = opts.before
      ? await this.db
          .select({ createdAt: chatMessages.createdAt, id: chatMessages.id })
          .from(chatMessages)
          .where(and(eq(chatMessages.groupId, groupId), eq(chatMessages.id, opts.before)))
          .limit(1)
      : []
    const boundary: SQL | undefined = cursor[0]
      ? or(
          lt(chatMessages.createdAt, cursor[0].createdAt),
          and(eq(chatMessages.createdAt, cursor[0].createdAt), lt(chatMessages.id, cursor[0].id)),
        )
      : undefined

    const rows = await this.db
      .select()
      .from(chatMessages)
      .where(
        boundary
          ? and(eq(chatMessages.groupId, groupId), boundary)
          : eq(chatMessages.groupId, groupId),
      )
      .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
      .limit(opts.limit)
    return rows.map(rowToMessage)
  }
}
