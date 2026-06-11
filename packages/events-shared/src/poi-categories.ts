// POI category enum (design §5.4), ported verbatim from
// festival-planner. Stored as free-form `text` in event_pois, so V2
// (#60) can swap to an owner-defined category table without a schema
// migration. The UI picker and the server validator both read this
// single list.

export const POI_CATEGORY_IDS = [
  'stage',
  'water',
  'restroom',
  'first_aid',
  'food',
  'merch',
  'art',
  'ride',
  'info',
  'entrance',
  'lockers',
  'charging',
  'cash',
  'lost_found',
  'wifi',
  'photo_op',
  'accessible_viewing',
  'vip',
  'safety_outreach',
  'kiosk',
  'bike_parking',
  'shower',
  'ice',
  'camp_site',
  'bar',
] as const

export type PoiCategoryId = (typeof POI_CATEGORY_IDS)[number]

export function isPoiCategory(value: string): value is PoiCategoryId {
  return (POI_CATEGORY_IDS as readonly string[]).includes(value)
}
