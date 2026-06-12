// Cross-target pure logic for Rallypoint Events. Mirrors
// rallypoint-id's @rallypoint/shared in role: validators,
// permission checks, and other framework-agnostic helpers that
// both apps/events-api (server) and apps/events-web (browser) must
// agree on.
//
// Slice 2 lands the first cross-target schemas (event CRUD +
// invite + transfer validators); later slices add the events-side
// logic (lineup, sessions, groups, map). The festival-planner
// group-planning modules (taskLogic, mealCascade, purchaseLogic, …)
// are NOT ported here — planning lives in a separate app per the
// events-v1 §2 2026-05-28 amendment.

export * from './validators.js'
export * from './ticket-platforms.js'
export * from './slug.js'
export * from './group-validators.js'
export * from './rally-validators.js'
export * from './chat-validators.js'
export * from './schedule-logic.js'
export * from './conflict-resolver.js'
export * from './map-constraints.js'
export * from './ticket-constraints.js'
export * from './event-features.js'
export * from './join-codes.js'
export * from './poi-categories.js'
export * from './poi-geometry.js'
export * from './now-selection.js'
export * from './day-generation.js'
