// "Strength session" from the quick-add FAB: immediately start a BLANK
// live session — no composer detour, no name, no pre-picked exercises.
// The athlete adds exercises mid-session via the live page's
// AddBlockSheet. Seeds the same localStorage slot the composer's
// "Start now" uses, so the live page's normal hydration picks it up.

import {
  buildStrengthSession,
  strengthSessionReducer,
} from '@rallypoint/fitness-shared'
import {
  newLiveSessionId,
  peekResumableStrengthSession,
  writeStrengthSession,
} from './live-session-keys.js'

/** Seed a running blank session into the strength slot (unless a
 *  resumable session already occupies it — never clobber in-flight
 *  work; the live page resumes it instead). Returns the path to
 *  navigate to either way. */
export function seedFreeStrengthSession(defaultRestS: number): string {
  if (peekResumableStrengthSession(Date.now()) == null) {
    const fresh = buildStrengthSession({
      sessionId: newLiveSessionId(),
      templateName: 'Free strength',
      blocks: [],
      defaultRestS,
    })
    // START immediately — the live page has no start affordance; a
    // 'pre' session would render a dead clock (see the templateId flow).
    writeStrengthSession(strengthSessionReducer(fresh, { kind: 'START', nowMs: Date.now() }))
  }
  return '/live/strength/new'
}
