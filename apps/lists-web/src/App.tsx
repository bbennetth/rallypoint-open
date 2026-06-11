import { Navigate, Route, Routes } from 'react-router-dom'
import { RequireSession } from './ui/RequireSession.js'
import { AppChrome } from './ui/AppChrome.js'
import { SsoCallbackPage } from './pages/SsoCallbackPage.js'
import { MyListsPage } from './pages/MyListsPage.js'
import { ListDetailPage } from './pages/ListDetailPage.js'
import { ShareAcceptPage } from './pages/ShareAcceptPage.js'

export function App() {
  return (
    <Routes>
      {/* The apex (rallypt.*) hosts the marketing/home page (#419); the
          subdomain root just bounces into the app. RequireSession on the
          gated home redirects unauthenticated visitors to RPID to sign in
          or create an account (auto sign-in when an RPID session exists). */}
      <Route path="/" element={<Navigate to="/me/lists" replace />} />
      <Route path="/sso/callback" element={<SsoCallbackPage />} />
      <Route
        path="/me/lists"
        element={
          <RequireSession>
            {(userId) => (
              <AppChrome>
                <MyListsPage selfUserId={userId} />
              </AppChrome>
            )}
          </RequireSession>
        }
      />
      <Route
        path="/me/lists/:listId"
        element={
          <RequireSession>
            {(userId) => (
              <AppChrome>
                <ListDetailPage selfUserId={userId} />
              </AppChrome>
            )}
          </RequireSession>
        }
      />
      {/* Share-by-email accept landing (#128). RequireSession funnels
          unauthenticated visitors through the RPID SSO flow and lands
          them back here; the page auto-submits the code and forwards
          to the shared list. */}
      <Route
        path="/share/:code"
        element={
          <RequireSession>
            {() => <ShareAcceptPage />}
          </RequireSession>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
