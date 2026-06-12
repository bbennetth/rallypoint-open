import { Hono } from 'hono'
import type { ListsClient } from '@rallypoint/lists-client'
import type { Env } from './env.js'
import { handleMcpMessage } from './mcp/protocol.js'

export interface BuildAppDeps {
  env: Env
  // Resolves a user's MCP personal access token (rplmcp_…) to their userId.
  // Returns null when the token is missing or invalid.
  resolveToken(token: string): Promise<{ userId: string; tokenId: string } | null>
  // Pre-built lists client (shared across requests in the same isolate).
  listsClient: ListsClient
}

export function buildApp(deps: BuildAppDeps): Hono {
  const { resolveToken, listsClient } = deps
  const app = new Hono()

  // Health — unauthenticated, used by uptime monitors.
  app.get('/health', (c) => c.json({ status: 'ok' }))

  // MCP Streamable HTTP endpoint. Both / and /mcp are accepted so clients
  // can use the canonical /<path> form or the root form.
  async function mcpHandler(c: { req: { raw: Request }; json: (v: unknown, s?: number) => Response; text: (v: string, s?: number) => Response; body: (v: null, s?: number) => Response }): Promise<Response> {
    // Auth: extract bearer token.
    const authHeader = c.req.raw.headers.get('authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    if (!token) {
      return c.json({ error: 'Missing Authorization header' }, 401)
    }

    let identity: { userId: string; tokenId: string } | null
    try {
      identity = await resolveToken(token)
    } catch {
      // lists-api unreachable / malformed response — an infra problem, not an
      // auth decision. Surface 503 so the client retries rather than treating
      // it as a bad token.
      return c.json({ error: 'Auth service unavailable' }, 503)
    }
    if (!identity) {
      return c.json({ error: 'Invalid or expired MCP token' }, 401)
    }

    // Parse JSON-RPC body.
    let body: unknown
    try {
      body = await c.req.raw.json()
    } catch {
      return c.json(
        { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
        400,
      )
    }

    // Batch requests are not supported in v1; return a clear error.
    if (Array.isArray(body)) {
      return c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Batch requests are not supported in v1' },
          id: null,
        },
        400,
      )
    }

    const ctx = { actor: identity.userId, lists: listsClient }
    const response = await handleMcpMessage(body, ctx)

    // Notifications (no `id`) return HTTP 202 with empty body.
    if (response === null) {
      return new Response(null, { status: 202 })
    }

    return Response.json(response)
  }

  // Register on both paths; cast to avoid Hono's strict context typing
  // (we don't use Hono's typed context here, only the raw Request).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post('/', mcpHandler as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post('/mcp', mcpHandler as any)

  return app
}
