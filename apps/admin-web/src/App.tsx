import { Navigate, Route, Routes } from 'react-router-dom'
import { RequireSession } from './ui/RequireSession.js'
import { AppChrome } from './ui/AppChrome.js'
import { SsoCallbackPage } from './pages/SsoCallbackPage.js'
import { ReviewQueuePage } from './pages/ReviewQueuePage.js'
import { FoodReviewQueuePage } from './pages/FoodReviewQueuePage.js'
import { ExerciseCatalogPage } from './pages/ExerciseCatalogPage.js'
import { SystemEventsPage } from './pages/SystemEventsPage.js'
import { LineupIngestPage } from './pages/LineupIngestPage.js'
import { ArtistCatalogPage } from './pages/ArtistCatalogPage.js'

export function App() {
  return (
    <Routes>
      {/* The subdomain root bounces straight into the review queue.
          RequireSession redirects unauthenticated visitors to RPID; the
          ADMIN_USER_IDS allowlist is enforced server-side (non-admins get
          403s from every /submissions call). */}
      <Route path="/" element={<Navigate to="/review" replace />} />
      <Route path="/sso/callback" element={<SsoCallbackPage />} />
      <Route
        path="/review"
        element={
          <RequireSession>
            {() => (
              <AppChrome>
                <ReviewQueuePage />
              </AppChrome>
            )}
          </RequireSession>
        }
      />
      <Route
        path="/food-review"
        element={
          <RequireSession>
            {() => (
              <AppChrome>
                <FoodReviewQueuePage />
              </AppChrome>
            )}
          </RequireSession>
        }
      />
      <Route
        path="/catalog"
        element={
          <RequireSession>
            {() => (
              <AppChrome>
                <ExerciseCatalogPage />
              </AppChrome>
            )}
          </RequireSession>
        }
      />
      <Route
        path="/system-events"
        element={
          <RequireSession>
            {() => (
              <AppChrome>
                <SystemEventsPage />
              </AppChrome>
            )}
          </RequireSession>
        }
      />
      <Route
        path="/artists"
        element={
          <RequireSession>
            {() => (
              <AppChrome>
                <ArtistCatalogPage />
              </AppChrome>
            )}
          </RequireSession>
        }
      />
      <Route
        path="/system-events/:id/lineup"
        element={
          <RequireSession>
            {() => (
              <AppChrome>
                <LineupIngestPage />
              </AppChrome>
            )}
          </RequireSession>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
