import { createRequireSession } from '@rallypoint/web-kit'
import { session } from '../lib/session.js'

// Auth gate for the events session-scoped routes, bound to the events
// session instance. The render-prop contract `{(userId) => …}` and the
// minimalist loading/redirect/error states live in @rallypoint/web-kit.
export const RequireSession = createRequireSession(session)

export type { RequireSessionProps } from '@rallypoint/web-kit'
