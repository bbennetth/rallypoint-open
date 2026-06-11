import { Hono } from 'hono'
import type { HonoApp } from '../context.js'
import { requireSession } from '../middleware/session.js'

// App launcher for RPID Web v2 (#189). Lists every SSO client whose
// host is configured on this deployment so id-web can render a launch
// grid. There is no per-user entitlements model yet — any authed user
// can SSO into any configured app, so the list is purely env-driven
// (matches today's real access; a user_app_grants model is deferred).

export interface LauncherApp {
  client: string
  name: string
  url: string
}

// Static client → display-name registry. Mirrors the CLIENT_ALLOWLIST
// in sso.ts; a client missing here is simply not surfaced.
// `path` is the RequireSession-gated home route for each app-web (e.g. apps/events-web/src/App.tsx);
// keep in sync with the app routers if those routes change.
const APP_REGISTRY: ReadonlyArray<{ client: string; name: string; path: string }> = [
  { client: 'events', name: 'Events', path: '/me/events' },
  { client: 'lists', name: 'Lists', path: '/me/lists' },
  { client: 'money', name: 'Money', path: '/me/ledgers' },
  { client: 'planner', name: 'Planner', path: '/me' },
]

// Derive the launch origin from a bare host (no protocol in env).
// localhost (any port) is dev over http; everything else is https.
// An explicit SSO_<APP>_URL override env can be added later if a host
// ever needs a scheme this can't derive.
export function launchUrlFromHost(host: string): string {
  const isLocal = host === 'localhost' || host.startsWith('localhost:')
  return `${isLocal ? 'http' : 'https'}://${host}`
}

function hostForClient(
  client: string,
  env: HonoApp['Variables']['env'],
): string | null {
  if (client === 'events') return env.SSO_EVENTS_HOST ?? null
  if (client === 'lists') return env.SSO_LISTS_HOST ?? null
  if (client === 'money') return env.SSO_MONEY_HOST ?? null
  if (client === 'planner') return env.SSO_PLANNER_HOST ?? null
  return null
}

// Build the launcher list from the configured SSO hosts. Clients with
// no configured host are omitted (a deploy without SSO_MONEY_HOST just
// doesn't show Money).
export function buildLauncherApps(
  env: HonoApp['Variables']['env'],
): LauncherApp[] {
  const apps: LauncherApp[] = []
  for (const entry of APP_REGISTRY) {
    const host = hostForClient(entry.client, env)
    if (!host) continue
    apps.push({ client: entry.client, name: entry.name, url: launchUrlFromHost(host) + entry.path })
  }
  return apps
}

export const appsRoutes = new Hono<HonoApp>().get(
  '/api/v1/ui/apps',
  requireSession('cookie'),
  (c) => {
    return c.json({ apps: buildLauncherApps(c.var.env) })
  },
)
