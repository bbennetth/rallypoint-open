import type { UserBatchEntry, UserId } from './types.js'

// Server-to-server batch user lookup. The calling app authenticates
// with its registered RPID app API key (EVENTS_API_KEY / LISTS_API_KEY
// / MONEY_API_KEY). The endpoint resolves a list of `user_<ulid>` IDs
// to email + display name + username; missing IDs are silently dropped.
//
//   const entries = await batchLookupUsers({
//     baseUrl: process.env.RPID_API_URL!,
//     apiKey: process.env.EVENTS_API_KEY!,
//     userIds: ['user_01H…', 'user_01H…'],
//   })
//
// Throws a `BatchLookupError` on transport/auth failure. Returns
// `{ users: [] }` when none of the requested ids resolve.

export const BATCH_LOOKUP_MAX = 200

export interface BatchLookupOptions {
  baseUrl: string
  apiKey: string
  userIds: ReadonlyArray<UserId>
  // Optional fetch override for testing / runtime injection.
  fetch?: typeof globalThis.fetch
  // Optional AbortSignal to cancel the in-flight request.
  signal?: AbortSignal
}

export interface BatchLookupResult {
  users: UserBatchEntry[]
}

export class BatchLookupError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'BatchLookupError'
    this.status = status
    this.code = code
  }
}

export async function batchLookupUsers(
  opts: BatchLookupOptions,
): Promise<BatchLookupResult> {
  if (opts.userIds.length === 0) return { users: [] }
  if (opts.userIds.length > BATCH_LOOKUP_MAX) {
    throw new BatchLookupError(
      400,
      'batch_too_large',
      `userIds may not exceed ${BATCH_LOOKUP_MAX} entries per request.`,
    )
  }
  const base = opts.baseUrl.replace(/\/$/, '')
  const fetchFn = opts.fetch ?? globalThis.fetch
  const init: RequestInit = {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ user_ids: opts.userIds }),
  }
  if (opts.signal) init.signal = opts.signal
  const res = await fetchFn(`${base}/api/v1/sdk/users/batch-lookup`, init)
  const text = await res.text()
  const json: unknown = text ? JSON.parse(text) : {}
  if (!res.ok) {
    const env = (json as { error?: { code?: string; message?: string } }).error
    throw new BatchLookupError(
      res.status,
      env?.code ?? 'unknown_error',
      env?.message ?? `Batch lookup failed with status ${res.status}.`,
    )
  }
  return json as BatchLookupResult
}
