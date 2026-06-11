import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll } from 'vitest'

// Apply the @rallypoint/db SQLite migrations to the per-isolate local D1
// before any contract test runs. `TEST_MIGRATIONS` is provided by
// vitest.d1.config.ts (readD1Migrations of packages/db/migrations).
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})
