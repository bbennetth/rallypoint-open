import { Navigate, Route, Routes } from 'react-router-dom'
import { RequireSession } from './ui/RequireSession.js'
import { AppChrome } from './ui/AppChrome.js'
import { SsoCallbackPage } from './pages/SsoCallbackPage.js'
import { MyDayPage } from './pages/MyDayPage.js'
import { TasksPage } from './pages/TasksPage.js'
import { ShoppingPage } from './pages/ShoppingPage.js'
import { EventsPage } from './pages/EventsPage.js'
import { NotesPage } from './pages/NotesPage.js'
import { SettingsPage } from './pages/SettingsPage.js'

export function App() {
  return (
    <Routes>
      {/* The apex (rallypt.*) hosts the marketing/home page (#419); the
          subdomain root just bounces into the app. RequireSession on the
          gated home redirects unauthenticated visitors to RPID to sign in
          or create an account (auto sign-in when an RPID session exists). */}
      <Route path="/" element={<Navigate to="/me" replace />} />
      <Route path="/sso/callback" element={<SsoCallbackPage />} />
      <Route
        path="/me"
        element={
          <RequireSession>
            {() => (
              <AppChrome>
                <MyDayPage />
              </AppChrome>
            )}
          </RequireSession>
        }
      />
      {/* Upcoming folded into My Day (issue #495); old links land on the toggle. */}
      <Route path="/upcoming" element={<Navigate to="/me?mode=upcoming" replace />} />
      <Route
        path="/tasks"
        element={
          <RequireSession>
            {() => (
              <AppChrome>
                <TasksPage />
              </AppChrome>
            )}
          </RequireSession>
        }
      />
      <Route
        path="/shopping"
        element={
          <RequireSession>
            {() => (
              <AppChrome>
                <ShoppingPage />
              </AppChrome>
            )}
          </RequireSession>
        }
      />
      <Route
        path="/events"
        element={
          <RequireSession>
            {() => (
              <AppChrome>
                <EventsPage />
              </AppChrome>
            )}
          </RequireSession>
        }
      />
      <Route
        path="/notes"
        element={
          <RequireSession>
            {() => (
              <AppChrome>
                <NotesPage />
              </AppChrome>
            )}
          </RequireSession>
        }
      />
      <Route
        path="/settings"
        element={
          <RequireSession>
            {() => (
              <AppChrome>
                <SettingsPage />
              </AppChrome>
            )}
          </RequireSession>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
