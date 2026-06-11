import { fileURLToPath } from 'node:url'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// D1 integration tests for the lists-api routes: run inside a real workerd
// isolate with a local (Miniflare) D1, the actual @rallypoint/lists-db
// migrations applied. Replaces the testcontainers-Postgres tests deleted in
// the D1 port.
// Run: `npm run test:d1:lists` (NOT part of the root node-pool `npm run test`).
const migrationsDir = fileURLToPath(new URL('../../packages/lists-db/migrations', import.meta.url))

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(migrationsDir)
      return {
        miniflare: {
          compatibilityDate: '2025-01-01',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          // Surfaced to the setup file so each isolate applies the schema.
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }
    }),
  ],
  test: {
    include: ['apps/lists-api/**/*.d1.test.ts'],
    setupFiles: ['apps/lists-api/test/apply-d1-migrations.ts'],
    testTimeout: 30_000,
  },
})
