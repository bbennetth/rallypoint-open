import { Hono } from 'hono'
import { ulid } from 'ulid'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { CreateMcpTokenSchema } from '@rallypoint/lists-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { McpTokenRecord } from '../repos/types.js'
import { readJsonBody } from './_body.js'

// Personal-access-token management for the Lists MCP server (RPL v1.0.0
// slice 11). Mounted under /api/v1/ui/mcp-tokens, session-gated — a user
// manages only their own tokens. The raw token (`rplmcp_…`) is returned
// exactly once at creation and never stored (only its sha256). The MCP
// Worker presents the raw token; lists-api resolves it via the SDK
// `resolve-token` route (sdk-mcp.ts).

const TENANT = 'rallypoint'
const MCP_TOKEN_PREFIX = 'rplmcp_'

// The token row WITHOUT the secret — what listing/creation responses
// expose (the raw token is added separately, once, on create).
function serializeToken(t: McpTokenRecord): Record<string, unknown> {
  return {
    id: t.id,
    label: t.label,
    created_at: t.createdAt.toISOString(),
    last_used_at: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
    expires_at: t.expiresAt ? t.expiresAt.toISOString() : null,
    revoked_at: t.revokedAt ? t.revokedAt.toISOString() : null,
  }
}

export const mcpTokensRoutes = new Hono<HonoApp>()
  // --- list the caller's tokens (no secret) ------------------------
  .get('/api/v1/ui/mcp-tokens', async (c) => {
    const userId = c.var.session!.userId
    const tokens = await c.var.repos.mcpTokens.listForUser(userId)
    return c.json({ items: tokens.map(serializeToken) })
  })

  // --- mint a token (secret returned ONCE) -------------------------
  .post('/api/v1/ui/mcp-tokens', async (c) => {
    const userId = c.var.session!.userId
    const parsed = CreateMcpTokenSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    const rawToken = generateRawToken(MCP_TOKEN_PREFIX)
    const expiresAt =
      body.expiresInDays !== undefined
        ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
        : null

    const token = await c.var.repos.mcpTokens.create({
      id: `mtk_${ulid()}`,
      tenantId: TENANT,
      idHash: hashToken(rawToken),
      userId,
      label: body.label,
      expiresAt,
    })
    // `token` is the only time the raw secret is ever returned.
    return c.json({ ...serializeToken(token), token: rawToken }, 201)
  })

  // --- revoke a token ----------------------------------------------
  .delete('/api/v1/ui/mcp-tokens/:tokenId', async (c) => {
    const userId = c.var.session!.userId
    const revoked = await c.var.repos.mcpTokens.revoke(
      c.req.param('tokenId'),
      userId,
      new Date(),
    )
    // 404 whether the token is missing, already revoked, or another user's
    // (no existence leak across users).
    if (!revoked) throw errors.notFound('Token not found.')
    return c.body(null, 204)
  })
