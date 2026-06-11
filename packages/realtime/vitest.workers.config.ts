import { fileURLToPath } from 'node:url'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Durable Objects tests for the RealtimeHub (#313, Phase 3). Runs inside a
// real workerd isolate (Miniflare) with the HUB DO binding wired to the
// RealtimeHub class exported by test/hub-worker.ts. Mirrors the id-api D1
// config pattern (apps/id-api/vitest.d1.config.ts) but for a DO instead of
// a D1 database. Run: `npm run test:workers` (NOT the root node pool).
const main = fileURLToPath(new URL('./test/hub-worker.ts', import.meta.url))

export default defineConfig({
  plugins: [
    cloudflareTest({
      main,
      miniflare: {
        compatibilityDate: '2025-01-01',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: { HUB: 'RealtimeHub' },
        bindings: {
          // Must match the key the tests sign channel tokens with.
          REALTIME_TOKEN_HMAC_KEY: 'test-realtime-hmac-key-not-a-real-secret',
        },
      },
    }),
  ],
  test: {
    include: ['packages/realtime/**/*.workers.test.ts'],
    // Match the root node-pool timeout. The first test in a workerd
    // isolate pays cold-start compile overhead, and these do real
    // in-isolate WebSocket handshakes — enough to overrun vitest's 5s
    // default on slower CI runners.
    testTimeout: 30_000,
  },
})
