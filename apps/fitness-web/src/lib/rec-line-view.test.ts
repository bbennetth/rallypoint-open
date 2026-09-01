import { describe, expect, it } from 'vitest'
import { canApplySuggestion, recLineView } from './rec-line-view.js'

function applySet(
  overrides: Partial<Parameters<typeof canApplySuggestion>[0]['sets'][number]> = {},
) {
  return {
    reps: 5 as number | null,
    calories: null,
    distanceM: null,
    timeS: null,
    loadKg: null as number | null,
    done: false,
    setType: 'working' as const,
    ...overrides,
  }
}

describe('canApplySuggestion', () => {
  it('true only while an undone working rep set would change', () => {
    expect(canApplySuggestion({ sets: [applySet()] }, 100)).toBe(true)
    expect(canApplySuggestion({ sets: [applySet({ loadKg: 90 })] }, 100)).toBe(true)
    // Every fillable set already carries the suggestion (post-press).
    expect(canApplySuggestion({ sets: [applySet({ loadKg: 100 })] }, 100)).toBe(false)
    expect(canApplySuggestion({ sets: [applySet({ done: true })] }, 100)).toBe(false)
    expect(canApplySuggestion({ sets: [applySet({ setType: 'warmup' })] }, 100)).toBe(false)
    expect(
      canApplySuggestion({ sets: [applySet({ reps: null, timeS: 60, unit: 'timeS' })] }, 100),
    ).toBe(false)
  })
})

function block(overrides: Partial<Parameters<typeof recLineView>[0]> = {}) {
  return {
    suggestedKg: 100 as number | null,
    suggestedBasis: 'last 97.5' as string | null,
    suggestedLastKg: 97.5 as number | null,
    suggestedBumpKg: null as number | null,
    ...overrides,
  }
}

describe('recLineView', () => {
  it('returns null without a suggestion', () => {
    expect(recLineView(block({ suggestedKg: null }), 'kg')).toBeNull()
  })

  it('renders kg: formatted suggestion + bare-number basis', () => {
    expect(recLineView(block(), 'kg')).toEqual({
      shown: '100 kg',
      applyKg: 100,
      basis: 'last 97.5',
    })
  })

  it('renders lb: basis numbers converted, no unit repetition', () => {
    const v = recLineView(block(), 'lb')
    expect(v).toEqual({ shown: '220 lb', applyKg: 99.79, basis: 'last 215' })
  })

  it('snaps the shown load to 5s in lb (and applyKg matches the shown number)', () => {
    // 44.9 kg ≈ 98.99 lb — the kg-plate-rounded recommender would show
    // "99 lb"; the strip must show 100 and apply the kg that displays
    // as exactly 100.
    const v = recLineView(block({ suggestedKg: 44.9 }), 'lb')!
    expect(v.shown).toBe('100 lb')
    expect(v.applyKg).toBe(45.36)
    // 42.5 kg ≈ 93.7 lb → 95, not 94.
    expect(recLineView(block({ suggestedKg: 42.5 }), 'lb')!.shown).toBe('95 lb')
  })

  it('snaps to 2.5s in kg', () => {
    const v = recLineView(block({ suggestedKg: 101.4 }), 'kg')!
    expect(v.shown).toBe('102.5 kg')
    expect(v.applyKg).toBe(102.5)
  })

  it('shows the bump as the display-value difference, not an independent conversion', () => {
    // 97.5 → 215 lb, 100 → 220 lb: the bump reads +5, matching what the
    // athlete sees, not round(2.5 / KG_PER_LB) = +6.
    const v = recLineView(block({ suggestedBumpKg: 2.5 }), 'lb')
    expect(v!.basis).toBe('last 215 +5')
    expect(recLineView(block({ suggestedBumpKg: 2.5 }), 'kg')!.basis).toBe('last 97.5 +2.5')
  })

  it('drops the bump when the snap lands back on the last weight', () => {
    // last 43.09 kg (95 lb) + 2.5 kg bump → the recommender's blend can
    // still snap to 95 lb; "95 lb · last 95 +5" would advertise a bump
    // the headline doesn't carry.
    const v = recLineView(
      block({ suggestedKg: 43.5, suggestedLastKg: 43.09, suggestedBumpKg: 2.5 }),
      'lb',
    )!
    expect(v.shown).toBe('95 lb')
    expect(v.basis).toBe('last 95')
  })

  it('drops the bump when the snap lands BELOW the last weight', () => {
    // last 43.55 kg displays as 96 lb; suggestion 44.16 kg snaps to
    // 95 lb — under last, so no "+N" either.
    const v = recLineView(
      block({ suggestedKg: 44.16, suggestedLastKg: 43.55, suggestedBumpKg: 2.5 }),
      'lb',
    )!
    expect(v.shown).toBe('95 lb')
    expect(v.basis).toBe('last 96')
  })

  it('drops a bump that rounds to nothing in the display unit', () => {
    // 97.5 and 97.6 kg both display as 215 lb, so no "+0" noise.
    const v = recLineView(block({ suggestedBumpKg: 0.1 }), 'lb')
    expect(v!.basis).toBe('last 215')
  })

  it('falls back to the kg basis string when structured fields are absent (old snapshots)', () => {
    const v = recLineView(block({ suggestedLastKg: null }), 'lb')
    expect(v!.basis).toBe('last 97.5')
  })

  it('stays visible whenever a suggestion exists — no duplicate-hide', () => {
    // With rows prefilling to last-session values, suggestion ≈ current
    // load is the COMMON case; the old duplicate-hide rule made the
    // strip (and its Use button) read as "no suggestion". The view no
    // longer looks at the sets at all.
    expect(recLineView(block(), 'kg')).not.toBeNull()
  })

  it('never snaps down to a 0 suggestion', () => {
    expect(recLineView(block({ suggestedKg: 0.8 }), 'lb')!.shown).toBe('5 lb')
    expect(recLineView(block({ suggestedKg: 0.8 }), 'kg')!.shown).toBe('2.5 kg')
  })
})
