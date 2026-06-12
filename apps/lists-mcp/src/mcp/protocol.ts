import type { ListsClient } from '@rallypoint/lists-client'
import tools, { toolsByName } from './tools.js'

// Pure, framework-free JSON-RPC 2.0 / MCP Streamable HTTP protocol handler.
// No Hono, no HTTP — only message dispatch. Fully injectable for unit tests.

export interface MsgCtx {
  actor: string
  lists: ListsClient
}

export interface JsonRpcRequest {
  jsonrpc?: string
  method?: string
  params?: unknown
  id?: string | number | null
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
  id: string | number | null
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', result, id }
}

function err(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', error: { code, message, ...(data !== undefined ? { data } : {}) }, id }
}

// Returns null for notifications (no `id` field — caller returns HTTP 202).
export async function handleMcpMessage(
  msg: unknown,
  ctx: MsgCtx,
): Promise<JsonRpcResponse | null> {
  // Basic shape validation — must be an object with a string `method`.
  if (
    typeof msg !== 'object' ||
    msg === null ||
    typeof (msg as JsonRpcRequest).method !== 'string'
  ) {
    return err(null, -32600, 'Invalid Request')
  }

  const { method, params, id = null } = msg as JsonRpcRequest

  // Notifications have no `id` — we do not respond to them.
  const isNotification = !('id' in (msg as object))

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'rallypoint-lists', version: '1.0.0' },
      })

    case 'ping':
      return ok(id, {})

    case 'notifications/initialized':
      // Per MCP spec this is a notification (no id); return null so the
      // caller responds HTTP 202. Guard covers both notification + request form.
      return null

    case 'tools/list':
      return ok(id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      })

    case 'tools/call': {
      const p = params as { name?: string; arguments?: unknown } | undefined
      const toolName = p?.name
      if (typeof toolName !== 'string') {
        return ok(id, { content: [{ type: 'text', text: 'Missing tool name' }], isError: true })
      }

      const tool = toolsByName.get(toolName)
      if (!tool) {
        return ok(id, {
          content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
          isError: true,
        })
      }

      // Runtime argument validation.
      const parsed = tool.zodSchema.safeParse(p?.arguments ?? {})
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')
        return ok(id, {
          content: [{ type: 'text', text: `Invalid arguments: ${detail}` }],
          isError: true,
        })
      }

      try {
        const result = await tool.run(parsed.data, ctx)
        return ok(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        })
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e)
        return ok(id, { content: [{ type: 'text', text: message }], isError: true })
      }
    }

    default:
      // Notifications that fall through the explicit cases above.
      if (isNotification) return null
      return err(id, -32601, 'Method not found')
  }
}
