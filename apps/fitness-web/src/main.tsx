import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { detectStandalone, registerThemePersister } from '@rallypoint/ui'
import { initAnalytics, initBootWatchdog } from '@rallypoint/web-kit'
import { App } from './App.js'
import { updateSettings } from './lib/api.js'
import { bootOfflineUser } from './lib/offline/cache.js'
import { registerWeightUnitPersister } from './lib/units.js'
import { registerDefaultRestPersister } from './lib/rest-settings.js'
import { registerDefaultRepsPersister, registerDefaultSetsPersister } from './lib/set-defaults.js'
import { registerRestAlertsPersister } from './lib/alert-settings.js'
import { registerDayTypesPersister } from './lib/day-type-settings.js'
import { registerCalorieGoalPersister } from './lib/calorie-goal.js'
import './index.css'

// Bootstrap analytics (no-op when VITE_POSTHOG_KEY is unset).
initAnalytics('rallypoint-fitness-web')

// Detect a previous launch that never booted (white-screened standalone
// PWA) and self-heal: activate a waiting SW, or nuke SW + caches on a
// repeat failure. AppChrome marks success via bootSucceeded().
initBootWatchdog()

// Rehydrate the last signed-in user from localStorage so the per-user
// offline DB (cached SessionDto included) is reachable before the
// session probe resolves — this is what makes the instant boot instant.
bootOfflineUser()

// Tag standalone PWA mode pre-React so the theme's
// `html[data-pwa-standalone='true'] .app-tabbar` rules apply from first paint.
if (detectStandalone()) document.documentElement.dataset.pwaStandalone = 'true'

// Persist theme changes into the shared cross-app settings bag (debounced
// in the store). Hydration happens in getSession via hydrateThemeFromServer,
// which suppresses this persister so applying the server value doesn't echo
// a write back. Fire-and-forget — a failed write must never break the UI.
registerThemePersister(({ mode, color }) => {
  void updateSettings('shared', { themeMode: mode, themeColor: color })
})

// Same write-through for the fitness-scoped weight-unit preference
// (namespace 'fitness'; hydrated in getSession via
// hydrateWeightUnitFromServer, which suppresses this persister).
registerWeightUnitPersister((unit) => {
  void updateSettings('fitness', { weightUnit: unit })
})

// …and for the default rest-time preference (same namespace + flow).
registerDefaultRestPersister((restS) => {
  void updateSettings('fitness', { defaultRestS: restS })
})

// …and the default sets × reps for exercises added to a strength workout.
registerDefaultSetsPersister((defaultSets) => {
  void updateSettings('fitness', { defaultSets })
})
registerDefaultRepsPersister((defaultReps) => {
  void updateSettings('fitness', { defaultReps })
})

// …and the rest-alert mode (beeps / notifications).
registerRestAlertsPersister((mode) => {
  void updateSettings('fitness', { restAlerts: mode })
})

// …and the weekly-rhythm per-weekday workout-type assignment.
registerDayTypesPersister((dayTypes) => {
  void updateSettings('fitness', { dayTypes })
})

// …and the daily calorie goal (kcal; null clears the goal).
registerCalorieGoalPersister((calorieGoalKcal) => {
  void updateSettings('fitness', { calorieGoalKcal })
})

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root missing from index.html')

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
