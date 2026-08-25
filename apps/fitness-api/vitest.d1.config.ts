import { fileURLToPath } from 'node:url'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// D1 integration tests for fitness-api routes: run inside a real workerd
// isolate with a local (Miniflare) D1, the actual @rallypoint/fitness-db
// migrations applied, plus a Miniflare R2 bucket (OBJECT_STORE) for the
// progress-photo routes.
// Run: `npm run test:d1:fitness` (NOT part of the root node-pool `npm run test`).
const migrationsDir = fileURLToPath(new URL('../../packages/fitness-db/migrations', import.meta.url))

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(migrationsDir)
      return {
        miniflare: {
          compatibilityDate: '2025-01-01',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          r2Buckets: ['OBJECT_STORE'],
          bindings: {
            // Surfaced to the setup file so each isolate applies the schema.
            TEST_MIGRATIONS: migrations,
            // ensureDeps memoizes the parsed env on first use per isolate, so
            // a gateway id injected per-test would be ignored — it has to be
            // here for rpc.workers.test.ts to pin that the review entrypoint
            // actually routes through the AI Gateway.
            AI_GATEWAY_ID: 'test-gateway',
          },
        },
      }
    }),
  ],
  test: {
    include: ['apps/fitness-api/**/*.{d1,workers}.test.ts'],
    setupFiles: ['apps/fitness-api/test/apply-d1-migrations.ts'],
    testTimeout: 30_000,
  },
})
