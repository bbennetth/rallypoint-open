import { createSession } from '@rallypoint/web-kit'
import { getSession } from './api.js'

// Admin-side session instance. The cross-subdomain SSO bootstrap +
// session-probe logic lives in @rallypoint/web-kit's createSession; this
// module binds it with the admin-specific config (client name, SSO state
// cookie name, RPID origin) and re-exports the bound helpers.

// RPID's hosted UI origin. Same-host derivation isn't possible
// cross-subdomain, so it's an explicit build-time env.
export const RPID_UI_URL =
  (import.meta.env.VITE_RPID_UI_URL as string | undefined) ?? 'http://localhost:5173'

// Mirror admin-api's ADMIN_SSO_STATE_COOKIE_NAME derivation.
export const SSO_STATE_COOKIE = import.meta.env.PROD
  ? '__Host-rpa_sso_state'
  : 'rpa_sso_state'

export const session = createSession({
  clientName: 'admin',
  stateCookieName: SSO_STATE_COOKIE,
  rpidUiUrl: RPID_UI_URL,
  secureCookie: import.meta.env.PROD,
  getSession,
})

export type { SessionState } from '@rallypoint/web-kit'
export const { useSession, beginSso, readStateCookie, clearStateCookie } = session
