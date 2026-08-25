import { Navigate, Route, Routes } from 'react-router-dom'
import { RequireSession } from './ui/RequireSession.js'
import { AppChrome } from './ui/AppChrome.js'
import { EventOwnerLayout } from './ui/EventOwnerLayout.js'
import { SsoCallbackPage } from './pages/SsoCallbackPage.js'
import { MyEventsPage } from './pages/MyEventsPage.js'
import { BrowsePage } from './pages/BrowsePage.js'
import { EventPreviewPage } from './pages/EventPreviewPage.js'
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
import { GroupCreatePage } from './pages/GroupCreatePage.js'
import { RalliesPage } from './pages/RalliesPage.js'
import { GroupMapPage } from './pages/GroupMapPage.js'
import { PublicEventPage } from './pages/PublicEventPage.js'
import { NowPage } from './pages/NowPage.js'
import { AttendeeLayout } from './ui/AttendeeChrome.js'
import { AttendingLandingPage } from './pages/attendee/AttendingLandingPage.js'
import { SoloAttendeeLayout } from './ui/SoloAttendeeChrome.js'
import { SoloNowPage } from './pages/attendee/SoloNowPage.js'
import { SoloDayRedirect, GroupDayRedirect } from './pages/attendee/redirects.js'
import { AttendeeGroupsPage } from './pages/attendee/AttendeeGroupsPage.js'
import { SoloRalliesEmptyPage } from './pages/attendee/SoloRalliesEmptyPage.js'
import { SoloMapPage } from './pages/attendee/SoloMapPage.js'
import { SoloLineupPage } from './pages/attendee/SoloLineupPage.js'
import { GroupLineupPage } from './pages/attendee/GroupLineupPage.js'

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
      {/* Browse tab (#browse-tab): top-level /browse prefix, deliberately
          NOT under /events/ so it can't collide with the :slug tree. */}
      <Route
        path="/browse"
        element={
          <RequireSession>
            {() => (
              <AppChrome>
                <BrowsePage />
              </AppChrome>
            )}
          </RequireSession>
        }
      />
      <Route
        path="/browse/:slug"
        element={
          <RequireSession>
            {() => (
              <AppChrome>
                <EventPreviewPage />
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
      {/* Phase 4 (platform/v-1.1, #16): attendee landing + event shell.
          A viewer-role invite-accept lands at /events/:slug/attend
          (the decision page). "Continue solo" routes to
          /events/:slug/attending/*, whose Group tab lists every group
          the viewer belongs to here and links into /groups/:groupId/*
          on AttendeeChrome; Rallies stays group-coupled and
          renders an empty-state CTA. Entry points choose between the two
          shells via attendeeHomeHref (lib/attendee-route.ts). */}
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
        <Route path="day" element={<SoloDayRedirect />} />
        <Route path="lineup" element={<SoloLineupPage />} />
        <Route path="group" element={<AttendeeGroupsPage />} />
        <Route path="rallies" element={<SoloRalliesEmptyPage />} />
        <Route path="map" element={<SoloMapPage />} />
        {/* Social was dropped (map took its slot); installed-PWA
            shortcuts may still point at /chat. */}
        <Route path="chat" element={<Navigate to="../map" replace />} />
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
      {/* Start-a-group (the create half of "join or create"). Slug-scoped
          so the page knows which event the group belongs to. */}
      <Route
        path="/events/:slug/groups/new"
        element={
          <RequireSession>
            {() => (
              <AppChrome>
                <GroupCreatePage />
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
        <Route path="lineup" element={<GroupLineupPage />} />
        <Route path="rallies" element={<RalliesPage />} />
        <Route path="map" element={<GroupMapPage />} />
        <Route path="day" element={<GroupDayRedirect />} />
        {/* Social was dropped (map took its slot); installed-PWA
            shortcuts may still point at /chat. */}
        <Route path="chat" element={<Navigate to="../map" replace />} />
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
