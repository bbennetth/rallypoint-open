// Typed money-api client. The CSRF/transport machinery lives in
// @rallypoint/web-kit's createCsrfClient; this module keeps the
// money-specific typed DTO layer on top of it. All calls go through
// the Vite dev proxy (and the production reverse proxy) at
// /api/v1/ui/*, always with credentials:'include' so the session +
// CSRF cookies ride along.

import { ApiError, createCsrfClient, resetAnalytics } from '@rallypoint/web-kit'
import type { SessionProfile } from '@rallypoint/web-kit'
import { hydrateThemeFromServer } from '@rallypoint/ui'
import type { CreateLedgerInput } from '@rallypoint/money-shared'

export type { SessionProfile }

export { ApiError }

const client = createCsrfClient({ basePath: '/api/v1/ui' })
const request = client.request

// Server DTO (snake_case) — mirrors money-api's serializeLedger.
export interface LedgerDto {
  id: string
  scope_type: string
  scope_id: string
  owner_user_id: string
  name: string
  currency: string
  description: string | null
  created_at: string
  updated_at: string
}

export interface LedgerPage {
  items: LedgerDto[]
}

// --- session / SSO --------------------------------------------------

export interface SessionDto {
  user_id: string
  // The shared cross-app settings doc folded in by the BFF. Theme keys
  // (themeMode/themeColor) hydrate the store on load; other keys are
  // opaque to the client.
  settings?: Record<string, unknown>
  // The signed-in user's RPID profile (avatar + name) folded in by the
  // BFF for the user bar; `null`/absent when the fold-in degraded.
  profile?: SessionProfile | null
}

export async function getSession(): Promise<SessionDto> {
  const session = await request<SessionDto>('GET', '/api/v1/ui/session')
  // Side-effect: apply the server's theme before the first authed render
  // so the preference follows the user across devices/apps. Does not echo
  // a write back (hydrateThemeFromServer suppresses the persister).
  if (session.settings) {
    hydrateThemeFromServer({
      mode: session.settings.themeMode,
      color: session.settings.themeColor,
    })
  }
  return session
}

// Persist a shallow patch into a settings namespace (a `null`-valued key
// deletes it). Used by the theme persister (registered in main.tsx) and
// any Settings page. Returns the merged doc.
export async function updateSettings(
  namespace: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await request<{ settings: Record<string, unknown> }>(
    'PATCH',
    `/api/v1/ui/settings/${encodeURIComponent(namespace)}`,
    patch,
  )
  return res.settings
}

export async function exchangeSso(code: string, state: string): Promise<void> {
  await request<void>('POST', '/api/v1/ui/sso/exchange', { code, state })
}

export async function signout(): Promise<void> {
  await request<void>('POST', '/api/v1/ui/signout')
  resetAnalytics()
}

// --- ledgers --------------------------------------------------------

export async function createLedger(input: CreateLedgerInput): Promise<LedgerDto> {
  return request<LedgerDto>('POST', '/api/v1/ui/ledgers', input)
}

export async function listLedgers(): Promise<LedgerPage> {
  return request<LedgerPage>('GET', '/api/v1/ui/ledgers')
}
