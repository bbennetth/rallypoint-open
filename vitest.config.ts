import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Belt-and-suspenders dedupe so a single React backs both the
    // jsx-runtime that creates elements and the react-dom that renders
    // them in jsdom — mismatched copies throw "Objects are not valid as a
    // React child". A no-op now that root `overrides` pin one React 19
    // across the monorepo (see docs/design/unified-ui-v1.md §3.3), but
    // kept as cheap insurance for the test runner.
    dedupe: ['react', 'react-dom'],
    // Always alias `virtual:analytics` to the no-op stub in tests —
    // vitest runs under Node (no build-time VITE_POSTHOG_KEY), and the
    // real @rallypoint/analytics package requires posthog-js which needs
    // a browser environment. The no-op stub satisfies the import contract
    // without side effects.
    alias: {
      'virtual:analytics': resolve(
        __dirname,
        'packages/web-kit/src/analytics-noop.ts',
      ),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['{apps,packages,scripts}/**/*.{test,spec}.{ts,tsx}'],
    // `*.d1.test.ts` run under @cloudflare/vitest-pool-workers (real
    // workerd + local D1), not this node pool — see apps/*/vitest.d1.config.ts.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.d1.test.ts', '**/*.workers.test.ts'],
    // Cap the worker pool. Default is one fork per core (32 here). This
    // cap originally guarded against ~44 integration files each booting a
    // testcontainers Postgres (32 forks × a PG container peaked at ~45GB
    // RSS and starved the host); those tests were replaced by the D1
    // (Miniflare) pool, but the cap stays as cheap insurance against
    // over-forking. Honor a CI/env override, else cap at 4.
    // vitest 4: poolOptions was removed; the per-pool fork limit is now
    // the top-level `maxWorkers` (minForks no longer exists).
    pool: 'forks',
    maxWorkers: Number.isInteger(Number(process.env.VITEST_MAX_FORKS))
      ? Math.max(1, Number(process.env.VITEST_MAX_FORKS))
      : 4,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['apps/**/src/**', 'packages/**/src/**'],
    },
    testTimeout: 30_000,
  },
})
