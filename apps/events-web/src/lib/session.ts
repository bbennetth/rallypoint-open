import { createSession } from '@rallypoint/web-kit'
import { getSession } from './api.js'

// Events-side session instance. The cross-subdomain SSO bootstrap +
// session-probe logic now lives in @rallypoint/web-kit's createSession
// (design §3.13); this module binds it with the events-specific config
// (client name, SSO state cookie name, RPID origin) and re-exports the
// bound helpers so existing call sites keep importing from here.

// RPID's hosted UI origin. Same-host derivation isn't possible
// cross-subdomain, so it's an explicit build-time env.
export const RPID_UI_URL =
  (import.meta.env.VITE_RPID_UI_URL as string | undefined) ?? 'http://localhost:5173'

// Mirror events-api's EVENTS_SSO_STATE_COOKIE_NAME derivation
// (footgun #20: `__Host-` cookies silently drop on http://localhost,
// so dev uses the bare name). Vite sets PROD on production builds.
export const SSO_STATE_COOKIE = import.meta.env.PROD
  ? '__Host-rpe_sso_state'
  : 'rpe_sso_state'

export const session = createSession({
  clientName: 'events',
  stateCookieName: SSO_STATE_COOKIE,
  rpidUiUrl: RPID_UI_URL,
  secureCookie: import.meta.env.PROD,
  getSession,
})

export type { SessionState } from '@rallypoint/web-kit'
export const { useSession, beginSso, readStateCookie, clearStateCookie } = session
