import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { captureEmbeddedShell } from '@rallypoint/ui'
import { initAnalytics } from '@rallypoint/web-kit'
import { App } from './App.js'
import './index.css'

// Theme hydration + write-through to the shared cross-app settings bag
// is owned by useSessionClient — it gates the write on an authenticated
// session (the PATCH route is cookie-only) and suppresses echo-writes
// during hydration.

// Bootstrap analytics (no-op when VITE_POSTHOG_KEY is unset).
initAnalytics()

// Capture the embedded-shell marker (set when launched from another app's
// switcher inside the iOS PWA) into sessionStorage and strip it from the URL,
// before React/router mount.
captureEmbeddedShell()

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root missing from index.html')

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
