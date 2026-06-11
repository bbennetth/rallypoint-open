import { createSession } from '@rallypoint/web-kit'
import { getSession } from './api.js'

// Planner-side session instance. The cross-subdomain SSO bootstrap +
// session-probe logic now lives in @rallypoint/web-kit's createSession;
// this module binds it with the planner-specific config (client name,
// SSO state cookie name, RPID origin) and re-exports the bound helpers
// so existing call sites keep importing from here.

// RPID's hosted UI origin. Exported so the user bar's "Account" item can
// deep-link to id-web's hosted account page.
export const RPID_UI_URL =
  (import.meta.env.VITE_RPID_UI_URL as string | undefined) ?? 'http://localhost:5173'

// Mirror planner-api's PLANNER_SSO_STATE_COOKIE_NAME derivation.
export const SSO_STATE_COOKIE = import.meta.env.PROD
  ? '__Host-rpp_sso_state'
  : 'rpp_sso_state'

export const session = createSession({
  clientName: 'planner',
  stateCookieName: SSO_STATE_COOKIE,
  rpidUiUrl: RPID_UI_URL,
  secureCookie: import.meta.env.PROD,
  getSession,
})

export type { SessionState } from '@rallypoint/web-kit'
export const { useSession, beginSso, readStateCookie, clearStateCookie } = session
