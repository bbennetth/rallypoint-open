// Pure view-layer helpers for the MetricsPage. No React deps.
// All inputs/outputs are plain data — testable without a DOM or network.

import type { MetricDto, MetricKindDef, CreateMetricInput } from '@rallypoint/fitness-shared'
import {
  KNOWN_METRIC_KINDS,
  metricKindDef,
  metricValueOutOfScale,
  summarizeMetricSeries,
} from '@rallypoint/fitness-shared'
import type { WeightUnit } from './units.js'
import { displayToKg, kgToDisplay } from './units.js'

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export { KNOWN_METRIC_KINDS, metricKindDef, summarizeMetricSeries }
export type { MetricKindDef }

// ---------------------------------------------------------------------------
// Per-kind card view-model
// ---------------------------------------------------------------------------

export interface MetricKindCardVm {
  kind: string
  label: string
  unit: string
  // undefined if no points
  latestValue: number | null
  latestRecordedAt: string | null
  summary: ReturnType<typeof summarizeMetricSeries>
  // Trend direction relative to first point in the window.
  // 'better' | 'worse' | 'neutral'
  deltaDirection: 'better' | 'worse' | 'neutral'
  // The delta formatted for display, e.g. "+1.2" or "−0.5"
  deltaDisplay: string | null
  // Points for sparkline (oldest → newest)
  sparkPoints: { recordedAt: string; value: number }[]
  metrics: MetricDto[]
}

/**
 * Resolve the display label and unit for a kind slug.
 * Falls back to the slug itself as label, and empty string for unit.
 */
export function kindLabel(kind: string): string {
  return metricKindDef(kind)?.label ?? kind
}

export function kindUnit(kind: string, fallbackUnit: string | null): string {
  const def = metricKindDef(kind)
  if (def) return def.unit
  return fallbackUnit ?? ''
}

/**
 * Determine the delta direction given a numeric delta and the kind's
 * `betterWhenLower` flag. Returns 'neutral' when delta is effectively zero.
 */
export function deltaDirection(
  delta: number | null,
  betterWhenLower: boolean | undefined,
): 'better' | 'worse' | 'neutral' {
  if (delta === null || Math.abs(delta) < 1e-9) return 'neutral'
  const isPositive = delta > 0
  if (betterWhenLower) {
    return isPositive ? 'worse' : 'better'
  }
  return isPositive ? 'better' : 'worse'
}

/**
 * Format a value magnitude ≥ 10 to at most one decimal place, dropping a
 * trailing ".0" so integers stay integers. This matches the sub-10 branch of
 * formatValue/formatDelta (which already renders one decimal), so precision is
 * now consistent across the whole range instead of flipping to integer at 10.
 * Every fractional reading survives — a logged 158.2 lb bodyweight, an 18.5 %
 * body-fat — while whole readings (58 bpm, 10000 steps) stay clean.
 */
function formatMagnitude(n: number): string {
  const rounded = Math.round(n * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/**
 * Format a numeric delta for display.
 * Uses a proper minus sign (−) for negative values.
 */
export function formatDelta(delta: number | null, unit: string): string | null {
  if (delta === null) return null
  const sign = delta >= 0 ? '+' : '−'
  const abs = Math.abs(delta)
  const formatted = abs < 10 ? abs.toFixed(1) : formatMagnitude(abs)
  const suffix = unit ? ` ${unit}` : ''
  return `${sign}${formatted}${suffix}`
}

/**
 * Format a numeric value with appropriate precision.
 */
export function formatValue(value: number | null, unit: string): string {
  if (value === null) return '—'
  const formatted = Math.abs(value) < 10 ? value.toFixed(1) : formatMagnitude(value)
  return unit ? `${formatted} ${unit}` : formatted
}

// ---------------------------------------------------------------------------
// Grouping metrics by kind
// ---------------------------------------------------------------------------

/**
 * Group a flat list of MetricDtos by kind, preserving insertion order of
 * first encounter per kind. Returns a map of kind → sorted-by-recordedAt array
 * (newest first as the API returns).
 */
export function groupMetricsByKind(metrics: MetricDto[]): Map<string, MetricDto[]> {
  const order: string[] = []
  const byKind = new Map<string, MetricDto[]>()
  for (const m of metrics) {
    if (!byKind.has(m.kind)) {
      order.push(m.kind)
      byKind.set(m.kind, [])
    }
    byKind.get(m.kind)!.push(m)
  }
  // Sort each bucket newest-first (API already does this, but be defensive)
  for (const [kind, pts] of byKind) {
    byKind.set(kind, [...pts].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)))
  }
  // Return in insertion order
  const result = new Map<string, MetricDto[]>()
  for (const k of order) result.set(k, byKind.get(k)!)
  return result
}

/**
 * Build the per-kind card view-model array from a flat list of metrics.
 * Kinds are ordered by first-seen in the input (newest-first from API means
 * most-recently-updated kind appears first).
 */
export function buildKindCards(metrics: MetricDto[]): MetricKindCardVm[] {
  const byKind = groupMetricsByKind(metrics)
  const cards: MetricKindCardVm[] = []

  for (const [kind, pts] of byKind) {
    const def = metricKindDef(kind)
    const label = def?.label ?? kind
    // Resolve unit: prefer the kind def, then the most common unit in the data
    const unitFromData = pts.find((p) => p.unit != null)?.unit ?? null
    const unit = kindUnit(kind, unitFromData)

    // sparkPoints: oldest → newest for SVG polyline rendering
    const sparkPoints = [...pts].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))

    const summary = summarizeMetricSeries(sparkPoints)
    const dir = deltaDirection(summary.delta, def?.betterWhenLower)
    const deltaDisplay = formatDelta(summary.delta, unit)

    // Latest is the first element since pts is sorted newest-first
    const latestPt = pts[0]

    cards.push({
      kind,
      label,
      unit,
      latestValue: latestPt?.value ?? null,
      latestRecordedAt: latestPt?.recordedAt ?? null,
      summary,
      deltaDirection: dir,
      deltaDisplay,
      sparkPoints,
      metrics: pts,
    })
  }
  return cards
}

/**
 * Convert a bodyweight card VM to the active weight-unit preference for
 * display. Storage (and the input VM) is always kg; this maps the shown
 * value, sparkline points, and delta into lb when that's the preference.
 * Summary/delta are recomputed from the converted points so the delta
 * matches the rounded values on screen. Non-bodyweight cards and the kg
 * preference pass through unchanged.
 */
export function cardForWeightUnit(vm: MetricKindCardVm, weightUnit: WeightUnit): MetricKindCardVm {
  if (vm.kind !== 'bodyweight' || weightUnit === 'kg') return vm
  // dp=1: bodyweight keeps one decimal of precision (158.2 lb), unlike the
  // whole-lb rounding barbell loads use.
  const sparkPoints = vm.sparkPoints.map((p) => ({ ...p, value: kgToDisplay(p.value, weightUnit, 1) }))
  const summary = summarizeMetricSeries(sparkPoints)
  const def = metricKindDef(vm.kind)
  return {
    ...vm,
    unit: weightUnit,
    latestValue: vm.latestValue === null ? null : kgToDisplay(vm.latestValue, weightUnit, 1),
    sparkPoints,
    summary,
    deltaDirection: deltaDirection(summary.delta, def?.betterWhenLower),
    deltaDisplay: formatDelta(summary.delta, weightUnit),
  }
}

// ---------------------------------------------------------------------------
// Log data point form state → CreateMetricInput
// ---------------------------------------------------------------------------

export interface MetricFormState {
  kind: string          // known kind id or '__custom__'
  customKind: string    // only used when kind === '__custom__'
  customUnit: string    // only used when kind === '__custom__'
  value: string         // numeric string
  recordedAt: string    // datetime-local string
  note: string
}

export function emptyMetricForm(): MetricFormState {
  return { kind: '', customKind: '', customUnit: '', value: '', recordedAt: '', note: '' }
}

/**
 * Build a CreateMetricInput from the log form state.
 * Returns null if required fields are missing or invalid.
 */
export function buildMetricPayload(form: MetricFormState): CreateMetricInput | null {
  const resolvedKind = form.kind === '__custom__' ? form.customKind.trim() : form.kind
  if (!resolvedKind) return null
  if (!form.recordedAt) return null

  const numVal = parseFloat(form.value)
  if (!Number.isFinite(numVal)) return null

  const resolvedUnit = form.kind === '__custom__' ? form.customUnit.trim() : undefined
  const note = form.note.trim() || undefined

  return {
    kind: resolvedKind,
    recordedAt: form.recordedAt,
    value: numVal,
    unit: resolvedUnit || undefined,
    note,
  }
}

// Mirror of the shared `kindSchema` slug rule so a bad custom kind fails
// inline instead of after the optimistic write, on outbox flush.
const KIND_SLUG_RE = /^[a-z0-9_]{1,40}$/

// Server-schema field caps (createMetricSchema), mirrored so an
// over-long note/unit fails inline rather than on outbox flush.
export const METRIC_UNIT_MAX = 20
export const METRIC_NOTE_MAX = 2000

export type MetricLogPayloadResult =
  | { ok: true; input: CreateMetricInput }
  | {
      ok: false
      reason:
        | 'missing_kind'
        | 'bad_kind_slug'
        | 'missing_value'
        | 'out_of_scale'
        | 'missing_recorded_at'
        | 'unit_too_long'
        | 'note_too_long'
    }

/**
 * Unit label shown next to the value input. Bodyweight follows the active
 * weight-unit preference (input converts to kg on save); other known kinds
 * use their canonical unit; custom kinds echo the typed unit.
 */
export function metricEntryDisplayUnit(
  form: Pick<MetricFormState, 'kind' | 'customUnit'>,
  weightUnit: WeightUnit,
): string {
  if (form.kind === 'bodyweight') return weightUnit
  if (form.kind === '__custom__') return form.customUnit.trim()
  return metricKindDef(form.kind)?.unit ?? ''
}

/**
 * Validating wrapper over `buildMetricPayload` that produces a payload the
 * server schema actually accepts: converts `recordedAt` from datetime-local
 * to ISO (createMetricSchema requires `.datetime()`), converts bodyweight
 * from the display unit to storage kg, and pre-checks scale bounds + custom
 * slug shape so bad input errors here rather than on outbox flush.
 */
export function buildMetricLogPayload(
  form: MetricFormState,
  weightUnit: WeightUnit,
): MetricLogPayloadResult {
  const resolvedKind = form.kind === '__custom__' ? form.customKind.trim() : form.kind
  if (!resolvedKind) return { ok: false, reason: 'missing_kind' }
  if (!KIND_SLUG_RE.test(resolvedKind)) return { ok: false, reason: 'bad_kind_slug' }
  if (!form.recordedAt) return { ok: false, reason: 'missing_recorded_at' }
  const numVal = parseFloat(form.value)
  if (!Number.isFinite(numVal)) return { ok: false, reason: 'missing_value' }

  const value = resolvedKind === 'bodyweight' ? displayToKg(numVal, weightUnit) : numVal
  if (metricValueOutOfScale(resolvedKind, value)) return { ok: false, reason: 'out_of_scale' }
  if (form.kind === '__custom__' && form.customUnit.trim().length > METRIC_UNIT_MAX) {
    return { ok: false, reason: 'unit_too_long' }
  }
  if (form.note.trim().length > METRIC_NOTE_MAX) return { ok: false, reason: 'note_too_long' }

  const base = buildMetricPayload(form)
  if (!base) return { ok: false, reason: 'missing_value' }
  return {
    ok: true,
    input: { ...base, value, recordedAt: datetimeLocalToIso(form.recordedAt) },
  }
}

// ---------------------------------------------------------------------------
// Date/time formatting helpers
// ---------------------------------------------------------------------------

/** Format an ISO instant as a short readable date+time, e.g. "23 Jun, 09:00" */
export function formatMetricDate(iso: string): string {
  const d = new Date(iso)
  const day = d.getDate()
  const mon = d.toLocaleDateString('en-GB', { month: 'short' })
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${day} ${mon}, ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Convert an ISO datetime to datetime-local input value */
export function isoToDatetimeLocal(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Convert a datetime-local value to an ISO 8601 string */
export function datetimeLocalToIso(dt: string): string {
  if (!dt) return ''
  return new Date(dt).toISOString()
}

/** Return the current local datetime as a datetime-local input value */
export function nowDatetimeLocal(): string {
  return isoToDatetimeLocal(new Date().toISOString())
}
