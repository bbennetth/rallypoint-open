/// <reference types="@cloudflare/workers-types" />
import { WorkerEntrypoint } from 'cloudflare:workers'
import { z } from 'zod'
import type { FeedbackRecord, TraceImage, TraceRecord } from '@rallypoint/ai'
import { ensureDeps, type WorkerEnv } from './worker.js'
import { scheduleFlush } from './logger.js'
import { purgeUserData } from './services/deletion.js'

// Cross-Worker RPC entrypoint for ai-api — the ingest surface of the AI
// trace corpus. AI-consuming apps (fitness today, planner soon) bind
// this class via:
//
//   [[services]]
//   binding = "AI_TRACES"
//   service = "rallypoint-ai"
//   entrypoint = "AiRPC"
//
// recordTrace is called fire-and-forget from @rallypoint/ai's
// tracedAiRun (inside the caller's waitUntil), so it is defensive: it
// validates, logs, and swallows — a malformed record or R2 hiccup must
// never propagate anywhere near a user-facing call.

const contentPartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image_r2'),
    key: z.string(),
    mimeType: z.string(),
    bytes: z.number().int().min(0),
  }),
])

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.array(contentPartSchema),
})

// Ids land inside R2 object keys (`traces/{userId}/{traceId}/...`), so
// constrain them to a slash-free charset — a crafted "a/b" id must not
// be able to reshape the key hierarchy the prefix-scoped purge relies on.
const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)

const traceRecordSchema = z.object({
  responseId: idSchema,
  traceId: idSchema,
  parentId: idSchema.optional(),
  userId: idSchema,
  app: z.string().min(1).max(64),
  feature: z.string().min(1).max(64),
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  request: z
    .object({
      messages: z.array(messageSchema),
      params: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  response: z.object({ messages: z.array(messageSchema) }).optional(),
  latencyMs: z.number().int().min(0),
  tokensIn: z.number().int().min(0).optional(),
  tokensOut: z.number().int().min(0).optional(),
  finishReason: z.string().max(64).optional(),
  error: z.string().max(2048).optional(),
  cached: z.boolean(),
  contentOmitted: z.boolean(),
  schemaVersion: z.number().int().min(1),
})

const feedbackSchema = z.object({
  responseId: idSchema,
  userId: idSchema,
  action: z.enum(['accepted', 'edited', 'rejected', 'retried']),
  finalValue: z.unknown().optional(),
})

function extFromMime(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/png':
      return 'png'
    case 'image/webp':
      return 'webp'
    default:
      return 'bin'
  }
}

/** Rewrite `#<index>` placeholder keys in the record's messages to the
 * real R2 object keys. Mutates a deep-enough copy and returns it. */
function finalizeImageKeys(
  messages: TraceRecord['request'],
  keyByIndex: Map<number, string>,
): TraceRecord['request'] {
  if (!messages) return messages
  return {
    ...messages,
    messages: messages.messages.map((m) => ({
      ...m,
      content: m.content.map((part) => {
        if (part.type !== 'image_r2' || !part.key.startsWith('#')) return part
        const index = Number(part.key.slice(1))
        const key = keyByIndex.get(index)
        return key ? { ...part, key } : part
      }),
    })),
  }
}

export class AiRPC extends WorkerEntrypoint<WorkerEnv> {
  /** Persist one model-call trace. Best-effort by contract: validation
   * failures and storage errors are logged and swallowed. */
  async recordTrace(record: TraceRecord, images?: TraceImage[]): Promise<void> {
    const d = ensureDeps(this.env)
    try {
      const parsed = traceRecordSchema.safeParse(record)
      if (!parsed.success) {
        d.logger.warn(
          { issues: parsed.error.issues.slice(0, 5), app: record?.app },
          'recordTrace: invalid record dropped',
        )
        return
      }
      const rec = parsed.data
      // Opt-out is enforced server-side too: content_omitted records never
      // persist content or blobs, whatever the caller sent.
      const omit = rec.contentOmitted
      const keyByIndex = new Map<number, string>()
      if (!omit && images) {
        for (const image of images) {
          const key = `traces/${rec.userId}/${rec.traceId}/${rec.responseId}/${image.index}.${extFromMime(image.mimeType)}`
          await this.env.AI_STORE.put(key, image.bytes, {
            httpMetadata: { contentType: image.mimeType },
          })
          keyByIndex.set(image.index, key)
        }
      }
      const request = omit
        ? undefined
        : finalizeImageKeys(rec.request as TraceRecord['request'], keyByIndex)
      await d.repos.traces.insertTrace({
        id: rec.responseId,
        traceId: rec.traceId,
        parentId: rec.parentId ?? null,
        userId: rec.userId,
        app: rec.app,
        feature: rec.feature,
        provider: rec.provider,
        model: rec.model,
        requestJson: request ? JSON.stringify(request) : null,
        responseJson: !omit && rec.response ? JSON.stringify(rec.response) : null,
        latencyMs: rec.latencyMs,
        tokensIn: rec.tokensIn ?? null,
        tokensOut: rec.tokensOut ?? null,
        finishReason: rec.finishReason ?? null,
        error: rec.error ?? null,
        cached: rec.cached ? 1 : 0,
        contentOmitted: omit ? 1 : 0,
        schemaVersion: rec.schemaVersion,
      })
    } catch (err) {
      d.logger.error({ err }, 'recordTrace failed')
    } finally {
      scheduleFlush(this.ctx, d.flushLogs)
    }
  }

  /** Record a user action on a model response. `ok: false` when the
   * responseId is unknown (expired/purged trace — the client treats it as
   * fire-and-forget either way). finalValue is nulled server-side when
   * the parent trace has content omitted: opt-out suppresses content,
   * never the action itself. */
  async recordFeedback(fb: FeedbackRecord): Promise<{ ok: boolean }> {
    const d = ensureDeps(this.env)
    try {
      const parsed = feedbackSchema.safeParse(fb)
      if (!parsed.success) {
        d.logger.warn({ issues: parsed.error.issues.slice(0, 5) }, 'recordFeedback: invalid')
        return { ok: false }
      }
      const rec = parsed.data
      const trace = await d.repos.traces.findTrace(rec.responseId)
      if (!trace) return { ok: false }
      // Feedback may only come from the user the trace belongs to — a
      // guessed/leaked responseId must not let someone else label it.
      if (trace.userId !== rec.userId) return { ok: false }
      const keepContent = trace.contentOmitted === 0 && rec.finalValue !== undefined
      await d.repos.traces.insertFeedback({
        id: crypto.randomUUID(),
        responseId: rec.responseId,
        userId: rec.userId,
        action: rec.action,
        finalValueJson: keepContent ? JSON.stringify(rec.finalValue) : null,
      })
      return { ok: true }
    } finally {
      scheduleFlush(this.ctx, d.flushLogs)
    }
  }

  /** Purge everything stored for a user: trace rows, feedback rows, and
   * R2 blobs under the user's prefix. Called by the daily deletion sweep
   * and available directly for a future account-purge fan-out. */
  async deleteUserData(
    userId: string,
  ): Promise<{ traces: number; feedback: number; blobs: number }> {
    const d = ensureDeps(this.env)
    try {
      return await purgeUserData(d.repos.traces, this.env.AI_STORE, userId)
    } finally {
      scheduleFlush(this.ctx, d.flushLogs)
    }
  }
}
