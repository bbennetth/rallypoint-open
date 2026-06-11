import { createRequireSession } from '@rallypoint/web-kit'
import { session } from '../lib/session.js'

// Auth gate for the planner session-scoped routes, bound to the planner
// session instance. The render-prop contract `{(userId) => …}` and the
// Ink-themed loading/redirect/error states live in @rallypoint/web-kit.
export const RequireSession = createRequireSession(session)

export type { RequireSessionProps } from '@rallypoint/web-kit'
