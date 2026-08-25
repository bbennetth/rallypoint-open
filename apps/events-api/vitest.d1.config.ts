import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// D1 integration tests for the events-api routes: run inside a real workerd
// isolate with a local (Miniflare) D1, the actual @rallypoint/events-db
// migrations applied. Replaces the testcontainers-Postgres tests deleted in
// the D1 port.
// Run: `npm run test:d1:events` (NOT part of the root node-pool `npm run test`).
const migrationsDir = fileURLToPath(new URL('../../packages/events-db/migrations', import.meta.url))
// The demo-festival seed SQL (scripts/seed-demo-festival.sql) is read here in
// Node and handed to the isolate as a plain string binding — workerd can't
// touch the filesystem, and this keeps the test exercising the real file.
const seedDemoFestivalSql = readFileSync(
  fileURLToPath(new URL('../../scripts/seed-demo-festival.sql', import.meta.url)),
  'utf8',
)

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(migrationsDir)
      // Split at the 0008 event_artists rebuild so migration-0008.d1.test.ts
      // can apply the PRE-rebuild schema to DB_MIG, seed representative
      // data, then apply the rebuild on top ("previous schema + data" per
      // the CLAUDE.md migration-test rule). The main DB still gets the
      // full chain in the global beforeAll.
      const rebuildIdx = migrations.findIndex((m) => m.name.startsWith('0008_'))
      const migrationsBase = migrations.slice(0, rebuildIdx)
      const migrationsHead = migrations.slice(rebuildIdx)
      return {
        miniflare: {
          compatibilityDate: '2025-01-01',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB', 'DB_MIG'],
          // Real local R2 bucket for the map/ticket upload/serve tests (#409).
          r2Buckets: ['OBJECT_STORE'],
          // Surfaced to the setup file so each isolate applies the schema.
          // ADMIN_USER_IDS backs the EventsRPC admin system-events
          // contract tests (rpc.workers.test.ts); the route d1 tests
          // build their own app with an explicit parseEnv and ignore it.
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_MIGRATIONS_BASE: migrationsBase,
            TEST_MIGRATIONS_HEAD: migrationsHead,
            ADMIN_USER_IDS: 'user_rpc_admin_test',
            SEED_DEMO_FESTIVAL_SQL: seedDemoFestivalSql,
          },
        },
      }
    }),
  ],
  test: {
    // `*.d1.test.ts` = repo + route contract tests; `*.workers.test.ts`
    // = other in-isolate tests (e.g. EventsRPC RPC contract tests added
    // in feat/rpc-bindings PR 1). Both run in the same workerd isolate.
    include: ['apps/events-api/**/*.{d1,workers}.test.ts'],
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
