import { Hono } from 'hono'
import { machineSettingsEntriesSchema } from '@rallypoint/fitness-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { readJsonBody } from './_body.js'

// Per-user, per-exercise machine settings — flexible name/value notes
// (e.g. "Cable height" -> "4", "Handle" -> "rope") the actor attaches
// to any exercise they can see. Same visibility contract as favorites:
// the exercise must resolve via exercises.getForActor (curated global
// or the actor's own custom row) or the route 404s. Cookie + CSRF +
// session gated in build-app.

export const machineSettingsRoutes = new Hono<HonoApp>()
  .get('/api/v1/ui/exercises/:id/machine-settings', async (c) => {
    const userId = c.var.session!.userId
    const id = c.req.param('id')
    if (!id) {
      throw errors.validation({
        issues: [{ code: 'custom', path: ['id'], message: 'Missing exercise id.' }],
      })
    }
    const exists = await c.var.repos.exercises.getForActor(userId, id)
    if (!exists) {
      throw errors.notFound('Exercise not found.')
    }
    const entries = await c.var.repos.machineSettings.get(userId, id)
    return c.json({ entries })
  })
  .put('/api/v1/ui/exercises/:id/machine-settings', async (c) => {
    const userId = c.var.session!.userId
    const id = c.req.param('id')
    if (!id) {
      throw errors.validation({
        issues: [{ code: 'custom', path: ['id'], message: 'Missing exercise id.' }],
      })
    }
    const exists = await c.var.repos.exercises.getForActor(userId, id)
    if (!exists) {
      throw errors.notFound('Exercise not found.')
    }
    const raw = await readJsonBody(c)
    const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const parsed = machineSettingsEntriesSchema.safeParse(body.entries)
    if (!parsed.success) {
      throw errors.validation({ issues: parsed.error.issues })
    }
    const entries = await c.var.repos.machineSettings.put(userId, id, parsed.data)
    return c.json({ entries })
  })
