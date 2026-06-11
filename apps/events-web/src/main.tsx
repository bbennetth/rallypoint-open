import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { captureEmbeddedShell, detectStandalone, installConnectionListeners, registerThemePersister, Toaster } from '@rallypoint/ui'
import { initAnalytics } from '@rallypoint/web-kit'
import { App } from './App.js'
import { updateSettings } from './lib/api.js'
import './index.css'

// Bootstrap analytics (no-op when VITE_POSTHOG_KEY is unset).
initAnalytics()

// Tag standalone PWA mode pre-React so the Rallypoint Minimal theme's
// `html[data-pwa-standalone='true'] .app-tabbar` rules (tab bar flush
// with the iOS home indicator) apply from first paint.
if (detectStandalone()) document.documentElement.dataset.pwaStandalone = 'true'

// Capture the embedded-shell marker (set when launched from another app's
// switcher inside the iOS PWA) into sessionStorage and strip it from the URL,
// before React/router mount.
captureEmbeddedShell()

// Wire `navigator.online`/`offline` events into `useConnectionStore`
// so an OS-level offline state bypasses the SSE staleness watchdog
// and flips the BrandLockup dot red immediately (decideConnectionView
// short-circuits to offline when `online === false`). Without this
// the store would stay at its constructor-time `navigator.onLine`
// sample and never react to airplane mode mid-session.
installConnectionListeners()

// Persist theme changes into the shared cross-app settings bag (debounced
// in the store). Hydration happens in getSession via hydrateThemeFromServer,
// which suppresses this persister so applying the server value doesn't echo
// a write back. Fire-and-forget — a failed write must never break the UI.
registerThemePersister(({ mode, color }) => {
  void updateSettings('shared', { themeMode: mode, themeColor: color })
})

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root missing from index.html')

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <App />
      <Toaster />
    </BrowserRouter>
  </StrictMode>,
)
