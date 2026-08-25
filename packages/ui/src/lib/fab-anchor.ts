/**
 * `pickFabAnchor(routeKey)` — decide where a `<Fab>` should sit on a
 * given route. The Ink design kit places the FAB at one bottom-right
 * anchor: it attaches to a `<SubBar>` when the route has section
 * switching (My Day Agenda/Week/Month, Tasks Tasks/Chores, Shopping, Notes,
 * Events Attendee Social DMs/Groups/Feed) and floats standalone when
 * the route doesn't (Diary, Settings).
 *
 * Pure (no DOM, no React) so callers can route-decide ahead of render.
 *
 * Treat the input as the route's *page key* — a string that names the
 * top-level page (`myday`, `tasks`, `shopping`, `notes`, `diary`,
 * `settings`, `now`, `lineup`, `group`, `rallies`, `social`). Unknown
 * keys default to `'float'` (the safer behavior — a standalone FAB
 * never overlays content).
 */

export type FabAnchor = 'subbar' | 'float'

/**
 * Routes that present an `.rp-subbar` for in-tab section switching.
 * Adding a route here makes the FAB attach to that page's sub-bar.
 * Keep this list narrow — only routes that *actually render* a SubBar.
 */
const SUBBAR_ROUTES = new Set<string>([
  // Planner
  'myday',
  'tasks',
  'shopping',
  'notes',
  // Events Attendee
  'social',
  'group',
])

export function pickFabAnchor(routeKey: string | null | undefined): FabAnchor {
  if (!routeKey) return 'float'
  return SUBBAR_ROUTES.has(routeKey) ? 'subbar' : 'float'
}
