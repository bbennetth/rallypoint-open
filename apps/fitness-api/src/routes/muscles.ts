import { Hono } from 'hono'
import type { HonoApp } from '../context.js'

// The muscle taxonomy (2-level groups → muscles) that drives the catalog
// filter UI and the add-custom-exercise form. Seeded reference data, read
// from the DB so a future taxonomy change ships as a migration, not a
// client release. Session-gated like the rest of the UI surface.

export const musclesRoutes = new Hono<HonoApp>().get('/api/v1/ui/muscle-groups', async (c) => {
  const groups = await c.var.repos.muscles.listTaxonomy()
  return c.json({ groups })
})
