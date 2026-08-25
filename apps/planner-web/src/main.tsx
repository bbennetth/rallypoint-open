import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { captureEmbeddedShell, detectStandalone, registerThemePersister } from '@rallypoint/ui'
import { initAnalytics, initBootWatchdog } from '@rallypoint/web-kit'
import { App } from './App.js'
import { updateSettings } from './lib/api.js'
import { bootOfflineUser } from './lib/offline/cache.js'
import './index.css'

// Bootstrap analytics (no-op when VITE_POSTHOG_KEY is unset).
initAnalytics('rallypoint-planner-web')

// Detect a previous launch that never booted (white-screened standalone
// PWA) and self-heal: activate a waiting SW, or nuke SW + caches on a
// repeat failure. AppChrome marks success via bootSucceeded().
initBootWatchdog()

// Rehydrate the last-known userId from localStorage so the per-user
// IndexedDB (planner-offline:<userId>) is reachable on a cold offline
// reload — before getSession has a chance to resolve. setOfflineUser()
// will overwrite this once the session probe succeeds (or carry it
// through unchanged on a transport error, letting the cached SessionDto
// surface from the read fallback).
bootOfflineUser()

// Tag standalone PWA mode pre-React so the theme's
// `html[data-pwa-standalone='true'] .app-tabbar` rules apply from first paint.
if (detectStandalone()) document.documentElement.dataset.pwaStandalone = 'true'

// Capture the embedded-shell marker (set when launched from another app's
// switcher inside the iOS PWA) into sessionStorage and strip it from the URL,
// before React/router mount.
captureEmbeddedShell()

// Persist theme changes into the shared cross-app settings bag (debounced
// in the store). Hydration happens in getSession via hydrateThemeFromServer,
// which suppresses this persister so applying the server value doesn't echo
// a write back. Fire-and-forget — a failed write must never break the UI.
registerThemePersister(({ mode, color }) => {
  void updateSettings('shared', { themeMode: mode, themeColor: color })
})

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root missing from index.html')

// Data router (createBrowserRouter) rather than <BrowserRouter> so descendant
// surfaces can use useBlocker to guard unsaved edits (Notes manual save). App
// keeps its own <Routes>; the single splat route matches from root so those
// absolute paths still resolve.
const router = createBrowserRouter([{ path: '*', element: <App /> }])

createRoot(rootEl).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
