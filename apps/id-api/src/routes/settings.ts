import { Hono } from 'hono'
import type { Context } from 'hono'
import type { HonoApp } from '../context.js'
import type { UserId } from '@rallypoint/shared'
import { SETTINGS_MAX_BYTES, SHARED_SETTINGS_NAMESPACE } from '@rallypoint/shared'
import { errors } from '../errors.js'
import { requireAppApiKey } from '../middleware/app-api-key.js'
import { requireSession } from '../middleware/session.js'
import { canAccessNamespace } from '../lib/settings-access.js'

// Generic per-user settings store. The document is opaque JSON — RPID
// does no per-key validation; the front end owns typing/sanitising.
// Two surfaces over the same store:
//
//   SDK (server-to-server, app-API-key bearer; subject = x-actor):
//     GET   /api/v1/sdk/settings/:namespace
//     PATCH /api/v1/sdk/settings/:namespace
//   UI (id-web only, cookie session; subject = the session user):
//     GET   /api/v1/ui/settings/:namespace
//     PATCH /api/v1/ui/settings/:namespace
//
// PATCH is a shallow top-level merge; a key sent as null deletes it.
// GET returns the stored doc, or {} when absent. Theme lives in the
// 'shared' namespace so it follows the user across every Rallypoint app.

// id-web is RPID's own web app — it has no product app-client id, so it
// may touch the cross-app bag and RPID's own private namespace.
const ID_WEB_NAMESPACES: readonly string[] = [SHARED_SETTINGS_NAMESPACE, 'id']

export const settingsRoutes = new Hono<HonoApp>()
  // ---- SDK namespace (app API key + x-actor subject) -----------------
  .get('/api/v1/sdk/settings/:namespace', requireAppApiKey, async (c) => {
    const namespace = c.req.param('namespace')
    const client = c.var.appApiKeyClient
    if (!client || !canAccessNamespace(client, namespace)) {
      throw errors.forbidden('App may not access this settings namespace.')
    }
    const userId = requireActor(c)
    const doc = await c.var.repos.settings.get(userId, namespace)
    return c.json({ settings: doc ?? {} })
  })
  .patch('/api/v1/sdk/settings/:namespace', requireAppApiKey, async (c) => {
    const namespace = c.req.param('namespace')
    const client = c.var.appApiKeyClient
    if (!client || !canAccessNamespace(client, namespace)) {
      throw errors.forbidden('App may not access this settings namespace.')
    }
    const userId = requireActor(c)
    const patch = await readSettingsPatch(c)
    const merged = await c.var.repos.settings.merge(userId, namespace, patch)
    return c.json({ settings: merged })
  })

  // ---- UI namespace (id-web cookie session) --------------------------
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

// Read the x-actor header (the BFF's verified session user); 400 if
// absent. The app key authorises the *caller*; this header names the
// *subject* whose settings are read/written — same contract as the
// Lists/Events personal SDK routes.
function requireActor(c: Context<HonoApp>): UserId {
  const actor = c.req.header('x-actor')
  if (!actor || actor.trim().length === 0) {
    throw errors.validation({
      issues: [{ path: ['x-actor'], message: 'x-actor header is required.' }],
    })
  }
  return actor.trim() as UserId
}

// Parse + validate a PATCH body: must be a JSON object (not array/null)
// and within the size cap. Returns the raw patch (null-valued keys are
// the delete sentinel, handled by the repo merge).
async function readSettingsPatch(c: Context<HonoApp>): Promise<Record<string, unknown>> {
  // Hono's memoized body reader (not `c.req.raw.text()`) — consistent with
  // the rest of the codebase and safe to re-read. The byte cap measures the
  // same decoded string, so the limit is unchanged.
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
