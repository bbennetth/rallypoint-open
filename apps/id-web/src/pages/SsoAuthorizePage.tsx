import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AuthCard } from '../ui/AuthCard.js'
import { Banner } from '@rallypoint/ui'
import { buildLoginRequiredUrl, clearStaleSsoHint, isTrustedReturnTo } from '../lib/sso-authorize.js'

// SSO authorize page — slice 2a (Rallypoint Events #87).
//
// Route: GET /sso/authorize?client=<name>&return_to=<absolute-url>&state=<nonce>
//
// Flow:
//   1. Validate query params (all present; return_to parses as URL).
//   2. Check session via GET /api/v1/ui/session (credentials: include).
//      401 → redirect to /signin?returnTo=<current-url>.
//   3. Bootstrap CSRF via the api client's built-in /api/v1/ui/csrf call,
//      then POST /api/v1/ui/sso/code with {client, return_to_host}.
//   4. On success → window.location.replace(<return_to>?code=<raw>&state=<state>).
//   5. On error → show error code + message.
//
// The page does NOT validate client or return_to's host against an
// allowlist — that's the server's job at mint time. id-web stays dumb.

type Phase =
  | { kind: 'checking-params' }
  | { kind: 'params-error'; message: string }
  | { kind: 'checking-session' }
  | { kind: 'minting' }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'redirecting' }

interface ValidParams {
  client: string
  returnTo: string
  returnToHost: string
  state: string
  prompt: string | null
}

function parseParams(
  params: URLSearchParams,
): { ok: true; data: ValidParams } | { ok: false; message: string } {
  const client = params.get('client')
  const returnTo = params.get('return_to')
  const state = params.get('state')
  const prompt = params.get('prompt')

  if (!client || !returnTo || !state) {
    return { ok: false, message: 'Missing parameters.' }
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(returnTo)
  } catch {
    return { ok: false, message: 'Invalid return_to.' }
  }

  return {
    ok: true,
    data: {
      client,
      returnTo,
      returnToHost: parsedUrl.host,
      state,
      prompt,
    },
  }
}

// Build the final redirect URL, appending code + state to whatever
// query params return_to already carries.
function buildRedirectUrl(returnTo: string, code: string, state: string): string {
  const url = new URL(returnTo)
  url.searchParams.set('code', code)
  url.searchParams.set('state', state)
  return url.toString()
}

export function SsoAuthorizePage() {
  const [searchParams] = useSearchParams()
  const [phase, setPhase] = useState<Phase>({ kind: 'checking-params' })

  // currentUrl for signin redirect (capture once on mount).
  const currentUrl = window.location.href

  useEffect(() => {
    let cancelled = false

    async function run() {
      // Step 1: validate params.
      const parsed = parseParams(searchParams)
      if (!parsed.ok) {
        setPhase({ kind: 'params-error', message: parsed.message })
        return
      }
      const { client, returnTo, returnToHost, state, prompt } = parsed.data

      // Step 2: check session.
      setPhase({ kind: 'checking-session' })
      let sessionRes: Response
      try {
        sessionRes = await fetch('/api/v1/ui/session', {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        })
      } catch {
        if (!cancelled)
          setPhase({ kind: 'error', code: 'network_error', message: 'Network error.' })
        return
      }

      if (sessionRes.status === 401) {
        if (prompt === 'none' && isTrustedReturnTo(returnTo, window.location.hostname)) {
          // Silent probe (prompt=none) — no session means we must NOT drop
          // the user on /signin. Instead redirect back to the app with
          // error=login_required so it can fall back to its landing page.
          // Guarded by isTrustedReturnTo: this bypasses the server-side mint
          // (where return_to_host is normally validated), so an untrusted
          // return_to falls through to the safe /signin redirect below
          // rather than turning RPID into an open redirector.
          // Also clear any stale hint cookie that falsely advertised a
          // live session (it has expired server-side).
          clearStaleSsoHint(window.location.hostname, window.location.protocol === 'https:')
          window.location.replace(buildLoginRequiredUrl(returnTo, state))
          return
        }
        // Not signed in — redirect to signin pointing back here. The
        // param MUST be `returnTo`: that's the key SigninPage (and the
        // rest of id-web) reads; `next` is silently dropped, stranding
        // the user on the RPID home instead of resuming the SSO flow.
        const encodedCurrentUrl = encodeURIComponent(currentUrl)
        window.location.replace(`/signin?returnTo=${encodedCurrentUrl}`)
        return
      }

      if (!sessionRes.ok) {
        if (!cancelled)
          setPhase({
            kind: 'error',
            code: 'session_check_failed',
            message: 'Could not verify your session.',
          })
        return
      }

      // Step 3: bootstrap CSRF. If this fails, surface an explicit
      // error rather than letting the server reject the subsequent
      // mint with a 403 — that path produces a useless "forbidden"
      // message that doesn't tell the user to reload.
      let csrfToken: string | null = null
      try {
        const csrfRes = await fetch('/api/v1/ui/csrf', {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        })
        if (!csrfRes.ok) throw new Error(`csrf returned ${csrfRes.status}`)
        const csrfBody = (await csrfRes.json().catch(() => null)) as {
          csrfToken?: string
        } | null
        csrfToken = csrfBody?.csrfToken ?? null
        if (!csrfToken) throw new Error('csrf body missing csrfToken')
      } catch {
        if (!cancelled) {
          setPhase({
            kind: 'error',
            code: 'csrf_fetch_failed',
            message: 'Could not initialize the request. Please reload and try again.',
          })
        }
        return
      }

      if (cancelled) return
      setPhase({ kind: 'minting' })

      // Step 4: mint the SSO code. csrfToken is guaranteed non-null
      // here because step 3 short-circuits on failure.
      const mintHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-RP-CSRF': csrfToken,
      }

      let mintRes: Response
      try {
        mintRes = await fetch('/api/v1/ui/sso/code', {
          method: 'POST',
          credentials: 'include',
          headers: mintHeaders,
          body: JSON.stringify({ client, return_to_host: returnToHost }),
        })
      } catch {
        if (!cancelled)
          setPhase({ kind: 'error', code: 'network_error', message: 'Network error.' })
        return
      }

      if (cancelled) return

      if (!mintRes.ok) {
        const errBody = (await mintRes.json().catch(() => null)) as {
          error?: { code?: string; message?: string }
        } | null
        setPhase({
          kind: 'error',
          code: errBody?.error?.code ?? 'unexpected_error',
          message: errBody?.error?.message ?? `Unexpected error (${mintRes.status}).`,
        })
        return
      }

      const mintBody = (await mintRes.json()) as { code?: string }
      if (!mintBody.code) {
        setPhase({
          kind: 'error',
          code: 'unexpected_error',
          message: 'Server returned an empty code.',
        })
        return
      }

      // Step 5: redirect back to the app.
      setPhase({ kind: 'redirecting' })
      window.location.replace(buildRedirectUrl(returnTo, mintBody.code, state))
    }

    void run()
    return () => {
      cancelled = true
    }
    // searchParams identity is stable for the mount; currentUrl is captured once.
  }, [])

  if (phase.kind === 'params-error') {
    return (
      <AuthCard title="Invalid request" subtitle="The authorization request is malformed.">
        <Banner tone="error">{phase.message}</Banner>
      </AuthCard>
    )
  }

  const clientLabel = searchParams.get('client') ?? 'the app'

  if (phase.kind === 'error') {
    return (
      <AuthCard
        title="Authorization failed"
        subtitle={`Could not connect your Rallypoint ID to ${clientLabel}.`}
      >
        <Banner tone="error">
          <strong>{phase.code}</strong>: {phase.message}
        </Banner>
      </AuthCard>
    )
  }

  // All in-flight phases (checking-params, checking-session, minting, redirecting).
  return (
    <AuthCard
      title="Authorizing…"
      subtitle={`Connecting your Rallypoint ID to ${clientLabel}.`}
    >
      <Banner tone="info">
        {phase.kind === 'redirecting'
          ? 'Redirecting…'
          : `Signing you in to ${clientLabel}…`}
      </Banner>
    </AuthCard>
  )
}
