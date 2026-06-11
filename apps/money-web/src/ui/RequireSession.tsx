import { createRequireSession } from '@rallypoint/web-kit'
import { session } from '../lib/session.js'

// Auth gate for the money session-scoped routes, bound to the money
// session instance. The render-prop contract `{(userId) => …}` and the
// Ink-themed loading/redirect/error states live in @rallypoint/web-kit.
export const RequireSession = createRequireSession(session)

export type { RequireSessionProps } from '@rallypoint/web-kit'
