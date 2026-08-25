import { Hono } from 'hono'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { readJsonBody } from './_body.js'

// System-owned events management — thin proxies to events-api's
// EventsRPC adminSystemEvent methods over the EVENTS service binding.
// Access control (requireSession + requireAdmin) is mounted in
// build-app; events-api additionally re-checks the actor against its
// own ADMIN_USER_IDS allowlist. Validation of event fields lives in
// events-api's core fns (CreateEventSchema/PatchEventSchema), so this
// router only shapes envelopes.

type Kinded = { kind: string; issues?: { path: string; message: string }[] }

// Map the RPC discriminators every method can return; callers handle
// their method-specific kinds ('ok', 'conflict') themselves.
function throwCommon(result: Kinded): void {
  if (result.kind === 'forbidden') throw errors.forbidden()
  if (result.kind === 'not_found') throw errors.notFound('System event not found.')
  if (result.kind === 'invalid') {
    const issues = result.issues ?? []
    throw new ApiError({
      code: 'validation_failed',
      message: issues[0] ? `${issues[0].path ? issues[0].path + ': ' : ''}${issues[0].message}` : 'Request body failed validation.',
      status: 400,
      details: { issues },
    })
  }
}

export const systemEventsRoutes = new Hono<HonoApp>()
  .get('/api/v1/ui/system-events', async (c) => {
    const actor = c.var.session!.userId
    const result = await c.var.services.systemEvents.list(actor, {
      includeDeleted: c.req.query('include') === 'deleted',
      ...(c.req.query('cursor') ? { cursor: c.req.query('cursor') } : {}),
    })
    throwCommon(result)
    if (result.kind !== 'ok') throw errors.forbidden()
    return c.json({ items: result.data.items, next_cursor: result.data.nextCursor })
  })

  .post('/api/v1/ui/system-events', async (c) => {
    const actor = c.var.session!.userId
    const result = await c.var.services.systemEvents.create(actor, await readJsonBody(c))
    throwCommon(result)
    if (result.kind === 'conflict') {
      throw errors.conflict(result.code, 'Event slug collision — retry the create.')
    }
    if (result.kind !== 'ok') throw errors.forbidden()
    return c.json(result.data, 201)
  })

  .get('/api/v1/ui/system-events/:id', async (c) => {
    const actor = c.var.session!.userId
    const result = await c.var.services.systemEvents.get(actor, c.req.param('id'))
    throwCommon(result)
    if (result.kind !== 'ok') throw errors.forbidden()
    return c.json(result.data)
  })

  .patch('/api/v1/ui/system-events/:id', async (c) => {
    const actor = c.var.session!.userId
    const result = await c.var.services.systemEvents.patch(
      actor,
      c.req.param('id'),
      await readJsonBody(c),
    )
    throwCommon(result)
    if (result.kind !== 'ok') throw errors.forbidden()
    return c.json(result.data)
  })

  .delete('/api/v1/ui/system-events/:id', async (c) => {
    const actor = c.var.session!.userId
    const result = await c.var.services.systemEvents.softDelete(actor, c.req.param('id'))
    throwCommon(result)
    if (result.kind !== 'ok') throw errors.forbidden()
    return c.body(null, 204)
  })

  .post('/api/v1/ui/system-events/:id/restore', async (c) => {
    const actor = c.var.session!.userId
    const result = await c.var.services.systemEvents.restore(actor, c.req.param('id'))
    throwCommon(result)
    if (result.kind === 'conflict') {
      throw errors.conflict(result.code, 'Event is not deleted.')
    }
    if (result.kind !== 'ok') throw errors.forbidden()
    return c.json(result.data)
  })
