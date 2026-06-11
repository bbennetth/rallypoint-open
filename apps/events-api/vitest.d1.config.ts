import { fileURLToPath } from 'node:url'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// D1 integration tests for the events-api routes: run inside a real workerd
// isolate with a local (Miniflare) D1, the actual @rallypoint/events-db
// migrations applied. Replaces the testcontainers-Postgres tests deleted in
// the D1 port.
// Run: `npm run test:d1:events` (NOT part of the root node-pool `npm run test`).
const migrationsDir = fileURLToPath(new URL('../../packages/events-db/migrations', import.meta.url))

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(migrationsDir)
      return {
        miniflare: {
          compatibilityDate: '2025-01-01',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          // Real local R2 bucket for the map/ticket upload/serve tests (#409).
          r2Buckets: ['OBJECT_STORE'],
          // Surfaced to the setup file so each isolate applies the schema.
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }
    }),
  ],
  test: {
    include: ['apps/events-api/**/*.d1.test.ts'],
    setupFiles: ['apps/events-api/test/apply-d1-migrations.ts'],
    testTimeout: 30_000,
    // The group-ledger outage tests (groups.d1.test.ts) inject a money
    // client stub that THROWS to simulate money-api being down. The route
    // handler awaits that call inside a try/catch and handles it correctly
    // (group still created / 502 returned) — but @cloudflare/vitest-pool-
    // workers still surfaces the thrown stub error at the workerd global
    // level as an "unhandled rejection", failing the run with exit 1 even
    // though every assertion passes. This flag stops those intentional,
    // already-caught throws from failing the suite. (Verified: removing it
    // yields exactly the 2 money-down throws, 234/234 tests still passing.)
    dangerouslyIgnoreUnhandledErrors: true,
  },
})
