// Per-run unique event identity. The events table has a (tenant, slug)
// unique constraint and the suite runs against a shared, persistent dev
// DB — reusing a fixed slug would collide on the second run. A timestamp
// + random suffix keeps every created event distinct and kebab-valid
// (eventSlugField: kebab, 1–50 chars).

export function uniqueEvent(): { name: string; slug: string } {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return {
    name: `E2E Event ${stamp}`,
    slug: `e2e-${stamp}`,
  }
}

// Per-run unique Planner identities. The Planner sweep runs against the same
// shared dev DB, and personal task lists / events accumulate across runs, so
// every list / task / event carries a fresh stamp to keep assertions
// unambiguous (a `getByText(name)` can never match a leftover from a prior run).
export function uniquePlanner(): { listName: string; taskTitle: string; eventName: string } {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return {
    listName: `E2E List ${stamp}`,
    taskTitle: `E2E Task ${stamp}`,
    eventName: `E2E Plan Event ${stamp}`,
  }
}

// Today at noon, local time, formatted for a datetime-local input
// ("YYYY-MM-DDTHH:mm"). Noon keeps the instant safely inside the local day's
// My Day / Upcoming window regardless of the runner's timezone.
export function todayAtNoonLocal(): string {
  const n = new Date()
  const y = n.getFullYear()
  const m = String(n.getMonth() + 1).padStart(2, '0')
  const d = String(n.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}T12:00`
}
