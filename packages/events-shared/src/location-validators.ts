import { z } from 'zod'
import { MAP_LAYERS } from './validators.js'

// Cross-target validators for crew map pins (attendee Map tab). A
// member's "location" is a self-placed pin on the event's image map —
// not GPS — so the shape is simply a layer + a percentage position.
// Same field-builder style as rally-validators.ts: events-api validates
// request bodies with these and events-web reuses them client-side.

export const memberPinLayerField = z.enum(MAP_LAYERS, {
  error: 'Layer must be site, camp, or full.',
})

const pinPctField = (label: string) =>
  z
    .number()
    .min(0, `${label} must be between 0 and 100.`)
    .max(100, `${label} must be between 0 and 100.`)

// PUT /groups/:id/locations/me — upsert the caller's pin. All three
// fields required: a pin without a position is meaningless (removing
// the pin is a DELETE, not a partial PUT).
export const PutMemberLocationSchema = z.object({
  layer: memberPinLayerField,
  xPct: pinPctField('X'),
  yPct: pinPctField('Y'),
})
export type PutMemberLocationBody = z.infer<typeof PutMemberLocationSchema>
