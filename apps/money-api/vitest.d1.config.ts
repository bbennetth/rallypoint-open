import { fileURLToPath } from 'node:url'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// D1 integration tests for the money-api routes: run inside a real workerd
// isolate with a local (Miniflare) D1, the actual @rallypoint/money-db
// migrations applied. Replaces the testcontainers-Postgres tests deleted in
// the D1 port.
// Run: `npm run test:d1:money` (NOT part of the root node-pool `npm run test`).
const migrationsDir = fileURLToPath(new URL('../../packages/money-db/migrations', import.meta.url))

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
          // Surfaced to the setup file so each isolate applies the schema.
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }
    }),
  ],
  test: {
    include: ['apps/money-api/**/*.d1.test.ts'],
    setupFiles: ['apps/money-api/test/apply-d1-migrations.ts'],
    testTimeout: 30_000,
  },
})
