import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { detectStandalone, registerThemePersister } from '@rallypoint/ui'
import { initAnalytics } from '@rallypoint/web-kit'
import { App } from './App.js'
import { updateSettings } from './lib/api.js'
import './index.css'

// Bootstrap analytics (no-op when VITE_POSTHOG_KEY is unset).
initAnalytics()

// Tag standalone PWA mode pre-React so the theme's
// `html[data-pwa-standalone='true'] .app-tabbar` rules apply from first paint.
if (detectStandalone()) document.documentElement.dataset.pwaStandalone = 'true'

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
    </BrowserRouter>
  </StrictMode>,
)
