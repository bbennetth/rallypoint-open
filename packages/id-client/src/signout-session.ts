// signoutSession — single-logout back-channel. Calls
// POST /api/v1/sdk/signout on the RPID API with the supplied session
// bearer in the Authorization header, ending the upstream RPID
// session. Consumer apps (events/lists/money) call this from their
// own signout handler so that signing out of one app tears down the
// RPID session; sibling apps then revoke on their next per-request
// verify (Rallypoint #93).
//
// The RPID endpoint is idempotent and always answers 200 for a
// well-formed request, so any non-200 / thrown fetch is reported as a
// transport_error and the caller decides whether to ignore it
// (signout is best-effort — a local signout must still succeed even
// if RPID is briefly unreachable).

export interface SignoutSessionOptions {
  apiBase: string // e.g. https://id.rallypt.app
  fetchImpl?: typeof fetch
}

export interface SignoutSessionResult {
  ok: boolean
  reason?: 'transport_error'
}

export async function signoutSession(
  bearer: string,
  opts: SignoutSessionOptions,
): Promise<SignoutSessionResult> {
  if (!bearer) return { ok: false, reason: 'transport_error' }
  const apiBase = opts.apiBase.replace(/\/+$/, '')
  const fetchImpl = opts.fetchImpl ?? fetch
  try {
    const res = await fetchImpl(`${apiBase}/api/v1/sdk/signout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}` },
    })
    if (res.status === 200) return { ok: true }
    return { ok: false, reason: 'transport_error' }
  } catch {
    return { ok: false, reason: 'transport_error' }
  }
}
