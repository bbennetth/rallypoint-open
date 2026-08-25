import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { initAnalytics } from '@rallypoint/web-kit'
import { App } from './App.js'
import './index.css'

// The apex site is unauthenticated and stateless — no PWA, no session
// bootstrap, no theming (the marketing pages are dark-only per the Soft
// Ink design handoff).

// Bootstrap analytics (no-op when VITE_POSTHOG_KEY is unset).
initAnalytics('rallypoint-www')

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root missing from index.html')

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
