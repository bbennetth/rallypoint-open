import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { initAnalytics } from '@rallypoint/web-kit'
import { App } from './App.js'
import './index.css'

// The apex site is unauthenticated and stateless — no PWA, no session
// bootstrap, no theme server-persistence. The theme store still persists
// to localStorage on its own, so the toggle works standalone and the
// pre-hydration boot script reads it on the next visit.

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
