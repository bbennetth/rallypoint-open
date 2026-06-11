import { Hono } from 'hono'
import type { HonoApp } from '../context.js'

// Public health + version routes. No auth, no CORS gating. Used by
// load balancers and monitoring. Lives outside ui/sdk per the platform
// docs/design/api-namespaces-cors.md split.

export const healthRoutes = new Hono<HonoApp>()
  .get('/api/v1/health', (c) =>
    c.json({
      ok: true,
      service: 'rallypoint-lists',
      version: c.var.env.BUILD_VERSION,
      time: new Date().toISOString(),
    }),
  )
  .get('/api/v1/version', (c) =>
    c.json({
      version: c.var.env.BUILD_VERSION,
    }),
  )
