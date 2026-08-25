import { Navigate, Route, Routes } from 'react-router-dom'
import { RequireSession } from './ui/RequireSession.js'
import { AppChrome } from './ui/AppChrome.js'
import { SsoCallbackPage } from './pages/SsoCallbackPage.js'
import { MyDayPage } from './pages/MyDayPage.js'
import { TasksPage } from './pages/TasksPage.js'
import { ShoppingPage } from './pages/ShoppingPage.js'
import { EventsPage } from './pages/EventsPage.js'
import { BrainDumpPage } from './pages/BrainDumpPage.js'
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
      {/* Upcoming folded into the single My Day agenda; old links land there. */}
      <Route path="/upcoming" element={<Navigate to="/me" replace />} />
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
      {/* Chores folded into the Tasks page (Tasks | Chores sub-view). */}
      <Route path="/chores" element={<Navigate to="/tasks" replace />} />
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
      {/* Calendar folded into My Day (Agenda · Month · Week lens). */}
      <Route path="/calendar" element={<Navigate to="/me" replace />} />
      {/* Notes + Diary merged into the single Brain Dump surface; old links
          land there and legacy entries appear in its merged stream. */}
      <Route path="/notes" element={<Navigate to="/braindump" replace />} />
      <Route path="/diary" element={<Navigate to="/braindump" replace />} />
      <Route
        path="/braindump"
        element={
          <RequireSession>
            {() => (
              <AppChrome>
                <BrainDumpPage />
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
