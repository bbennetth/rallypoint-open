import type { UserId } from './types.js'

// Server-to-server generic user-settings access. The calling app
// authenticates with its registered RPID app API key and names the
// subject user via the `x-actor` header (the BFF sets it from its
// verified session). RPID enforces the namespace access rule: an app
// may only touch its own namespace (=== its client id) or the shared
// cross-app namespace ('shared'), where cross-app prefs like theme live.
//
// The settings document is opaque JSON — RPID does no per-key
// validation, so app builders add/remove their own front-end settings
// with zero SDK or schema changes. `patchSettings` is a shallow
// top-level merge; a key sent as `null` deletes it.
//
//   const doc = await getSettings({
//     baseUrl: process.env.RPID_API_URL!,
//     apiKey: process.env.EVENTS_API_KEY!,
//     userId: 'user_01H…',
//     namespace: 'shared',
//   })

export type AppSettings = Record<string, unknown>

export interface GetSettingsOptions {
  baseUrl: string
  apiKey: string
  userId: UserId
  namespace: string
  // Optional fetch override for testing / runtime injection.
  fetch?: typeof globalThis.fetch
  // Optional AbortSignal to cancel the in-flight request.
  signal?: AbortSignal
}

export interface PatchSettingsOptions extends GetSettingsOptions {
  patch: AppSettings
}

export class SettingsError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'SettingsError'
    this.status = status
    this.code = code
  }
}

interface SettingsResponse {
  settings: AppSettings
}

/**
 * Read a user's settings document for `namespace` (returns `{}` when absent).
 *
 * Namespace access rule — enforced server-side (a forbidden namespace 403s),
 * NOT validated by this SDK: the calling app may only access its OWN
 * namespace (=== its registered RPID client id) or the shared cross-app
 * namespace (`'shared'`, where cross-app prefs like theme live).
 */
export async function getSettings(opts: GetSettingsOptions): Promise<AppSettings> {
  const json = await request(opts, 'GET')
  return json.settings ?? {}
}

/**
 * Shallow top-level merge into a user's settings document for `namespace`;
 * a key sent as `null` deletes it. Returns the merged document.
 *
 * Same namespace access rule as {@link getSettings}: own-client-id or
 * `'shared'` only, enforced server-side (403 otherwise) — this SDK passes
 * the namespace through without checking it.
 */
export async function patchSettings(opts: PatchSettingsOptions): Promise<AppSettings> {
  const json = await request(opts, 'PATCH', opts.patch)
  return json.settings ?? {}
}

async function request(
  opts: GetSettingsOptions,
  method: 'GET' | 'PATCH',
  body?: AppSettings,
): Promise<SettingsResponse> {
  const base = opts.baseUrl.replace(/\/$/, '')
  const fetchFn = opts.fetch ?? globalThis.fetch
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.apiKey}`,
    'x-actor': opts.userId,
  }
  const init: RequestInit = { method, headers }
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  if (opts.signal) init.signal = opts.signal
  const url = `${base}/api/v1/sdk/settings/${encodeURIComponent(opts.namespace)}`
  const res = await fetchFn(url, init)
  const text = await res.text()
  const json: unknown = text ? JSON.parse(text) : {}
  if (!res.ok) {
    const env = (json as { error?: { code?: string; message?: string } }).error
    throw new SettingsError(
      res.status,
      env?.code ?? 'unknown_error',
      env?.message ?? `Settings request failed with status ${res.status}.`,
    )
  }
  return json as SettingsResponse
}
