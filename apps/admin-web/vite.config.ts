import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { version } from './package.json'

// Rallypoint Admin hosted UI. Same shape as apps/money-web's vite.config but
// the dev proxy points at the admin-api port (8087) and there is no PWA
// service worker — Admin is an internal review tool, not an installable app.

// Resolve `virtual:analytics` to the real PostHog package when a key is
// present (SaaS build), otherwise to the retained no-op stub so the FOSS
// mirror builds without @rallypoint/analytics being present.
const analyticsAlias = process.env.VITE_POSTHOG_KEY
  ? '@rallypoint/analytics'
  : resolve(__dirname, '../../packages/web-kit/src/analytics-noop.ts')

export default defineConfig({
  resolve: {
    alias: { 'virtual:analytics': analyticsAlias },
  },
  define: {
    // App-switcher version eyebrow reads the real workspace version so it
    // can't drift from package.json at release time.
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(version),
  },
  plugins: [react(), tailwindcss()],
  server: {
    port: 5179,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8087',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    // Hidden maps — emitted but no sourceMappingURL footer. Audit E1 #10.
    sourcemap: 'hidden',
  },
  test: {
    environment: 'jsdom',
    globals: false,
  },
})
