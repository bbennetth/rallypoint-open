/// <reference types="@cloudflare/workers-types" />
import type { ExecutionContext, Service } from '@cloudflare/workers-types'
import type { ListsRPC } from '@rallypoint/lists-api'
import { createListsClientFromBinding } from '@rallypoint/lists-rpc-client'
import { buildApp } from './build-app.js'
import { parseEnv, type Env } from './env.js'

// Cloudflare Worker entrypoint for lists-mcp — remote MCP server speaking
// Streamable HTTP (JSON-RPC 2.0 over POST).
//
// PR 2 of feat/rpc-bindings: LISTS is now typed as `Service<ListsRPC>`;
// the SDK HTTP path + LISTS_MCP_API_KEY are gone. resolveToken calls
// `binding.resolveMcpToken(token)` directly. PR 3 deletes the env var.

interface WorkerEnv {
  LISTS?: Service<ListsRPC>
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

  const lazyBinding = <T>(name: string, value: T | undefined): T => {
    if (value !== undefined) return value
    const proxy = new Proxy({} as object, {
      get(_target, prop) {
        return () => {
          throw new Error(
            `lists-mcp ensureDeps(): cross-Worker binding "${name}" is undefined ` +
              `but was just called as .${String(prop)}(). Make sure rallypoint-lists is running ` +
              `(scripts/dev.sh boots all five) so wrangler's dev registry connects them.`,
          )
        }
      },
    })
    return proxy as T
  }
  const lists = lazyBinding('LISTS', workerEnv.LISTS)

  const listsClient = createListsClientFromBinding(lists)

  const resolveToken = async (token: string): Promise<{ userId: string; tokenId: string } | null> => {
    const result = (await lists.resolveMcpToken(token)) as Awaited<
      ReturnType<ListsRPC['resolveMcpToken']>
    >
    if (result.kind !== 'ok') return null
    return result.data
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
