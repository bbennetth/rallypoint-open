import { fileURLToPath } from 'node:url'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// D1 contract tests for the id-api repos: run inside a real workerd
// isolate with a local (Miniflare) D1, the actual @rallypoint/db
// migrations applied. This is the go-forward integration path that
// replaces the testcontainers-Postgres tests deleted in the D1 port.
// Run: `npm run test:d1` (NOT part of the root node-pool `npm run test`).
const migrationsDir = fileURLToPath(new URL('../../packages/db/migrations', import.meta.url))

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(migrationsDir)
      return {
        miniflare: {
          compatibilityDate: '2025-01-01',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          // Real local R2 bucket for the avatar upload/serve tests (#409).
          r2Buckets: ['OBJECT_STORE'],
          // Surfaced to the setup file so each isolate applies the schema.
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }
    }),
  ],
  test: {
    // `*.d1.test.ts` = repo contract tests (need the migrations);
    // `*.workers.test.ts` = other id-api code that must run in workerd
    // (e.g. the scrypt password hasher). Both run in the isolate; the
    // migration setup is harmless for the latter.
    include: ['apps/id-api/**/*.{d1,workers}.test.ts'],
    setupFiles: ['apps/id-api/test/apply-d1-migrations.ts'],
    // Match the root node-pool timeout. In-isolate scrypt (the workerd
    // password test runs hash + two verifies) is CPU-heavy and overruns
    // vitest's 5s default on slower CI runners.
    testTimeout: 30_000,
  },
})
