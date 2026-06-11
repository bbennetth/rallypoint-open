import type { CaptchaVerifier } from './types.js'

// Captcha adapters per docs/design/adapter-interfaces.md.

export function createTurnstileVerifier(opts: {
  secret: string
  fetchImpl?: typeof fetch
  /**
   * If set, the siteverify response's `hostname` must match
   * (#32). Prevents replay of a token captured on another site
   * that shares our Turnstile site key.
   */
  expectedHostname?: string | undefined
}): CaptchaVerifier {
  const fetchImpl = opts.fetchImpl ?? fetch
  return {
    async verify(input: { token: string; ip: string }) {
      const form = new URLSearchParams()
      form.set('secret', opts.secret)
      form.set('response', input.token)
      form.set('remoteip', input.ip)
      const res = await fetchImpl(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        { method: 'POST', body: form },
      )
      const body = (await res.json().catch(() => ({}))) as {
        success?: boolean
        hostname?: string
        ['error-codes']?: string[]
      }
      if (!body.success) {
        return { success: false, reason: body['error-codes']?.join(',') ?? 'unknown' }
      }
      // Hostname check (#32). Cloudflare validates the hostname
      // server-side from where the widget was rendered; we then
      // re-verify it matches our deployment so a token captured
      // on a different origin (sharing our site key) can't be
      // replayed.
      if (opts.expectedHostname && body.hostname !== opts.expectedHostname) {
        return {
          success: false,
          reason: `hostname_mismatch:${body.hostname ?? 'missing'}`,
        }
      }
      return { success: true }
    },
  }
}

let warnedOnce = false
export function createAlwaysAllowVerifier(): CaptchaVerifier {
  return {
    async verify() {
      if (!warnedOnce) {
        console.warn(
          '[captcha] AlwaysAllowVerifier active — captcha is disabled. ' +
            'Do not use in production.',
        )
        warnedOnce = true
      }
      return { success: true }
    },
  }
}

export function createAlwaysDenyVerifier(): CaptchaVerifier {
  return {
    async verify() {
      return { success: false, reason: 'forced_deny' }
    },
  }
}
