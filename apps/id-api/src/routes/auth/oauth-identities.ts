import { Hono } from 'hono'
import type { Context } from 'hono'
import { TENANT_DEFAULT, type UserId } from '@rallypoint/shared'
import type { HonoApp } from '../../context.js'
import { requireSession } from '../../middleware/session.js'
import { ApiError } from '../../errors.js'
import { dailySalt, hashIp, hashUserAgent } from '../../crypto/ip-hash.js'
import { extractIpFromContext as extractIp } from '../../http/extract-ip.js'
import type { OAuthProviderSlug } from '../../repos/oauth-identity.js'

// JSON management surface for social sign-in under /api/v1/ui/oauth/* —
// session + CSRF protected (unlike the browser-redirect /api/v1/oauth/*).
//   GET  /providers   — enabled provider slugs (the signin page reads this)
//   GET  /identities  — the caller's linked accounts
//   DELETE /identities/:id — unlink (lockout-guarded)

export interface LinkedIdentity {
  id: string
  provider: OAuthProviderSlug
  email: string | null
  createdAt: string
  lastUsedAt: string | null
}

export const oauthIdentityRoutes = new Hono<HonoApp>()
  .get('/api/v1/ui/oauth/providers', (c) => {
    return c.json({ providers: [...c.var.oauthProviders.keys()] })
  })
  .get('/api/v1/ui/oauth/identities', requireSession('cookie'), async (c) => {
    const rows = await c.var.repos.oauthIdentities.listByUser(c.var.session!.userId)
    const identities: LinkedIdentity[] = rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      email: r.email,
      createdAt: r.createdAt.toISOString(),
      lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    }))
    return c.json({ identities })
  })
  .delete('/api/v1/ui/oauth/identities/:id', requireSession('cookie'), async (c) => {
    const userId = c.var.session!.userId
    const result = await c.var.repos.userAuth.deleteOAuthIdentityGuarded({
      userId,
      identityId: c.req.param('id'),
    })
    if (result === 'not_found') {
      throw new ApiError({ code: 'not_found', message: 'Linked account not found.', status: 404 })
    }
    if (result === 'last_method') {
      throw new ApiError({
        code: 'oauth_last_method',
        message: 'This is your only sign-in method. Add another before unlinking it.',
        status: 400,
      })
    }
    writeUnlinkAudit(c, userId)
    return c.json({ ok: true })
  })

function writeUnlinkAudit(c: Context<HonoApp>, userId: UserId): void {
  const now = new Date()
  const salt = dailySalt(c.var.env.ARGON2_PEPPER, now)
  void c.var.repos.audit
    .write({
      tenantId: TENANT_DEFAULT,
      eventType: 'oauth.identity.unlinked',
      userId,
      ipHash: hashIp(extractIp(c), salt),
      uaHash: hashUserAgent(c.req.header('user-agent') ?? ''),
      meta: {},
    })
    .catch((err: unknown) => {
      c.var.logger?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'oauth unlink audit failed',
      )
    })
}
