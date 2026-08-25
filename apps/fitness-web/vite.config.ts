import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { version } from './package.json'

// Rallypoint Fitness hosted UI. Same shape as apps/money-web's vite.config
// but the dev proxy points at the fitness-api port (8086) and the manifest
// reflects the Fitness app identity.

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
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // injectManifest: we ship a hand-written sw.ts (src/sw.ts) so the
      // API endpoints can be excluded from caching.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: 'auto',
      devOptions: { enabled: false },
      manifest: {
        id: '/',
        name: 'Rallypoint Health',
        short_name: 'Health',
        description: 'Multisport health & fitness tracking on Rallypoint.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#0b1b2b',
        theme_color: '#0b1b2b',
        categories: ['health', 'sports', 'utilities'],
        icons: [
          { src: '/icons/rallypt-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/rallypt-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/rallypt-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/rallypt.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff,woff2}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
  server: {
    port: 5178,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8086',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: 'hidden',
  },
  test: {
    environment: 'jsdom',
    globals: false,
  },
})
