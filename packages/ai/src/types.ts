// Vendor-neutral AI trace types — the interchange shape between the
// @rallypoint/ai call wrapper (runs in each AI-consuming app) and ai-api
// (owns the trace corpus). Prompt/response content is a chat-message list
// (the de facto fine-tuning interchange format); vendor neutrality comes
// from recording the provider/model as plain strings, not abstracting
// them away. Bump TRACE_SCHEMA_VERSION whenever the message format grows
// so old rows stay interpretable.

export const TRACE_SCHEMA_VERSION = 1

export type TraceContentPart =
  | { type: 'text'; text: string }
  /** An image stored in ai-api's R2 bucket. The wrapper emits placeholder
   * keys (`#<index>` into the images array shipped alongside the record);
   * ai-api uploads the bytes and rewrites the key to the real R2 object
   * key before persisting, so R2 access stays solely in ai-api. */
  | { type: 'image_r2'; key: string; mimeType: string; bytes: number }

export interface TraceMessage {
  role: 'system' | 'user' | 'assistant'
  content: TraceContentPart[]
}

export interface TraceRecord {
  /** Unique id for this model response; clients echo it back as feedback. */
  responseId: string
  /** Chain id: a scan and its correction re-scans share one traceId. */
  traceId: string
  parentId?: string | undefined
  userId: string
  app: string
  feature: string
  provider: string
  model: string
  /** Omitted entirely when the user opted out of content capture. */
  request?: { messages: TraceMessage[]; params?: Record<string, unknown> } | undefined
  response?: { messages: TraceMessage[] } | undefined
  latencyMs: number
  tokensIn?: number | undefined
  tokensOut?: number | undefined
  finishReason?: string | undefined
  error?: string | undefined
  cached: boolean
  contentOmitted: boolean
  schemaVersion: number
}

/** Raw image bytes shipped alongside a TraceRecord over RPC; `index`
 * matches the `#<index>` placeholder keys inside the record's messages. */
export interface TraceImage {
  index: number
  bytes: Uint8Array
  mimeType: string
}

export type FeedbackAction = 'accepted' | 'edited' | 'rejected' | 'retried'

export interface FeedbackRecord {
  responseId: string
  userId: string
  action: FeedbackAction
  finalValue?: unknown
}

/** Structural view of ai-api's AiRPC WorkerEntrypoint, as seen through a
 * `Service<...>` binding. Kept here so consumer apps don't need a type
 * dependency on ai-api itself. */
export interface AiTracesRpc {
  recordTrace(record: TraceRecord, images?: TraceImage[]): Promise<void>
  recordFeedback(fb: FeedbackRecord): Promise<{ ok: boolean }>
}
