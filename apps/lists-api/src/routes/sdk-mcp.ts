import { Hono } from 'hono'
import { z } from 'zod'
import { hashToken } from '@rallypoint/crypto'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { readJsonBody } from './_body.js'

// Internal SDK endpoint the Lists MCP Worker calls to exchange a user's
// personal access token for their actor id (RPL v1.0.0 slice 11). Gated by
// the SDK key gate (PLANNER_API_KEY / MCP_API_KEY) like the rest of
// /api/v1/sdk/*, so only trusted peer Workers can reach it. The MCP Worker
// then makes the user's SDK calls with that key + `x-actor: <userId>`.

const ResolveSchema = z.object({
  token: z.string().min(1, 'token is required.').max(256),
})

export const sdkMcpRoutes = new Hono<HonoApp>()
  .post('/api/v1/sdk/mcp/resolve-token', async (c) => {
    const parsed = ResolveSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })

    const row = await c.var.repos.mcpTokens.findByHash(hashToken(parsed.data.token))
    // Uniform 401 for unknown / revoked / expired so a caller can't probe
    // which tokens exist.
    if (!row || row.revokedAt !== null) throw errors.unauthorized('Invalid MCP token.')
    if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
      throw errors.unauthorized('Invalid MCP token.')
    }

    // Debounce last_used_at: the MCP Worker resolves once per request, so a
    // busy session would otherwise write on every tool call. Only stamp when
    // it's null or more than 5 minutes stale — enough for a useful "last
    // used" without a write per request.
    const now = new Date()
    const STALE_MS = 5 * 60 * 1000
    if (row.lastUsedAt === null || now.getTime() - row.lastUsedAt.getTime() > STALE_MS) {
      await c.var.repos.mcpTokens.touchLastUsed(row.id, now)
    }
    return c.json({ userId: row.userId, tokenId: row.id })
  })
