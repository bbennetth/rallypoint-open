import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Object-store binding tests (#409). Runs inside a real workerd isolate
// (Miniflare) with a real local R2 bucket bound as OBJECT_STORE — no
// mocking the store. Mirrors the realtime DO config pattern
// (packages/realtime/vitest.workers.config.ts) but for an R2 binding.
// Run: `npm run test:objstore` (NOT the root node pool).
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2025-01-01',
        compatibilityFlags: ['nodejs_compat'],
        r2Buckets: ['OBJECT_STORE'],
      },
    }),
  ],
  test: {
    include: ['packages/object-store/**/*.workers.test.ts'],
    testTimeout: 30_000,
  },
})
