// Bound a cross-Worker RPC await so a hung upstream (id-api on a slow D1 /
// cold start) can't wedge the caller indefinitely. The session middleware and
// SSO handlers gate live requests on service-binding RPCs; a rejection they
// already handle, but a *hang* has no timeout of its own — this supplies one.
//
// Workers-safe: workerd provides setTimeout/clearTimeout; the timer is always
// cleared in `finally` so a fast-resolving RPC never leaves a pending timer
// holding the isolate awake.

/** Default bound for a single cross-Worker RPC await. */
export const DEFAULT_RPC_TIMEOUT_MS = 5_000

/** Rejection raised by {@link withTimeout} when the wrapped promise outruns `ms`. */
export class RpcTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`)
    this.name = 'RpcTimeoutError'
  }
}

/**
 * Resolve/reject with `promise` if it settles within `ms`; otherwise reject
 * with an {@link RpcTimeoutError}. `label` names the call for the message.
 * The original promise keeps running after a timeout (nothing cancels an RPC),
 * but the caller is unblocked and takes its existing failure path.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RpcTimeoutError(label, ms)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
