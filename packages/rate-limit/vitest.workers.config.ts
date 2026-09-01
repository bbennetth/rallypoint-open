import { fileURLToPath } from 'node:url'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Durable Objects tests for the RateLimitCounter (#881). Runs inside a real
// workerd isolate (Miniflare) with the COUNTER DO binding wired to the
// RateLimitCounter class exported by test/counter-worker.ts. Mirrors the
// RealtimeHub setup (packages/realtime/vitest.workers.config.ts).
// Run: `npm run test:rate-limit-workers` (NOT the root node pool).
const main = fileURLToPath(new URL('./test/counter-worker.ts', import.meta.url))

export default defineConfig({
  plugins: [
    cloudflareTest({
      main,
      miniflare: {
        compatibilityDate: '2025-01-01',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: { COUNTER: { className: 'RateLimitCounter', useSQLite: true } },
      },
    }),
  ],
  test: {
    include: ['packages/rate-limit/**/*.workers.test.ts'],
    // Match the realtime workers config: the first test in a workerd isolate
    // pays cold-start compile overhead.
    testTimeout: 30_000,
  },
})
