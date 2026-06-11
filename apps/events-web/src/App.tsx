import { Navigate, Route, Routes } from 'react-router-dom'
import { RequireSession } from './ui/RequireSession.js'
import { AppChrome } from './ui/AppChrome.js'
import { EventOwnerLayout } from './ui/EventOwnerLayout.js'
import { SsoCallbackPage } from './pages/SsoCallbackPage.js'
import { MyEventsPage } from './pages/MyEventsPage.js'
import { EventsNewPage } from './pages/EventsNewPage.js'
import { EventJoinPage } from './pages/EventJoinPage.js'
import { OverviewPage } from './pages/owner/OverviewPage.js'
import { LineupPage } from './pages/owner/LineupPage.js'
import { SessionsPage } from './pages/owner/SessionsPage.js'
import { MapPage } from './pages/owner/MapPage.js'
import { AttendeesPage } from './pages/owner/AttendeesPage.js'
import { PublicPagePage } from './pages/owner/PublicPagePage.js'
import { TicketsPage } from './pages/owner/TicketsPage.js'
import { SettingsPage } from './pages/owner/SettingsPage.js'
import { PreviewPage } from './pages/owner/PreviewPage.js'
import { GroupDetailPage } from './pages/GroupDetailPage.js'
import { GroupJoinPage } from './pages/GroupJoinPage.js'
import { RalliesPage } from './pages/RalliesPage.js'
import { MyDayPage } from './pages/MyDayPage.js'
import { ChatPage } from './pages/ChatPage.js'
import { PublicEventPage } from './pages/PublicEventPage.js'
import { NowPage } from './pages/NowPage.js'
import { AttendeeLayout } from './ui/AttendeeChrome.js'
import { AttendingLandingPage } from './pages/attendee/AttendingLandingPage.js'
import { SoloAttendeeLayout } from './ui/SoloAttendeeChrome.js'
import { SoloNowPage } from './pages/attendee/SoloNowPage.js'
import { SoloMyDayPage } from './pages/attendee/SoloMyDayPage.js'
import { SoloGroupEmptyPage } from './pages/attendee/SoloGroupEmptyPage.js'
import { SoloRalliesEmptyPage } from './pages/attendee/SoloRalliesEmptyPage.js'
import { SoloChatEmptyPage } from './pages/attendee/SoloChatEmptyPage.js'
import { SoloLineupPage } from './pages/attendee/SoloLineupPage.js'

export function App() {
  return (
    <Routes>
      {/* The apex (rallypt.*) hosts the marketing/home page (#419); the
          subdomain root just bounces into the app. RequireSession on the
          gated home redirects unauthenticated visitors to RPID to sign in
          or create an account (auto sign-in when an RPID session exists). */}
      <Route path="/" element={<Navigate to="/me/events" replace />} />
      <Route path="/sso/callback" element={<SsoCallbackPage />} />
      <Route
        path="/me/events"
        element={
          <RequireSession>
            {() => (
              <AppChrome>
                <MyEventsPage />
              </AppChrome>
            )}
          </RequireSession>
        }
      />
      <Route
        path="/events/new"
        element={
          <RequireSession>
            {() => (
              <AppChrome>
                <EventsNewPage />
              </AppChrome>
            )}
          </RequireSession>
        }
      />
      <Route
        path="/events/join"
        element={
          <RequireSession>
            {() => (
              <AppChrome>
                <EventJoinPage />
              </AppChrome>
            )}
          </RequireSession>
        }
      />
      {/* Phase 2 (platform/v-1.1, #16): event-owner tab structure.
          The layout loads the event once and provides it to each tab
          via React Router's <Outlet context={…}>. The sidebar
          switches to event-scoped nav (`<AppChrome eventContext />`)
          for all `/events/:slug/*` paths. */}
      <Route
        path="/events/:slug"
        element={
          <RequireSession>
            {(userId) => <EventOwnerLayout userId={userId} />}
          </RequireSession>
        }
      >
        <Route index element={<OverviewPage />} />
        <Route path="lineup" element={<LineupPage />} />
        <Route path="sessions" element={<SessionsPage />} />
        <Route path="map" element={<MapPage />} />
        <Route path="attendees" element={<AttendeesPage />} />
        <Route path="public" element={<PublicPagePage />} />
        <Route path="tickets" element={<TicketsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="preview" element={<PreviewPage />} />
      </Route>
      {/* Phase 4 (platform/v-1.1, #16): solo-attendee landing + shell.
          A viewer-role invite-accept lands at /events/:slug/attend
          (the decision page). "Continue solo" routes to
          /events/:slug/attending/* (a 5-tab shell where group-coupled
          tabs render empty-state CTAs). Joining a group later flips
          the user over to /groups/:groupId/* on AttendeeChrome. */}
      <Route
        path="/events/:slug/attend"
        element={
          <RequireSession>
            {() => (
              <AppChrome>
                <AttendingLandingPage />
              </AppChrome>
            )}
          </RequireSession>
        }
      />
      <Route
        path="/events/:slug/attending"
        element={
          <RequireSession>
            {() => <SoloAttendeeLayout />}
          </RequireSession>
        }
      >
        <Route index element={<Navigate to="now" replace />} />
        <Route path="now" element={<SoloNowPage />} />
        <Route path="day" element={<SoloMyDayPage />} />
        <Route path="lineup" element={<SoloLineupPage />} />
        <Route path="group" element={<SoloGroupEmptyPage />} />
        <Route path="rallies" element={<SoloRalliesEmptyPage />} />
        <Route path="chat" element={<SoloChatEmptyPage />} />
      </Route>
      <Route
        path="/groups/join"
        element={
          <RequireSession>
            {() => (
              <AppChrome>
                <GroupJoinPage />
              </AppChrome>
            )}
          </RequireSession>
        }
      />
      {/* Attendee shell (slice 13, refactored #158). /groups/:groupId/*
          routes share one mount of the chrome — the layout-route
          pattern lets nested tabs paint into <Outlet /> without
          unmounting AttendeeLayout (and re-opening the SSE) on every
          nav. Owner/management routes stay on AppChrome (the only
          thing they share is the brand lockup + theme toggle).
          Pages that need userId read it via useAttendeeOutlet(). */}
      <Route
        path="/groups/:groupId"
        element={
          <RequireSession>
            {(userId) => <AttendeeLayout userId={userId} />}
          </RequireSession>
        }
      >
        <Route index element={<GroupDetailPage />} />
        <Route path="now" element={<NowPage />} />
        <Route path="rallies" element={<RalliesPage />} />
        <Route path="day" element={<MyDayPage />} />
        <Route path="chat" element={<ChatPage />} />
      </Route>
      {/* Public event page (slice 11). Lives outside any RequireSession
          wrap — anonymous visitors see the page directly. Crawler hits
          to /e/:slug are answered by events-api's OG-templated SPA
          shell (routes/public-html.ts) via the Caddy edge in prod. */}
      <Route path="/e/:slug" element={<PublicEventPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
