import type { ReactNode } from 'react'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { RequireSession } from './ui/RequireSession.js'
import { AppChrome } from './ui/AppChrome.js'
import { SsoCallbackPage } from './pages/SsoCallbackPage.js'
import { LogPage } from './pages/LogPage.js'
import { FoodPage } from './pages/FoodPage.js'
import { MealPrepPage } from './pages/MealPrepPage.js'
import { MealPrepDetailPage } from './pages/MealPrepDetailPage.js'
import { RecipesPage } from './pages/RecipesPage.js'
import { RecipeDetailPage } from './pages/RecipeDetailPage.js'
import { PlanPage } from './pages/PlanPage.js'
import { LibraryPage } from './pages/LibraryPage.js'
import { StatsPage } from './pages/StatsPage.js'
import { ProgressPhotosPage } from './pages/ProgressPhotosPage.js'
import { ComposerPage } from './pages/ComposerPage.js'
import { RunLogPage } from './pages/RunLogPage.js'
import { WodLibraryPage } from './pages/WodLibraryPage.js'
import { LiveSessionPage } from './pages/LiveSessionPage.js'
import { SettingsPage } from './pages/SettingsPage.js'

// Route table per the Ink redesign (design handoff 2026-06-26):
//   /log        the home tab (Today + History)
//   /plan       multi-plan + DnD weekly schedule (S7)
//   /library    exercise catalog + star/save
//   /library/wods  WOD template browser (sub-route)
//   /stats      Training default; /stats/body for the Body sub-view (S5)
//   /composer   workout builder + photo OCR (S8/S9)
//   /live/wod/:id      WOD live session
//   /live/strength/new strength live session (S10)
//
// Old `/me/*` paths and the apex `/` are kept as <Navigate replace>
// redirects so existing bookmarks keep working.

function gated(el: ReactNode) {
  return (
    <RequireSession>
      {(_userId) => <AppChrome>{el}</AppChrome>}
    </RequireSession>
  )
}

// Preserve the :id segment when redirecting the old run path.
function RedirectLiveWod() {
  const { id } = useParams()
  return <Navigate to={`/live/wod/${id ?? ''}/run`} replace />
}

export function App() {
  return (
    <Routes>
      {/* Apex + legacy /me bounces — keep these so old bookmarks resolve. */}
      <Route path="/" element={<Navigate to="/log" replace />} />
      <Route path="/me" element={<Navigate to="/log" replace />} />
      <Route path="/me/log" element={<Navigate to="/log" replace />} />
      <Route path="/me/exercises" element={<Navigate to="/library" replace />} />
      <Route path="/me/wods" element={<Navigate to="/library/wods" replace />} />
      <Route path="/me/wods/:id/run" element={<RedirectLiveWod />} />
      <Route path="/me/metrics" element={<Navigate to="/stats/body" replace />} />
      <Route path="/me/insights" element={<Navigate to="/stats" replace />} />

      <Route path="/sso/callback" element={<SsoCallbackPage />} />

      {/* Log tab. /log/history shares the same page; the history sub-view is
          selected from the docked SubBar (rendered inside LogPage). */}
      <Route path="/log" element={gated(<LogPage />)} />
      <Route path="/log/history" element={gated(<LogPage />)} />

      {/* Food tab (issue #700): daily food diary + barcode / AI photo scan. */}
      <Route path="/food" element={gated(<FoodPage />)} />

      {/* Meal-prep tool: cook a meal from scanned ingredients, log it down
          until it's gone, and save recipes. Reached from a card on the Food
          tab (own routes, not a bottom-nav tab). */}
      <Route path="/food/prep" element={gated(<MealPrepPage />)} />
      <Route path="/food/prep/:id" element={gated(<MealPrepDetailPage />)} />
      <Route path="/food/recipes" element={gated(<RecipesPage />)} />
      <Route path="/food/recipes/:id" element={gated(<RecipeDetailPage />)} />

      {/* Plan tab. /plan = This Week (current-week calendar view);
          /plan/plans = My Plans (long-term plan list + length chips). */}
      <Route path="/plan" element={gated(<PlanPage />)} />
      <Route path="/plan/plans" element={gated(<PlanPage />)} />
      {/* Pinned schedule editor for a specific (not-necessarily-active)
          plan, entered from My Plans → "Edit schedule". */}
      <Route path="/plan/plans/:planId" element={gated(<PlanPage />)} />

      {/* Library tab. /library = All exercises; /library/saved = the
          starred subset; /library/wods is the WOD template browser. */}
      <Route path="/library" element={gated(<LibraryPage />)} />
      <Route path="/library/saved" element={gated(<LibraryPage />)} />
      <Route path="/library/wods" element={gated(<WodLibraryPage />)} />

      {/* Stats tab. /stats defaults to Training; /stats/body is the Body
          sub-view. The page itself owns the SubBar that picks between
          them (StatsPage branches by pathname). */}
      <Route path="/stats" element={gated(<StatsPage />)} />
      <Route path="/stats/body" element={gated(<StatsPage />)} />
      {/* Calorie dashboard sub-view (actual vs goal). */}
      <Route path="/stats/food" element={gated(<StatsPage />)} />
      {/* Full progress-picture gallery, reached from the Body view's
          PROGRESS PICTURES card (own route, not a third SubBar segment). */}
      <Route path="/stats/photos" element={gated(<ProgressPhotosPage />)} />

      {/* Settings — reached from the app-switcher flyout's Settings row. */}
      <Route path="/settings" element={gated(<SettingsPage />)} />

      {/* Composer (S8) and live sessions (S10/S11). */}
      <Route path="/composer" element={gated(<ComposerPage />)} />
      <Route path="/composer/:id" element={gated(<ComposerPage />)} />
      {/* Standalone run quick-log (outside the composer). Optional
          ?planId=&planItemId=&note= prefills + clears a scheduled run. */}
      <Route path="/run/log" element={gated(<RunLogPage />)} />
      <Route path="/live/wod/:id/run" element={gated(<LiveSessionPage />)} />
      <Route path="/live/strength/new" element={gated(<LiveSessionPage />)} />

      {/* Unknown deep links land on the home tab — short-circuit
          straight to `/log` so the browser history only records one
          replace-navigation, not the `*` → `/` → `/log` double hop. */}
      <Route path="*" element={<Navigate to="/log" replace />} />
    </Routes>
  )
}
