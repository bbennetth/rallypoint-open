import { Hono } from 'hono'
import type { HonoApp } from '../context.js'

// Public health route. Used by load balancers and monitoring. No
// auth, no CORS gating. Lives outside ui/sdk per the design doc.
//
// /api/v1/health returns the broad version line for monitoring
// dashboards (deploy correlation) but no longer leaks the git
// commit SHA — commit identity moved to /api/v1/admin/version
// per P4.1 (the SHA is a minor fingerprinting risk for casual
// recon). The admin endpoint exposes both for operators.

export const healthRoutes = new Hono<HonoApp>()
  .get('/api/v1/health', (c) =>
    c.json({
      ok: true,
      version: c.var.env.BUILD_VERSION,
      time: new Date().toISOString(),
    }),
  )
  .get('/api/v1/version', (c) =>
    c.json({
      version: c.var.env.BUILD_VERSION,
    }),
  )
