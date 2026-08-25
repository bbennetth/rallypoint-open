// Weekly rhythm: the user assigns each weekday a workout "type" so the
// Today view can show a fallback card ("Today is a Strength day") when
// nothing is scheduled on the training plan for today. A day's value is
// either one of the built-in presets (strength/cardio/…) OR a free-text
// label the user typed (e.g. "CrossFit class"). Pure vocabulary + zod
// validators only — the settings store and UI live in fitness-web.

import { z } from 'zod'
import { DAY_KEYS, type DayKey } from './training-plans.js'

export { DAY_KEYS, type DayKey }

export const DAY_TYPES = ['strength', 'cardio', 'hiit', 'mobility', 'rest'] as const
export type DayType = (typeof DAY_TYPES)[number]

/** Preset-only validator (used where a value MUST be one of the built-ins,
 *  e.g. picking a preset chip). Free-text days are NOT accepted here. */
export const dayTypeSchema = z.enum(DAY_TYPES)

/** Max length of a free-text day label — keeps the settings bag small and
 *  the Today card / plan chip from overflowing. */
export const DAY_TYPE_VALUE_MAX = 40

/** A day's assigned value: a preset OR any non-empty free-text label
 *  (trimmed, capped at DAY_TYPE_VALUE_MAX). This is the schema the
 *  weekly-rhythm map stores per day. */
export const dayTypeValueSchema = z.string().trim().min(1).max(DAY_TYPE_VALUE_MAX)

/** Either a known preset or a custom label. The `string & {}` keeps preset
 *  literals in editor autocomplete while still allowing arbitrary text. */
export type DayTypeValue = DayType | (string & {})

export const DAY_TYPE_LABELS: Record<DayType, string> = {
  strength: 'Strength',
  cardio: 'Cardio',
  hiit: 'HIIT',
  mobility: 'Mobility',
  rest: 'Rest',
}

/** True when a stored value is one of the built-in presets (so callers can
 *  branch preset-specific copy/CTAs vs. rendering a custom label as-is). */
export function isPresetDayType(value: string): value is DayType {
  return (DAY_TYPES as readonly string[]).includes(value)
}

/** Display label for any day value: the preset's title-cased label, or the
 *  free-text string verbatim. */
export function dayTypeDisplayLabel(value: DayTypeValue): string {
  return isPresetDayType(value) ? DAY_TYPE_LABELS[value] : value
}

/** Partial record of weekday -> assigned value (preset or free text). Every
 *  key is optional — an unset day has no fallback. */
export const dayTypesMapSchema = z
  .object({
    mon: dayTypeValueSchema.optional(),
    tue: dayTypeValueSchema.optional(),
    wed: dayTypeValueSchema.optional(),
    thu: dayTypeValueSchema.optional(),
    fri: dayTypeValueSchema.optional(),
    sat: dayTypeValueSchema.optional(),
    sun: dayTypeValueSchema.optional(),
  })
  .partial()

export type DayTypesMap = z.infer<typeof dayTypesMapSchema>

/** Normalize an unknown value (e.g. a raw settings blob straight off the
 *  RPID session probe) into a valid DayTypesMap: strips unknown keys, drops
 *  any per-day value that isn't a non-empty string within the length cap
 *  (trimming as it goes), and always returns an object (never throws).
 *  Preset values are just short strings, so they pass through unchanged. */
export function normalizeDayTypesMap(value: unknown): DayTypesMap {
  if (value == null || typeof value !== 'object') return {}
  const out: DayTypesMap = {}
  for (const key of DAY_KEYS) {
    const raw = (value as Record<string, unknown>)[key]
    const parsed = dayTypeValueSchema.safeParse(raw)
    if (parsed.success) out[key] = parsed.data
  }
  return out
}
