import { Navigate, Route, Routes } from 'react-router-dom'
import { RequireSession } from './ui/RequireSession.js'
import { AppChrome } from './ui/AppChrome.js'
import { SsoCallbackPage } from './pages/SsoCallbackPage.js'
import { LedgersPage } from './pages/LedgersPage.js'

export function App() {
  return (
    <Routes>
      {/* The apex (rallypt.*) hosts the marketing/home page (#419); the
          subdomain root just bounces into the app. RequireSession on the
          gated home redirects unauthenticated visitors to RPID to sign in
          or create an account (auto sign-in when an RPID session exists). */}
      <Route path="/" element={<Navigate to="/me/ledgers" replace />} />
      <Route path="/sso/callback" element={<SsoCallbackPage />} />
      <Route
        path="/me/ledgers"
        element={
          <RequireSession>
            {(userId) => (
              <AppChrome>
                <LedgersPage selfUserId={userId} />
              </AppChrome>
            )}
          </RequireSession>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
