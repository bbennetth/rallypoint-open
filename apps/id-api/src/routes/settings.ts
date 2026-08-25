import { Hono } from 'hono'
import type { Context } from 'hono'
import type { HonoApp } from '../context.js'
import { SETTINGS_MAX_BYTES, SHARED_SETTINGS_NAMESPACE } from '@rallypoint/shared'
import { errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'

// id-web cookie-session settings surface (the cross-Worker
// `/api/v1/sdk/settings/:ns` HTTP routes were retired in PR 3 of
// feat/rpc-bindings — consumers now call `IdRPC.getSettings` /
// `IdRPC.patchSettings` through the `Service<IdRPC>` binding).
//
// PATCH is a shallow top-level merge; a key sent as null deletes it.
// GET returns the stored doc, or {} when absent. Theme lives in the
// 'shared' namespace so it follows the user across every Rallypoint app.

// id-web is RPID's own web app — it may touch the cross-app bag and
// RPID's own private namespace.
const ID_WEB_NAMESPACES: readonly string[] = [SHARED_SETTINGS_NAMESPACE, 'id']

export const settingsRoutes = new Hono<HonoApp>()
  .get('/api/v1/ui/settings/:namespace', requireSession('cookie'), async (c) => {
    const namespace = c.req.param('namespace')
    if (!ID_WEB_NAMESPACES.includes(namespace)) {
      throw errors.forbidden('Settings namespace is not available here.')
    }
    const userId = c.var.session!.userId
    const doc = await c.var.repos.settings.get(userId, namespace)
    return c.json({ settings: doc ?? {} })
  })
  .patch('/api/v1/ui/settings/:namespace', requireSession('cookie'), async (c) => {
    const namespace = c.req.param('namespace')
    if (!ID_WEB_NAMESPACES.includes(namespace)) {
      throw errors.forbidden('Settings namespace is not available here.')
    }
    const userId = c.var.session!.userId
    const patch = await readSettingsPatch(c)
    const merged = await c.var.repos.settings.merge(userId, namespace, patch)
    return c.json({ settings: merged })
  })

async function readSettingsPatch(c: Context<HonoApp>): Promise<Record<string, unknown>> {
  const raw = await c.req.text()
  if (Buffer.byteLength(raw, 'utf8') > SETTINGS_MAX_BYTES) {
    throw errors.validation({
      issues: [{ path: ['body'], message: `Settings document may not exceed ${SETTINGS_MAX_BYTES} bytes.` }],
    })
  }
  let parsed: unknown
  try {
    parsed = raw ? JSON.parse(raw) : {}
  } catch {
    throw errors.bodyInvalid()
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw errors.validation({
      issues: [{ path: ['body'], message: 'Settings patch must be a JSON object.' }],
    })
  }
  return parsed as Record<string, unknown>
}
