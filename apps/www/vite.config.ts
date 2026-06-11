import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Rallypoint apex marketing/home site (apps/www). A plain static SPA — no
// PWA. It only links out to the app subdomains and the public
// rallypoint-open repo, so the dev server needs no /api proxy. The one SW
// it ships is the kill-switch below — it has no caching SW of its own.

// Emit the kill-switch SW (sw-killswitch.js) at the asset root under the
// URLs an old festival-planner service worker polls for updates (#493).
// www has `publicDir:false`, so a plugin is the only way to land a static
// file in dist. Both names cover the vite-plugin-pwa (`sw.js`) and
// CRA-style (`service-worker.js`) registration conventions.
function killSwitchServiceWorker(): Plugin {
  return {
    name: 'www-killswitch-sw',
    generateBundle() {
      const source = readFileSync(resolve(__dirname, 'sw-killswitch.js'), 'utf8')
      for (const fileName of ['sw.js', 'service-worker.js']) {
        this.emitFile({ type: 'asset', fileName, source })
      }
    },
  }
}

// Resolve `virtual:analytics` to the real PostHog package when a key is
// present (SaaS build), otherwise to the retained no-op stub so the FOSS
// mirror builds without @rallypoint/analytics being present.
const analyticsAlias = process.env.VITE_POSTHOG_KEY
  ? '@rallypoint/analytics'
  : resolve(__dirname, '../../packages/web-kit/src/analytics-noop.ts')

export default defineConfig({
  plugins: [react(), tailwindcss(), killSwitchServiceWorker()],
  resolve: {
    alias: { 'virtual:analytics': analyticsAlias },
  },
  // No static assets to copy, and the committed ./public holds only a
  // `wrangler dev` placeholder index.html that would otherwise collide
  // with the generated dist/index.html — so disable publicDir entirely.
  publicDir: false,
  server: {
    port: 5180,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    globals: false,
  },
})
