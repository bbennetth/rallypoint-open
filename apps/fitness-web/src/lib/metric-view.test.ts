// Unit tests for metric-view pure helpers. No DOM, no React, no network.
import { describe, it, expect } from 'vitest'
import type { MetricDto } from '@rallypoint/fitness-shared'
import { createMetricSchema } from '@rallypoint/fitness-shared'
import {
  groupMetricsByKind,
  buildKindCards,
  cardForWeightUnit,
  deltaDirection,
  formatDelta,
  formatValue,
  kindLabel,
  kindUnit,
  buildMetricPayload,
  buildMetricLogPayload,
  metricEntryDisplayUnit,
  bodyweightTileVm,
  formatMetricDate,
  isoToDatetimeLocal,
  datetimeLocalToIso,
  nearestMetricTo,
} from './metric-view.js'
import { displayToKg, kgToDisplay } from './units.js'

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeMetric(required: { kind: string; value: number; recordedAt: string } & Partial<MetricDto>): MetricDto {
  const { kind, value, recordedAt, ...rest } = required
  return {
    id: 'mid1',
    kind,
    value,
    recordedAt,
    unit: null,
    note: null,
    createdAt: recordedAt,
    ...rest,
  }
}

// ── groupMetricsByKind ────────────────────────────────────────────────────────

describe('groupMetricsByKind', () => {
  it('returns empty map for empty input', () => {
    expect(groupMetricsByKind([])).toEqual(new Map())
  })

  it('groups metrics by kind', () => {
    const metrics = [
      makeMetric({ kind: 'bodyweight', value: 80, recordedAt: '2026-06-20T08:00:00.000Z' }),
      makeMetric({ kind: 'sleep', value: 7.5, recordedAt: '2026-06-20T08:00:00.000Z' }),
      makeMetric({ kind: 'bodyweight', value: 79.5, recordedAt: '2026-06-21T08:00:00.000Z' }),
    ]
    const result = groupMetricsByKind(metrics)
    expect(result.size).toBe(2)
    expect(result.get('bodyweight')).toHaveLength(2)
    expect(result.get('sleep')).toHaveLength(1)
  })

  it('preserves first-seen order', () => {
    const metrics = [
      makeMetric({ kind: 'sleep', value: 7, recordedAt: '2026-06-20T08:00:00.000Z' }),
      makeMetric({ kind: 'bodyweight', value: 80, recordedAt: '2026-06-20T08:00:00.000Z' }),
    ]
    const result = groupMetricsByKind(metrics)
    const keys = [...result.keys()]
    expect(keys[0]).toBe('sleep')
    expect(keys[1]).toBe('bodyweight')
  })

  it('sorts each kind bucket newest-first', () => {
    const metrics = [
      makeMetric({ id: 'm1', kind: 'bodyweight', value: 80, recordedAt: '2026-06-20T08:00:00.000Z' }),
      makeMetric({ id: 'm2', kind: 'bodyweight', value: 79, recordedAt: '2026-06-22T08:00:00.000Z' }),
    ]
    const result = groupMetricsByKind(metrics)
    const bw = result.get('bodyweight')!
    expect(bw[0]!.id).toBe('m2') // 22 Jun is newer
    expect(bw[1]!.id).toBe('m1')
  })
})

// ── buildKindCards ────────────────────────────────────────────────────────────

describe('buildKindCards', () => {
  it('returns empty array for empty metrics', () => {
    expect(buildKindCards([])).toHaveLength(0)
  })

  it('produces one card per kind', () => {
    const metrics = [
      makeMetric({ kind: 'bodyweight', value: 80, recordedAt: '2026-06-20T08:00:00.000Z' }),
      makeMetric({ kind: 'sleep', value: 7, recordedAt: '2026-06-20T08:00:00.000Z' }),
    ]
    expect(buildKindCards(metrics)).toHaveLength(2)
  })

  it('uses known-kind label for bodyweight', () => {
    const metrics = [makeMetric({ kind: 'bodyweight', value: 80, recordedAt: '2026-06-20T08:00:00.000Z' })]
    const [card] = buildKindCards(metrics)
    expect(card!.label).toBe('Bodyweight')
    expect(card!.unit).toBe('kg')
  })

  it('falls back to raw slug for unknown kind', () => {
    const metrics = [makeMetric({ kind: 'my_custom_thing', value: 42, recordedAt: '2026-06-20T08:00:00.000Z' })]
    const [card] = buildKindCards(metrics)
    expect(card!.label).toBe('my_custom_thing')
  })

  it('sets latest value correctly', () => {
    const metrics = [
      makeMetric({ id: 'm2', kind: 'bodyweight', value: 79, recordedAt: '2026-06-22T08:00:00.000Z' }),
      makeMetric({ id: 'm1', kind: 'bodyweight', value: 80, recordedAt: '2026-06-20T08:00:00.000Z' }),
    ]
    const [card] = buildKindCards(metrics)
    expect(card!.latestValue).toBe(79) // newer
  })

  it('sparkPoints are sorted oldest-first', () => {
    const metrics = [
      makeMetric({ id: 'm2', kind: 'bodyweight', value: 79, recordedAt: '2026-06-22T08:00:00.000Z' }),
      makeMetric({ id: 'm1', kind: 'bodyweight', value: 80, recordedAt: '2026-06-20T08:00:00.000Z' }),
    ]
    const [card] = buildKindCards(metrics)
    expect(card!.sparkPoints[0]!.value).toBe(80) // oldest first
    expect(card!.sparkPoints[1]!.value).toBe(79)
  })

  it('sets deltaDirection to worse for bodyweight increase (betterWhenLower=false for bw)', () => {
    // bodyweight has no betterWhenLower, so increase is 'better'
    const metrics = [
      makeMetric({ id: 'm1', kind: 'bodyweight', value: 78, recordedAt: '2026-06-20T08:00:00.000Z' }),
      makeMetric({ id: 'm2', kind: 'bodyweight', value: 82, recordedAt: '2026-06-22T08:00:00.000Z' }),
    ]
    const [card] = buildKindCards(metrics)
    // bodyweight has no betterWhenLower, positive delta → 'better'
    expect(card!.deltaDirection).toBe('better')
  })

  it('sets deltaDirection to better for resting_hr decrease (betterWhenLower=true)', () => {
    const metrics = [
      makeMetric({ id: 'm1', kind: 'resting_hr', value: 70, recordedAt: '2026-06-20T08:00:00.000Z' }),
      makeMetric({ id: 'm2', kind: 'resting_hr', value: 65, recordedAt: '2026-06-22T08:00:00.000Z' }),
    ]
    const [card] = buildKindCards(metrics)
    // delta = 65 - 70 = -5, betterWhenLower, negative → 'better'
    expect(card!.deltaDirection).toBe('better')
  })
})

// ── cardForWeightUnit ─────────────────────────────────────────────────────────

describe('cardForWeightUnit', () => {
  function bodyweightCard(values: [string, number][]) {
    return buildKindCards(
      values.map(([recordedAt, value], i) =>
        makeMetric({ id: `m${i}`, kind: 'bodyweight', value, recordedAt }),
      ),
    )[0]!
  }

  it('passes through unchanged for kg preference', () => {
    const vm = bodyweightCard([['2026-07-01T08:00:00.000Z', 80]])
    expect(cardForWeightUnit(vm, 'kg')).toBe(vm)
  })

  it('passes through non-bodyweight kinds regardless of preference', () => {
    const vm = buildKindCards([
      makeMetric({ kind: 'resting_hr', value: 60, recordedAt: '2026-07-01T08:00:00.000Z' }),
    ])[0]!
    expect(cardForWeightUnit(vm, 'lb')).toBe(vm)
  })

  it('converts value, unit, and sparkline to lb keeping one decimal', () => {
    const vm = bodyweightCard([
      ['2026-07-01T08:00:00.000Z', 80],
      ['2026-07-03T08:00:00.000Z', 82],
    ])
    const lb = cardForWeightUnit(vm, 'lb')
    expect(lb.unit).toBe('lb')
    expect(lb.latestValue).toBe(180.8) // 82 kg → 180.8 lb (1-dp rounding)
    expect(lb.sparkPoints.map((p) => p.value)).toEqual([176.4, 180.8])
  })

  it('preserves a fractional bodyweight through the round-trip', () => {
    // 158.2 lb logged → displayToKg → 71.76 kg stored → back to 158.2 lb.
    const vm = bodyweightCard([['2026-07-01T08:00:00.000Z', displayToKg(158.2, 'lb')]])
    const lb = cardForWeightUnit(vm, 'lb')
    expect(lb.latestValue).toBe(158.2)
  })

  it('recomputes the delta from the converted points', () => {
    const vm = bodyweightCard([
      ['2026-07-01T08:00:00.000Z', 80],
      ['2026-07-03T08:00:00.000Z', 82],
    ])
    const lb = cardForWeightUnit(vm, 'lb')
    expect(lb.summary.delta).toBeCloseTo(4.4, 5) // 180.8 − 176.4
    expect(lb.deltaDisplay).toBe('+4.4 lb') // formatDelta 1-dp for small values
    expect(lb.deltaDirection).toBe('better') // bodyweight has no betterWhenLower
  })

  it('does not mutate the input card', () => {
    const vm = bodyweightCard([['2026-07-01T08:00:00.000Z', 80]])
    cardForWeightUnit(vm, 'lb')
    expect(vm.unit).toBe('kg')
    expect(vm.latestValue).toBe(80)
    expect(vm.sparkPoints[0]!.value).toBe(80)
  })
})

// ── deltaDirection ────────────────────────────────────────────────────────────

describe('deltaDirection', () => {
  it('returns neutral for null delta', () => {
    expect(deltaDirection(null, false)).toBe('neutral')
  })

  it('returns neutral for zero delta', () => {
    expect(deltaDirection(0, false)).toBe('neutral')
  })

  it('positive delta → better when betterWhenLower=false', () => {
    expect(deltaDirection(5, false)).toBe('better')
    expect(deltaDirection(5, undefined)).toBe('better')
  })

  it('positive delta → worse when betterWhenLower=true', () => {
    expect(deltaDirection(5, true)).toBe('worse')
  })

  it('negative delta → worse when betterWhenLower=false', () => {
    expect(deltaDirection(-3, false)).toBe('worse')
  })

  it('negative delta → better when betterWhenLower=true', () => {
    expect(deltaDirection(-3, true)).toBe('better')
  })
})

// ── formatDelta ───────────────────────────────────────────────────────────────

describe('formatDelta', () => {
  it('returns null for null delta', () => {
    expect(formatDelta(null, 'kg')).toBeNull()
  })

  it('formats positive delta with + sign', () => {
    const result = formatDelta(2.5, 'kg')
    expect(result).toContain('+')
    expect(result).toContain('2.5')
    expect(result).toContain('kg')
  })

  it('formats negative delta with − sign', () => {
    const result = formatDelta(-1.5, 'bpm')
    expect(result).toContain('−')
    expect(result).toContain('1.5')
    expect(result).toContain('bpm')
  })

  it('omits unit suffix when unit is empty string', () => {
    const result = formatDelta(3, '')
    expect(result).not.toContain(' ')
  })

  it('rounds large values to integer', () => {
    const result = formatDelta(1500, 'steps')
    expect(result).toContain('1500')
  })

  it('keeps one decimal for large fractional deltas', () => {
    expect(formatDelta(12.4, 'lb')).toBe('+12.4 lb')
    expect(formatDelta(-3.6, 'lb')).toBe('−3.6 lb')
  })

  it('drops a trailing .0 on whole large deltas', () => {
    expect(formatDelta(58, 'bpm')).toBe('+58 bpm')
  })
})

// ── formatValue ───────────────────────────────────────────────────────────────

describe('formatValue', () => {
  it('returns em dash for null', () => {
    expect(formatValue(null, 'kg')).toBe('—')
  })

  it('includes unit', () => {
    expect(formatValue(80, 'kg')).toBe('80 kg')
  })

  it('uses 1 decimal place for small values', () => {
    expect(formatValue(7.5, 'h')).toBe('7.5 h')
  })

  it('keeps whole large values integer', () => {
    expect(formatValue(10000, '')).toBe('10000')
  })

  it('keeps one decimal for large fractional values (fractional bodyweight)', () => {
    expect(formatValue(158.2, 'lb')).toBe('158.2 lb')
    expect(formatValue(71.8, 'kg')).toBe('71.8 kg')
  })

  it('keeps one decimal for fractional non-weight metrics too (body fat, VO₂ max)', () => {
    // The old ≥10 branch rounded these to integers even though sub-10 values
    // kept a decimal; the formatter is now consistent across the range.
    expect(formatValue(18.5, '%')).toBe('18.5 %')
    expect(formatValue(42.3, 'ml/kg/min')).toBe('42.3 ml/kg/min')
  })

  it('drops a trailing .0 on whole large values', () => {
    expect(formatValue(158, 'lb')).toBe('158 lb')
  })
})

// ── kindLabel / kindUnit ──────────────────────────────────────────────────────

describe('kindLabel', () => {
  it('returns known label', () => {
    expect(kindLabel('bodyweight')).toBe('Bodyweight')
    expect(kindLabel('sleep')).toBe('Sleep')
    expect(kindLabel('hrv')).toBe('HRV')
  })

  it('falls back to slug for unknown kind', () => {
    expect(kindLabel('my_custom_slug')).toBe('my_custom_slug')
  })
})

describe('kindUnit', () => {
  it('returns known unit for known kind', () => {
    expect(kindUnit('bodyweight', null)).toBe('kg')
    expect(kindUnit('sleep', null)).toBe('h')
  })

  it('returns fallback unit for unknown kind', () => {
    expect(kindUnit('my_custom', 'lbs')).toBe('lbs')
  })

  it('returns empty string when no def and no fallback', () => {
    expect(kindUnit('my_custom', null)).toBe('')
  })
})

// ── buildMetricPayload ────────────────────────────────────────────────────────

describe('buildMetricPayload', () => {
  const baseForm = {
    kind: 'bodyweight',
    customKind: '',
    customUnit: '',
    value: '80',
    recordedAt: '2026-06-23T09:00:00',
    note: '',
  }

  it('returns null when kind is empty', () => {
    expect(buildMetricPayload({ ...baseForm, kind: '' })).toBeNull()
  })

  it('returns null when recordedAt is empty', () => {
    expect(buildMetricPayload({ ...baseForm, recordedAt: '' })).toBeNull()
  })

  it('returns null when value is not a number', () => {
    expect(buildMetricPayload({ ...baseForm, value: 'abc' })).toBeNull()
  })

  it('builds valid payload for known kind', () => {
    const p = buildMetricPayload(baseForm)
    expect(p).not.toBeNull()
    expect(p!.kind).toBe('bodyweight')
    expect(p!.value).toBe(80)
  })

  it('trims and includes note when present', () => {
    const p = buildMetricPayload({ ...baseForm, note: '  morning  ' })
    expect(p!.note).toBe('morning')
  })

  it('omits note when blank', () => {
    const p = buildMetricPayload({ ...baseForm, note: '' })
    expect(p!.note).toBeUndefined()
  })

  it('resolves custom kind when kind=__custom__', () => {
    const p = buildMetricPayload({ ...baseForm, kind: '__custom__', customKind: 'neck_size', customUnit: 'cm' })
    expect(p!.kind).toBe('neck_size')
    expect(p!.unit).toBe('cm')
  })

  it('returns null for __custom__ with empty customKind', () => {
    expect(buildMetricPayload({ ...baseForm, kind: '__custom__', customKind: '', customUnit: '' })).toBeNull()
  })

  it('omits unit for custom kind when customUnit is empty', () => {
    const p = buildMetricPayload({ ...baseForm, kind: '__custom__', customKind: 'my_metric', customUnit: '' })
    expect(p!.unit).toBeUndefined()
  })
})

// ── buildMetricLogPayload ─────────────────────────────────────────────────────

describe('buildMetricLogPayload', () => {
  const baseForm = {
    kind: 'bodyweight',
    customKind: '',
    customUnit: '',
    value: '80',
    recordedAt: '2026-07-13T09:00',
    note: '',
  }

  it('produces a payload the server schema accepts (recordedAt → ISO)', () => {
    const result = buildMetricLogPayload(baseForm, 'kg')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.input.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(createMetricSchema.safeParse(result.input).success).toBe(true)
  })

  it('converts bodyweight from lb to storage kg', () => {
    const result = buildMetricLogPayload({ ...baseForm, value: '185' }, 'lb')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.input.value).toBeCloseTo(83.91, 2)
  })

  it('keeps a fractional lb bodyweight (158.2) as sub-kg precision', () => {
    const result = buildMetricLogPayload({ ...baseForm, value: '158.2' }, 'lb')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.input.value).toBeCloseTo(71.76, 2)
    // and it round-trips back to the entered tenths for display
    expect(kgToDisplay(result.input.value, 'lb', 1)).toBe(158.2)
  })

  it('passes bodyweight through unchanged with kg preference', () => {
    const result = buildMetricLogPayload({ ...baseForm, value: '80' }, 'kg')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.input.value).toBe(80)
  })

  it('ignores the weight unit for non-bodyweight kinds', () => {
    const result = buildMetricLogPayload({ ...baseForm, kind: 'resting_hr', value: '60' }, 'lb')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.input.value).toBe(60)
  })

  it('rejects scale kinds out of bounds', () => {
    expect(buildMetricLogPayload({ ...baseForm, kind: 'soreness', value: '11' }, 'kg')).toEqual({
      ok: false,
      reason: 'out_of_scale',
    })
    expect(buildMetricLogPayload({ ...baseForm, kind: 'energy', value: '0' }, 'kg')).toEqual({
      ok: false,
      reason: 'out_of_scale',
    })
    const ok = buildMetricLogPayload({ ...baseForm, kind: 'soreness', value: '10' }, 'kg')
    expect(ok.ok).toBe(true)
  })

  it('rejects custom kinds that are not lowercase slugs', () => {
    const bad = buildMetricLogPayload(
      { ...baseForm, kind: '__custom__', customKind: 'Neck Size' },
      'kg',
    )
    expect(bad).toEqual({ ok: false, reason: 'bad_kind_slug' })
    const good = buildMetricLogPayload(
      { ...baseForm, kind: '__custom__', customKind: 'neck_size', customUnit: 'cm', value: '38' },
      'kg',
    )
    expect(good.ok).toBe(true)
    if (!good.ok) return
    expect(good.input.kind).toBe('neck_size')
    expect(good.input.unit).toBe('cm')
    expect(createMetricSchema.safeParse(good.input).success).toBe(true)
  })

  it('rejects over-long note and custom unit (server schema caps)', () => {
    expect(buildMetricLogPayload({ ...baseForm, note: 'x'.repeat(2001) }, 'kg')).toEqual({
      ok: false,
      reason: 'note_too_long',
    })
    const okNote = buildMetricLogPayload({ ...baseForm, note: 'x'.repeat(2000) }, 'kg')
    expect(okNote.ok).toBe(true)
    expect(
      buildMetricLogPayload(
        { ...baseForm, kind: '__custom__', customKind: 'neck_size', customUnit: 'u'.repeat(21) },
        'kg',
      ),
    ).toEqual({ ok: false, reason: 'unit_too_long' })
  })

  it('flags missing/invalid fields with specific reasons', () => {
    expect(buildMetricLogPayload({ ...baseForm, kind: '' }, 'kg')).toEqual({
      ok: false,
      reason: 'missing_kind',
    })
    expect(buildMetricLogPayload({ ...baseForm, value: '' }, 'kg')).toEqual({
      ok: false,
      reason: 'missing_value',
    })
    expect(buildMetricLogPayload({ ...baseForm, value: 'abc' }, 'kg')).toEqual({
      ok: false,
      reason: 'missing_value',
    })
    expect(buildMetricLogPayload({ ...baseForm, recordedAt: '' }, 'kg')).toEqual({
      ok: false,
      reason: 'missing_recorded_at',
    })
  })
})

// ── metricEntryDisplayUnit ────────────────────────────────────────────────────

describe('metricEntryDisplayUnit', () => {
  it('follows the weight preference for bodyweight', () => {
    expect(metricEntryDisplayUnit({ kind: 'bodyweight', customUnit: '' }, 'lb')).toBe('lb')
    expect(metricEntryDisplayUnit({ kind: 'bodyweight', customUnit: '' }, 'kg')).toBe('kg')
  })

  it('uses the kind def unit for other known kinds', () => {
    expect(metricEntryDisplayUnit({ kind: 'resting_hr', customUnit: '' }, 'lb')).toBe('bpm')
  })

  it('is empty for unitless scale kinds', () => {
    expect(metricEntryDisplayUnit({ kind: 'soreness', customUnit: '' }, 'lb')).toBe('')
  })

  it('echoes the typed unit for custom kinds', () => {
    expect(metricEntryDisplayUnit({ kind: '__custom__', customUnit: ' cm ' }, 'lb')).toBe('cm')
  })
})

// ── formatMetricDate ──────────────────────────────────────────────────────────

describe('formatMetricDate', () => {
  it('returns a non-empty string for a valid ISO timestamp', () => {
    const result = formatMetricDate('2026-06-23T09:00:00.000Z')
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(5)
    expect(result).toContain('23')
    expect(result).toContain('Jun')
  })
})

// ── isoToDatetimeLocal / datetimeLocalToIso ───────────────────────────────────

describe('isoToDatetimeLocal', () => {
  it('returns empty string for empty input', () => {
    expect(isoToDatetimeLocal('')).toBe('')
  })

  it('returns a datetime-local string', () => {
    const result = isoToDatetimeLocal('2026-06-23T09:00:00.000Z')
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  })
})

describe('datetimeLocalToIso', () => {
  it('returns empty string for empty input', () => {
    expect(datetimeLocalToIso('')).toBe('')
  })

  it('returns a valid ISO string', () => {
    const result = datetimeLocalToIso('2026-06-23T09:00')
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })
})

describe('bodyweightTileVm', () => {
  it('shows a placeholder while the metrics cache is cold', () => {
    expect(bodyweightTileVm(undefined, 'kg')).toEqual({ value: '—', sub: 'Last weigh-in' })
  })

  it('prompts a first weigh-in when no bodyweight rows exist', () => {
    expect(bodyweightTileVm([], 'kg')).toEqual({ value: null, sub: 'Log a weigh-in' })
    const otherKind = [makeMetric({ kind: 'sleep', value: 7.5, recordedAt: '2026-06-20T08:00:00.000Z' })]
    expect(bodyweightTileVm(otherKind, 'kg')).toEqual({ value: null, sub: 'Log a weigh-in' })
  })

  it('formats the latest bodyweight in kg', () => {
    const metrics = [
      makeMetric({ kind: 'bodyweight', value: 82.4, recordedAt: '2026-06-22T08:00:00.000Z' }),
      makeMetric({ kind: 'bodyweight', value: 83.1, recordedAt: '2026-06-20T08:00:00.000Z' }),
    ]
    expect(bodyweightTileVm(metrics, 'kg')).toEqual({ value: '82.4 kg', sub: 'Last weigh-in' })
  })

  it('picks the latest reading regardless of input order', () => {
    const metrics = [
      makeMetric({ kind: 'bodyweight', value: 83.1, recordedAt: '2026-06-20T08:00:00.000Z' }),
      makeMetric({ kind: 'bodyweight', value: 82.4, recordedAt: '2026-06-22T08:00:00.000Z' }),
    ]
    expect(bodyweightTileVm(metrics, 'kg').value).toBe('82.4 kg')
  })

  it('converts to lb when that is the preference', () => {
    const metrics = [makeMetric({ kind: 'bodyweight', value: 80, recordedAt: '2026-06-22T08:00:00.000Z' })]
    const expected = kgToDisplay(80, 'lb', 1)
    expect(bodyweightTileVm(metrics, 'lb').value).toBe(`${expected} lb`)
  })
})

// ── nearestMetricTo ──────────────────────────────────────────────────────────

describe('nearestMetricTo', () => {
  it('returns an exact hit', () => {
    const metrics = [
      makeMetric({ kind: 'bodyweight', value: 80, recordedAt: '2026-06-20T08:00:00.000Z' }),
      makeMetric({ kind: 'bodyweight', value: 81, recordedAt: '2026-06-22T08:00:00.000Z' }),
    ]
    expect(nearestMetricTo('2026-06-22T08:00:00.000Z', metrics)?.value).toBe(81)
  })

  it('picks a metric recorded before the photo', () => {
    const metrics = [makeMetric({ kind: 'bodyweight', value: 80, recordedAt: '2026-06-19T08:00:00.000Z' })]
    expect(nearestMetricTo('2026-06-20T08:00:00.000Z', metrics)?.value).toBe(80)
  })

  it('picks a metric recorded after the photo', () => {
    const metrics = [makeMetric({ kind: 'bodyweight', value: 80, recordedAt: '2026-06-23T08:00:00.000Z' })]
    expect(nearestMetricTo('2026-06-20T08:00:00.000Z', metrics)?.value).toBe(80)
  })

  it('returns null when nothing is within the window', () => {
    const metrics = [makeMetric({ kind: 'bodyweight', value: 80, recordedAt: '2026-06-01T08:00:00.000Z' })]
    expect(nearestMetricTo('2026-06-20T08:00:00.000Z', metrics, 7)).toBeNull()
  })

  it('returns null for an empty list', () => {
    expect(nearestMetricTo('2026-06-20T08:00:00.000Z', [])).toBeNull()
  })

  it('returns null for an invalid takenAt', () => {
    const metrics = [makeMetric({ kind: 'bodyweight', value: 80, recordedAt: '2026-06-20T08:00:00.000Z' })]
    expect(nearestMetricTo('not-a-date', metrics)).toBeNull()
  })

  it('is tolerant of unsorted input', () => {
    const metrics = [
      makeMetric({ kind: 'bodyweight', value: 90, recordedAt: '2026-06-25T08:00:00.000Z' }),
      makeMetric({ kind: 'bodyweight', value: 80, recordedAt: '2026-06-20T08:00:00.000Z' }),
      makeMetric({ kind: 'bodyweight', value: 85, recordedAt: '2026-06-15T08:00:00.000Z' }),
    ]
    expect(nearestMetricTo('2026-06-21T08:00:00.000Z', metrics)?.value).toBe(80)
  })

  it('resolves ties to the earlier-recorded entry', () => {
    const metrics = [
      makeMetric({ kind: 'bodyweight', value: 80, recordedAt: '2026-06-18T08:00:00.000Z' }),
      makeMetric({ kind: 'bodyweight', value: 81, recordedAt: '2026-06-22T08:00:00.000Z' }),
    ]
    // Target is exactly 2 days from each side.
    expect(nearestMetricTo('2026-06-20T08:00:00.000Z', metrics)?.value).toBe(80)
  })

  it('ignores non-finite values', () => {
    const metrics = [makeMetric({ kind: 'bodyweight', value: Number.NaN, recordedAt: '2026-06-20T08:00:00.000Z' })]
    expect(nearestMetricTo('2026-06-20T08:00:00.000Z', metrics)).toBeNull()
  })
})
