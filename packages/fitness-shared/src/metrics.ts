import { z } from 'zod'
import { refField } from './validators.js'

// Body/health metric vocabulary + validators, shared by apps/fitness-api
// and apps/fitness-web. A metric is one numeric data point at an instant;
// `kind` is a slug. A curated set of known kinds (with default units +
// optional scale bounds) drives the UI, but ANY slug is allowed so users
// can track arbitrary metrics without a definitions table.

export interface MetricKindDef {
  id: string
  label: string
  // Canonical/display unit ('' for unitless scales/counts).
  unit: string
  // When set, the kind is a bounded subjective scale (e.g. soreness 1-10).
  scale?: { min: number; max: number }
  // Higher-is-better is not assumed; this only hints chart direction.
  betterWhenLower?: boolean
}

export const KNOWN_METRIC_KINDS: readonly MetricKindDef[] = [
  { id: 'bodyweight', label: 'Bodyweight', unit: 'kg' },
  { id: 'bodyfat', label: 'Body Fat', unit: '%', betterWhenLower: true },
  { id: 'sleep', label: 'Sleep', unit: 'h' },
  { id: 'resting_hr', label: 'Resting HR', unit: 'bpm', betterWhenLower: true },
  { id: 'hrv', label: 'HRV', unit: 'ms' },
  { id: 'vo2max', label: 'VO₂ Max', unit: 'ml/kg/min' },
  { id: 'steps', label: 'Steps', unit: '' },
  { id: 'soreness', label: 'Soreness', unit: '', scale: { min: 1, max: 10 }, betterWhenLower: true },
  { id: 'energy', label: 'Energy', unit: '', scale: { min: 1, max: 5 } },
  { id: 'mood', label: 'Mood', unit: '', scale: { min: 1, max: 5 } },
]

export const KNOWN_METRIC_KIND_IDS: ReadonlySet<string> = new Set(
  KNOWN_METRIC_KINDS.map((k) => k.id),
)

export function metricKindDef(id: string): MetricKindDef | undefined {
  return KNOWN_METRIC_KINDS.find((k) => k.id === id)
}

// True when the value falls outside the curated scale bounds for a known
// kind. Custom kinds have no scale → always returns false. The UI already
// enforces these bounds via the input's `min`/`max`, but a raw POST has
// to be guarded server-side too, or a `{ kind: 'soreness', value: 999 }`
// corrupts the sparkline's min/max/avg.
export function metricValueOutOfScale(kind: string, value: number): boolean {
  const def = metricKindDef(kind)
  if (!def?.scale) return false
  return value < def.scale.min || value > def.scale.max
}

// kind slug: lowercase letters/digits/underscore, 1-40 chars. Constrains
// custom kinds so they stay queryable + index-friendly.
const kindSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9_]+$/, 'kind must be a lowercase slug (letters, digits, underscore)')

export const createMetricSchema = z
  .object({
    recordedAt: z.string().datetime(),
    kind: kindSchema,
    value: z.number().finite(),
    unit: z.string().max(20).optional(),
    note: z.string().max(2000).optional(),
    // Offline-create idempotency key — see validators.ts refField.
    ref: refField.nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (metricValueOutOfScale(data.kind, data.value)) {
      const scale = metricKindDef(data.kind)!.scale!
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `value out of scale (${scale.min}-${scale.max}) for kind "${data.kind}"`,
      })
    }
  })
export type CreateMetricInput = z.infer<typeof createMetricSchema>

export const patchMetricSchema = z.object({
  recordedAt: z.string().datetime().optional(),
  value: z.number().finite().optional(),
  unit: z.string().max(20).nullish(),
  note: z.string().max(2000).nullish(),
})
export type PatchMetricInput = z.infer<typeof patchMetricSchema>

export interface MetricDto {
  id: string
  recordedAt: string
  kind: string
  value: number
  unit: string | null
  note: string | null
  // Offline-create idempotency key, echoed back — see WorkoutDto's ref
  // doc comment for why this is optional.
  ref?: string | null
  createdAt: string
}

// --- pure series summary (UI trend cards) ----------------------------

export interface MetricSeriesSummary {
  count: number
  latest: number | null
  first: number | null
  min: number | null
  max: number | null
  avg: number | null
  // latest − first, the net change over the supplied window.
  delta: number | null
}

// Summarize a set of points. Sorts by recordedAt ascending internally so
// `first`/`latest`/`delta` are time-ordered regardless of input order.
export function summarizeMetricSeries(
  points: { recordedAt: string; value: number }[],
): MetricSeriesSummary {
  if (points.length === 0) {
    return { count: 0, latest: null, first: null, min: null, max: null, avg: null, delta: null }
  }
  const sorted = [...points].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
  const values = sorted.map((p) => p.value)
  const first = values[0]!
  const latest = values[values.length - 1]!
  const sum = values.reduce((acc, v) => acc + v, 0)
  return {
    count: values.length,
    latest,
    first,
    min: Math.min(...values),
    max: Math.max(...values),
    avg: sum / values.length,
    delta: latest - first,
  }
}
