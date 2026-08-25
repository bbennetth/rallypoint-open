import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

// ai_traces — one row per model call, the AI trace corpus owned by ai-api.
// Apps call models directly (Workers AI via the AI Gateway); the
// @rallypoint/ai wrapper reports each call here fire-and-forget over the
// AiRPC service binding.
//
//   id             — the responseId minted by the wrapper; what clients echo
//                    back with feedback.
//   trace_id       — groups a chain (e.g. a scan + its correction re-scans);
//                    parent_id points at the prior response in the chain.
//   request_json / — vendor-neutral chat-message-list JSON. Image parts are
//   response_json    {type:'image_r2', key} references into the AI_STORE R2
//                    bucket, never inline data URLs. NULL when the user has
//                    opted out of content capture (content_omitted=1): opt-out
//                    suppresses content, never ops telemetry.
//   schema_version — bump when the message format grows so old rows stay
//                    interpretable.

export const aiTraces = sqliteTable(
  'ai_traces',
  {
    id: text('id').primaryKey(),
    traceId: text('trace_id').notNull(),
    parentId: text('parent_id'),
    userId: text('user_id').notNull(),
    app: text('app').notNull(),
    feature: text('feature').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    requestJson: text('request_json'),
    responseJson: text('response_json'),
    latencyMs: integer('latency_ms').notNull(),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    finishReason: text('finish_reason'),
    error: text('error'),
    cached: integer('cached').notNull().default(0),
    contentOmitted: integer('content_omitted').notNull().default(0),
    schemaVersion: integer('schema_version').notNull().default(1),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userIdx: index('ai_traces_user_idx').on(t.userId),
    traceIdx: index('ai_traces_trace_idx').on(t.traceId),
    createdIdx: index('ai_traces_created_idx').on(t.createdAt),
  }),
)

export type DbAiTrace = typeof aiTraces.$inferSelect
export type DbAiTraceInsert = typeof aiTraces.$inferInsert
