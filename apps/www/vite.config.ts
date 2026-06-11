import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Rallypoint apex marketing/home site (apps/www). A plain static SPA —
// no PWA, no session/api proxy, no service worker. It only links out to
// the app subdomains and the public rallypoint-open repo, so the dev
// server needs no /api proxy.

// Resolve `virtual:analytics` to the real PostHog package when a key is
// present (SaaS build), otherwise to the retained no-op stub so the FOSS
// mirror builds without @rallypoint/analytics being present.
const analyticsAlias = process.env.VITE_POSTHOG_KEY
  ? '@rallypoint/analytics'
  : resolve(__dirname, '../../packages/web-kit/src/analytics-noop.ts')

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
