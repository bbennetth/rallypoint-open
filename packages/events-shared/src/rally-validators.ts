import { z } from 'zod'
import { eventLatField, eventLngField, setTimeField } from './validators.js'

// Cross-target validators for the rally layer (Slice 9b). Same
// field-builder style as group-validators.ts / validators.ts:
// apps/events-api validates request bodies with these and
// apps/events-web reuses them so users see field errors before a
// network round trip. Evolve the rules HERE, never in two places.

// --- Field-level building blocks -----------------------------------

// Rally title. Matches rallies.title (notNull) — 1–200 chars trimmed.
export const rallyTitleField = z
  .string()
  .trim()
  .min(1, 'Rally title is required.')
  .max(200, 'Rally title must be at most 200 characters.')

// Free-text description. Matches rallies.description (nullable). Empty
// string normalises to null (clear-the-column on PATCH); absent stays
// undefined (leave-alone on PATCH).
export const rallyDescriptionField = z
  .string()
  .trim()
  .max(5000, 'Description must be at most 5000 characters.')
  .transform((s) => (s.length === 0 ? null : s))
  .nullable()
  .optional()

// Free-text location label fallback. Matches rallies.location_label
// (nullable). Same empty→null normalisation as the description.
export const rallyLocationLabelField = z
  .string()
  .trim()
  .max(200, 'Location label must be at most 200 characters.')
  .transform((s) => (s.length === 0 ? null : s))
  .nullable()
  .optional()

// Prefix-tagged id reference (day_id / poi_id). Bound length/charset
// rather than re-deriving the ULID grammar. Empty string clears the
// column on PATCH; absent leaves it alone.
const idRefField = (label: string) =>
  z
    .string()
    .trim()
    .max(64, `${label} is too long.`)
    .transform((s) => (s.length === 0 ? null : s))
    .nullable()
    .optional()

// Rally lifecycle status. Matches rallies.status (default 'proposed').
export const RALLY_STATUSES = ['proposed', 'active', 'cancelled'] as const
export const rallyStatusField = z.enum(RALLY_STATUSES, {
  errorMap: () => ({ message: 'Status must be proposed, active, or cancelled.' }),
})

// RSVP status. Matches rally_attendees.status.
export const RALLY_RSVP_STATUSES = ['going', 'maybe', 'out'] as const
export const rallyRsvpStatusField = z.enum(RALLY_RSVP_STATUSES, {
  errorMap: () => ({ message: 'RSVP must be going, maybe, or out.' }),
})

// lat/lng for an off-map rally spot — both optional, but must travel
// together (a lone coordinate is meaningless).
const offMapCoords = {
  lat: eventLatField.nullable().optional(),
  lng: eventLngField.nullable().optional(),
}
function refineCoords(
  v: { lat?: number | null | undefined; lng?: number | null | undefined },
  ctx: z.RefinementCtx,
): void {
  // A coordinate "key" is present when supplied at all — including an
  // explicit null (a PATCH clearing one column). Both keys must travel
  // together so a PATCH can't clear lat while leaving lng (or vice
  // versa), which would persist a meaningless half-coordinate.
  const latKey = v.lat !== undefined
  const lngKey = v.lng !== undefined
  if (latKey !== lngKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [latKey ? 'lng' : 'lat'],
      message: 'Latitude and longitude must be provided together.',
    })
    return
  }
  // When both keys are supplied they must agree on null-ness: both set
  // (an off-map point) or both cleared. `{ lat: 1, lng: null }` is a
  // half-coordinate just like a lone key.
  const latValue = v.lat !== undefined && v.lat !== null
  const lngValue = v.lng !== undefined && v.lng !== null
  if (latValue !== lngValue) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [latValue ? 'lng' : 'lat'],
      message: 'Latitude and longitude must be provided together.',
    })
  }
}

// --- Request schemas -----------------------------------------------

// Create a rally. title required; everything else optional. Location
// is layered, not exclusive: an optional map POI (poi_id), a free-text
// label that doubles as a fallback when there's no POI (location_label),
// and an optional off-map lat/lng pair (must travel together). The UI
// decides which to show; the server stores whatever is sent.
export const CreateRallySchema = z
  .object({
    title: rallyTitleField,
    description: rallyDescriptionField,
    dayId: idRefField('Day id'),
    startTime: setTimeField,
    poiId: idRefField('POI id'),
    locationLabel: rallyLocationLabelField,
    status: rallyStatusField.optional(),
    ...offMapCoords,
  })
  .superRefine((v, ctx) => refineCoords(v, ctx))
export type CreateRallyBody = z.infer<typeof CreateRallySchema>

// Patch a rally. Every field optional; at least one must be present.
// nulls clear the nullable columns.
export const PatchRallySchema = z
  .object({
    title: rallyTitleField.optional(),
    description: rallyDescriptionField,
    dayId: idRefField('Day id'),
    startTime: setTimeField,
    poiId: idRefField('POI id'),
    locationLabel: rallyLocationLabelField,
    status: rallyStatusField.optional(),
    ...offMapCoords,
  })
  .superRefine((v, ctx) => {
    if (Object.values(v).every((x) => x === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'At least one field must be supplied.',
      })
    }
    refineCoords(v, ctx)
  })
export type PatchRallyBody = z.infer<typeof PatchRallySchema>

// RSVP to a rally. Upserts the caller's attendee row.
export const RallyRsvpSchema = z.object({
  status: rallyRsvpStatusField,
})
export type RallyRsvpBody = z.infer<typeof RallyRsvpSchema>
