import { createBindingObjectStore } from '@rallypoint/object-store'
import type { R2Bucket } from '@cloudflare/workers-types'
import type { Env } from '../env.js'
import { createLogMailer } from './mailer/log.js'
import { createResendMailer } from './mailer/resend.js'
import {
  createAlwaysAllowVerifier,
  createAlwaysDenyVerifier,
  createTurnstileVerifier,
} from './captcha.js'
import {
  createAlwaysBreachedCheck,
  createHibpCheck,
  createStubBreachedCheck,
} from './breached-password.js'
import type { Services } from './types.js'

// Build the bag of external-service adapters based on env. Each
// branch lines up with one of the documented impls in
// docs/design/adapter-interfaces.md.

export function buildServices(env: Env, bindings: { objectStore: R2Bucket }): Services {
  const mailer = (() => {
    switch (env.MAILER) {
      case 'resend':
        if (!env.RESEND_API_KEY) {
          throw new Error('MAILER=resend requires RESEND_API_KEY')
        }
        return createResendMailer({ apiKey: env.RESEND_API_KEY, from: env.SMTP_FROM })
      case 'log':
        return createLogMailer()
    }
  })()

  const captcha = (() => {
    switch (env.CAPTCHA) {
      case 'turnstile':
        // expectedHostname derived from UI_ORIGIN (#32). The
        // Turnstile widget is rendered on the hosted UI, so the
        // response.hostname Cloudflare returns must match the
        // UI's hostname (not the API's).
        return createTurnstileVerifier({
          secret: env.TURNSTILE_SECRET,
          expectedHostname: safeHostname(env.UI_ORIGIN),
        })
      case 'allow':
        return createAlwaysAllowVerifier()
      case 'deny':
        return createAlwaysDenyVerifier()
    }
  })()

  const breachedPassword = (() => {
    switch (env.BREACHED_PASSWORD_CHECK) {
      case 'hibp':
        return createHibpCheck()
      case 'stub':
        return createStubBreachedCheck()
      case 'always-breached':
        return createAlwaysBreachedCheck()
    }
  })()

  // Native R2 binding (env.OBJECT_STORE) — ambient creds, private
  // bucket, bytes stream through the Worker (#409).
  const objectStore = createBindingObjectStore(bindings.objectStore)

  return { mailer, captcha, breachedPassword, objectStore }
}

// Extract the hostname portion of a UI_ORIGIN URL (e.g.
// "https://id.rallypt.app" -> "id.rallypt.app"). Returns
// undefined on parse failure so the Turnstile verifier falls
// back to no-hostname-check rather than blocking all captchas.
function safeHostname(origin: string): string | undefined {
  try {
    return new URL(origin).hostname
  } catch {
    return undefined
  }
}

export type { Services } from './types.js'
