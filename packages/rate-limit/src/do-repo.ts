import type {
  RateLimitDecision,
  RateLimitRepo,
  TakeTokenInput,
} from './algorithm.js'

// Durable-Object rate-limit repository (#881) — the client side of
// RateLimitCounter (do.ts). One DO instance per bucket, resolved by
// idFromName(`${tenantId}:${bucketKey}`); takeToken POSTs the bucket's
// limit/window to the DO's /take and gets the RateLimitDecision back.
//
// Structurally typed namespace (not @cloudflare/workers-types) so this
// module — and its Node-typed consumers (each app's repos/d1 construction) —
// need no Workers type dep; a real binding is assignable. Same rationale and
// shape as RealtimeHubNamespace in packages/realtime/src/do-bus.ts.

interface RateLimitCounterStub {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
}

export interface RateLimitCounterNamespace {
  idFromName(name: string): unknown
  get(id: unknown): RateLimitCounterStub
}

export interface CreateDoRateLimitRepoOptions {
  namespace: RateLimitCounterNamespace
}

/**
 * The rate-limit store itself failed (DO unreachable / reset / non-2xx after
 * a retry) — as opposed to the bucket being exhausted. One class identity,
 * exported from this dependency-free package, so the api-kit middleware's
 * transient-store gate can `instanceof` it next to isTransientD1Error and
 * apply the same onStoreError allow/deny policy to the DO backend (the
 * UniqueConstraintError precedent: shared class in one package keeps
 * instanceof reliable across packages).
 */
export class RateLimitStoreUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RateLimitStoreUnavailableError'
  }
}

// Internal hostname for Worker→DO fetches. The DO routes on the path, not
// the host; idFromName already selected the instance.
const BASE_URL = 'https://rate-limit-counter.internal'

// One retry, then give up. A retried /take double-counts at most one token
// (never under-counts) — the same "overcount is fine, undercount is the
// worry" argument the D1 repo makes for its upsert retry.
const ATTEMPTS = 2

export function createDoRateLimitRepo(opts: CreateDoRateLimitRepoOptions): RateLimitRepo {
  const stubFor = (tenantId: string, bucketKey: string): RateLimitCounterStub =>
    opts.namespace.get(opts.namespace.idFromName(`${tenantId}:${bucketKey}`))

  const post = async (
    stub: RateLimitCounterStub,
    path: string,
    body?: unknown,
  ): Promise<Response> => {
    let lastFailure: unknown
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      let res: Response | undefined
      try {
        res = await stub.fetch(`${BASE_URL}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      } catch (err) {
        // Thrown fetch = the DO round-trip itself failed (reset, network) —
        // the transient shape this retry exists for.
        lastFailure = err
        continue
      }
      if (res.ok) return res
      // A 4xx from our own DO is a deterministic bug (e.g. this client
      // building a malformed /take body), not an outage — throw it plain and
      // immediately (no retry, no wrapping) so it surfaces as an error
      // instead of masquerading as "store unavailable" and silently failing
      // the limiter open under an onStoreError:'allow' policy.
      if (res.status < 500) {
        throw new Error(`rate-limit DO ${path} returned ${res.status}`)
      }
      lastFailure = new Error(`rate-limit DO ${path} returned ${res.status}`)
    }
    throw new RateLimitStoreUnavailableError(`rate-limit DO ${path} failed`, {
      cause: lastFailure,
    })
  }

  return {
    async takeToken(input: TakeTokenInput): Promise<RateLimitDecision> {
      const stub = stubFor(input.tenantId, input.bucketKey)
      const res = await post(stub, '/take', {
        limit: input.limit,
        windowSeconds: input.windowSeconds,
        ...(input.now ? { nowMs: input.now.getTime() } : {}),
      })
      return (await res.json()) as RateLimitDecision
    },

    async reset(tenantId: string, bucketKey: string): Promise<void> {
      await post(stubFor(tenantId, bucketKey), '/reset')
    },

    // Buckets self-clean: every write re-arms the DO's deleteAll alarm to
    // 2×window past the last hit, so there is nothing to prune centrally.
    // Kept on the interface so the events/id cron pruners run unchanged
    // (they just log the returned count).
    async pruneOldBuckets(): Promise<number> {
      return 0
    },
  }
}
