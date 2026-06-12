import type { ExecutionContext, Fetcher } from '@cloudflare/workers-types'
import { createListsClient } from '@rallypoint/lists-client'
import { buildApp } from './build-app.js'
import { parseEnv, type Env } from './env.js'

// Cloudflare Worker entrypoint for lists-mcp — remote MCP server speaking
// Streamable HTTP (JSON-RPC 2.0 over POST).
//
// Bindings (per-request in `env`):
//   - LISTS (optional) — service binding to rallypoint-lists-<env>; absent
//                        in local `wrangler dev`, present in deployed envs.
//   - LISTS_API_URL, LISTS_MCP_API_KEY, NODE_ENV — string vars/secrets.
//
// This Worker has NO D1, NO assets, NO cron, NO Durable Object.

interface WorkerEnv {
  LISTS?: Fetcher
  [key: string]: unknown
}

interface Deps {
  env: Env
  app: ReturnType<typeof buildApp>
}

let deps: Deps | null = null

function ensureDeps(workerEnv: WorkerEnv): Deps {
  if (deps) return deps

  const vars: Record<string, string> = {}
  for (const [k, v] of Object.entries(workerEnv)) {
    if (typeof v === 'string') vars[k] = v
  }
  const env = parseEnv(vars as NodeJS.ProcessEnv)

  // When a LISTS service binding is present (qa/prod), route SDK calls
  // in-process; absent (local dev) falls back to global fetch.
  const listsFetch = workerEnv.LISTS
    ? (workerEnv.LISTS.fetch.bind(workerEnv.LISTS) as unknown as typeof fetch)
    : undefined
  const listsFetchOpt = listsFetch ? { fetch: listsFetch } : {}

  const listsClient = createListsClient({
    baseUrl: env.LISTS_API_URL,
    apiKey: env.LISTS_MCP_API_KEY,
    ...listsFetchOpt,
  })

  // resolveToken POSTs to lists-api's MCP token endpoint, using the same
  // service binding (or global fetch in dev) and LISTS_MCP_API_KEY as bearer.
  const resolveToken = async (token: string): Promise<{ userId: string; tokenId: string } | null> => {
    const doFetch = listsFetch ?? globalThis.fetch
    const res = await doFetch(`${env.LISTS_API_URL}/api/v1/sdk/mcp/resolve-token`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.LISTS_MCP_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token }),
    })
    if (res.status === 401) return null
    if (!res.ok) return null
    const data = (await res.json()) as { userId: string; tokenId: string }
    return data
  }

  const app = buildApp({ env, resolveToken, listsClient })
  deps = { env, app }
  return deps
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const d = ensureDeps(env)
    return d.app.fetch(request, env, ctx)
  },
}
