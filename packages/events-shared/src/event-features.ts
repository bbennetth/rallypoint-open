import { z } from 'zod'

// Per-event feature toggles (#216). Stored as a JSON object on
// `events.features` (nullable text column); NULL or any partial /
// malformed value resolves to the defaults below. Lineup, sessions and
// groups default ON for back-compat with every pre-toggle event;
// attendees ("who's going" list visible to attendees) defaults OFF so
// attendee visibility is an explicit owner opt-in.

export interface EventFeatures {
  lineup: boolean
  sessions: boolean
  groups: boolean
  attendees: boolean
}

export const EVENT_FEATURE_KEYS = ['lineup', 'sessions', 'groups', 'attendees'] as const
export type EventFeatureKey = (typeof EVENT_FEATURE_KEYS)[number]

export const EVENT_FEATURE_DEFAULTS: EventFeatures = {
  lineup: true,
  sessions: true,
  groups: true,
  attendees: false,
}

// Client-facing patch shape: a partial object; omitted keys keep their
// stored value. `.strict()` rejects unknown keys so typos surface as a
// 400 instead of silently no-oping.
export const EventFeaturesPatchSchema = z
  .object({
    lineup: z.boolean().optional(),
    sessions: z.boolean().optional(),
    groups: z.boolean().optional(),
    attendees: z.boolean().optional(),
  })
  .strict()
export type EventFeaturesPatch = z.infer<typeof EventFeaturesPatchSchema>

// Resolve a raw stored value (events.features JSON column round-trip:
// could be null, an object, or junk from a bad write) into a complete
// EventFeatures. Unknown keys and non-boolean values are ignored;
// anything unusable falls back to the defaults.
export function resolveEventFeatures(raw: unknown): EventFeatures {
  const out: EventFeatures = { ...EVENT_FEATURE_DEFAULTS }
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return out
  }
  const rec = raw as Record<string, unknown>
  for (const key of EVENT_FEATURE_KEYS) {
    const v = rec[key]
    if (typeof v === 'boolean') out[key] = v
  }
  return out
}

// Merge a validated patch over the currently stored raw value,
// producing the full object to store. Always materializes all four
// keys so reads after a patch don't depend on defaults shifting.
export function mergeEventFeatures(storedRaw: unknown, patch: EventFeaturesPatch): EventFeatures {
  const out = resolveEventFeatures(storedRaw)
  for (const key of EVENT_FEATURE_KEYS) {
    const v = patch[key]
    if (v !== undefined) out[key] = v
  }
  return out
}
