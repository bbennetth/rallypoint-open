import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { SHARED_SETTINGS_NAMESPACE } from '@rallypoint/shared'
import { SettingsError } from '@rallypoint/id-client'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { readJsonBody } from './_body.js'

// Session-gated passthrough to RPID's generic user-settings store. The
// subject is always the verified session user (never client-supplied),
// and the namespace is restricted to this app's own client ('money')
// or the shared cross-app bag — RPID enforces the same rule against the
// API key, this is defense-in-depth + a clean local 403.

const MONEY_CLIENT = 'money'

function assertNamespaceAllowed(namespace: string): void {
  if (namespace === SHARED_SETTINGS_NAMESPACE || namespace === MONEY_CLIENT) return
  throw errors.forbidden('Namespace is not accessible from this app.')
}

// Translate an id-client SettingsError into the money error envelope so
// RPID's status/code surface to the web app unchanged.
function mapSettingsError(err: unknown): never {
  if (err instanceof SettingsError) {
    const status = (err.status >= 400 && err.status <= 599 ? err.status : 502) as ContentfulStatusCode
    throw new ApiError({ code: err.code, message: err.message, status })
  }
  throw err
}

export const settingsRoutes = new Hono<HonoApp>()
  .get('/api/v1/ui/settings/:namespace', requireSession(), async (c) => {
    const namespace = c.req.param('namespace')
    assertNamespaceAllowed(namespace)
    const userId = c.var.session!.userId
    try {
      const settings = await c.var.services.settings.get(userId, namespace)
      return c.json({ settings })
    } catch (err) {
      mapSettingsError(err)
    }
  })

  .patch('/api/v1/ui/settings/:namespace', requireSession(), async (c) => {
    const namespace = c.req.param('namespace')
    assertNamespaceAllowed(namespace)
    const body = await readJsonBody(c)
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw errors.validation({ reason: 'Settings patch must be a JSON object.' })
    }
    const userId = c.var.session!.userId
    try {
      const settings = await c.var.services.settings.patch(
        userId,
        namespace,
        body as Record<string, unknown>,
      )
      return c.json({ settings })
    } catch (err) {
      mapSettingsError(err)
    }
  })
