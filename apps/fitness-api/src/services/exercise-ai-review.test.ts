import { describe, expect, it } from 'vitest'
import { normalizeProposedMuscles, sameMuscleMap, SYSTEM_PROMPT } from './exercise-ai-review.js'

// The result-recovery suite (object / JSON-string / prose-wrapped /
// choices / description / failure shapes) moved to
// packages/ai/src/result.test.ts as recoverJsonPayload when the review
// switched onto @rallypoint/ai's shared pipeline.

describe('SYSTEM_PROMPT', () => {
  // Regression lock for the 2026-08-02 QA outage: the serving backend
  // behind the model alias stopped honoring the vLLM `guided_json`
  // passthrough, and this was the one prompt that relied on it alone —
  // no textual JSON instruction, so the model returned prose and every
  // review came back {outcome:'invalid'}. The prompt must always demand
  // the JSON object in text, like the vision prompts do.
  it('textually demands the JSON reply shape (never rely on guided_json alone)', () => {
    expect(SYSTEM_PROMPT).toContain('Reply with ONLY this JSON object')
    expect(SYSTEM_PROMPT).toContain('"muscles"')
    expect(SYSTEM_PROMPT).toContain('"muscleId"')
    expect(SYSTEM_PROMPT).toContain('"role"')
    expect(SYSTEM_PROMPT).toContain('"rationale"')
  })
})

describe('normalizeProposedMuscles', () => {
  it('keeps valid entries and sorts by muscleId', () => {
    expect(
      normalizeProposedMuscles([
        { muscleId: 'triceps', role: 'secondary' },
        { muscleId: 'chest', role: 'primary' },
      ]),
    ).toEqual([
      { muscleId: 'chest', role: 'primary' },
      { muscleId: 'triceps', role: 'secondary' },
    ])
  })

  it('drops unknown ids (incl. retired pre-0030 slugs) and unknown roles', () => {
    expect(
      normalizeProposedMuscles([
        { muscleId: 'front_delt', role: 'primary' },
        { muscleId: 'pecs', role: 'primary' },
        { muscleId: 'lats', role: 'mega' },
        { muscleId: 'lats', role: 'primary' },
      ]),
    ).toEqual([{ muscleId: 'lats', role: 'primary' }])
  })

  it('dedupes by muscleId keeping the strongest role', () => {
    expect(
      normalizeProposedMuscles([
        { muscleId: 'glutes', role: 'stabilizer' },
        { muscleId: 'glutes', role: 'primary' },
        { muscleId: 'glutes', role: 'secondary' },
      ]),
    ).toEqual([{ muscleId: 'glutes', role: 'primary' }])
  })

  it('returns [] for non-array / malformed input', () => {
    expect(normalizeProposedMuscles(undefined)).toEqual([])
    expect(normalizeProposedMuscles('lats')).toEqual([])
    expect(normalizeProposedMuscles([null, 42, { role: 'primary' }])).toEqual([])
  })
})

describe('sameMuscleMap', () => {
  it('is order-insensitive', () => {
    expect(
      sameMuscleMap(
        [
          { muscleId: 'lats', role: 'primary' },
          { muscleId: 'biceps', role: 'secondary' },
        ],
        [
          { muscleId: 'biceps', role: 'secondary' },
          { muscleId: 'lats', role: 'primary' },
        ],
      ),
    ).toBe(true)
  })

  it('differs on role or membership changes', () => {
    expect(
      sameMuscleMap([{ muscleId: 'lats', role: 'primary' }], [{ muscleId: 'lats', role: 'secondary' }]),
    ).toBe(false)
    expect(sameMuscleMap([{ muscleId: 'lats', role: 'primary' }], [])).toBe(false)
  })
})
