import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { initAnalytics } from '@rallypoint/web-kit'
import { App } from './App.js'
import './index.css'

// Theme hydration + write-through to the shared cross-app settings bag
// is owned by useSessionClient — it gates the write on an authenticated
// session (the PATCH route is cookie-only) and suppresses echo-writes
// during hydration.

// Bootstrap analytics (no-op when VITE_POSTHOG_KEY is unset).
initAnalytics()

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root missing from index.html')

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
