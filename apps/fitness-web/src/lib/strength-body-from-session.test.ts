import { describe, expect, it } from 'vitest'
import { buildStrengthSession } from '@rallypoint/fitness-shared'
import { strengthBodyFromSession } from './strength-body-from-session.js'

function session() {
  return buildStrengthSession({
    sessionId: 'sess_1',
    templateName: 'Lower A',
    blocks: [
      {
        exerciseId: 'fx_seed_back_squat',
        name: 'Back Squat',
        suggestedKg: null,
        suggestedBasis: null,
        sets: [
          { reps: 5, calories: null, distanceM: null, timeS: null, inclinePct: null, loadKg: 100, done: true, doneAtMs: 1, setType: 'working' as const },
          // Bodyweight zero load must survive (F11), not be dropped.
          { reps: 8, calories: null, distanceM: null, timeS: null, inclinePct: null, loadKg: 0, done: false, doneAtMs: null, setType: 'working' as const },
          // No positive amount in any unit → dropped, never fabricated.
          { reps: null, calories: null, distanceM: null, timeS: null, inclinePct: null, loadKg: 60, done: false, doneAtMs: null, setType: 'working' as const },
        ],
      },
      {
        exerciseId: 'fx_seed_row_erg',
        name: 'Row',
        suggestedKg: null,
        suggestedBasis: null,
        sets: [
          // Non-rep work carries exactly its one unit, no load.
          { reps: null, calories: 15, distanceM: null, timeS: null, inclinePct: null, loadKg: null, done: true, doneAtMs: 2, setType: 'working' as const },
        ],
      },
    ],
  })
}

describe('strengthBodyFromSession', () => {
  it('maps blocks to template targets with the F11 filtering rules', () => {
    const body = strengthBodyFromSession(session())
    expect(body).toEqual({
      kind: 'strength',
      blocks: [
        {
          exerciseId: 'fx_seed_back_squat',
          name: 'Back Squat',
          sets: [
            { reps: 5, loadKg: 100 },
            { reps: 8, loadKg: 0 },
          ],
        },
        {
          exerciseId: 'fx_seed_row_erg',
          name: 'Row',
          sets: [{ calories: 15 }],
        },
      ],
    })
  })

  it('includes undone sets — the plan, not just what got finished', () => {
    const body = strengthBodyFromSession(session())
    // Set 2 of block 1 was not done but still lands in the template.
    expect(body.blocks[0]!.sets).toHaveLength(2)
  })
})
