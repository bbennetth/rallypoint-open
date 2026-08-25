import type { MapDto, MapLayer, PoiDto } from './api.js'

// Pure view logic for the attendee Map tab (mirrors lineup-view.ts:
// everything testable without a DOM lives here).

export const LAYER_LABELS: Record<MapLayer, string> = {
  site: 'Site',
  camp: 'Camping',
  full: 'Full venue',
}

// Category chips. 'all' is the identity filter; every other key matches
// POI category_id exactly ('stage' doubles as the square-marker type).
// Keys come from POI_CATEGORY_IDS in @rallypoint/events-shared — the
// handoff's "Medical"/"Services" map onto the repo's first_aid/lockers.
export const MAP_CATS: readonly (readonly [string, string])[] = [
  ['all', 'All'],
  ['stage', 'Stages'],
  ['food', 'Food'],
  ['first_aid', 'First aid'],
  ['water', 'Water'],
] as const

// Last-viewed layer persistence (per-browser, not per-event — matching
// the handoff prototype's single key).
export const LAYER_STORAGE_KEY = 'rp-att-map-layer'

export function readStoredLayer(
  available: readonly MapLayer[],
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined'
    ? null
    : localStorage,
): MapLayer | null {
  if (available.length === 0) return null
  let saved: string | null = null
  try {
    saved = storage?.getItem(LAYER_STORAGE_KEY) ?? null
  } catch {
    // Storage unavailable (private mode) — fall through to the default.
  }
  return (available as readonly string[]).includes(saved ?? '')
    ? (saved as MapLayer)
    : available[0]!
}

export function storeLayer(
  layer: MapLayer,
  storage: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined'
    ? null
    : localStorage,
): void {
  try {
    storage?.setItem(LAYER_STORAGE_KEY, layer)
  } catch {
    // Best-effort persistence only.
  }
}

// Marker filter: layer (via the POI's map), category chip, and
// case-insensitive name search. A floating POI (null map_id) renders on
// every layer — it has no home map to scope it to.
export function filterMarkers(
  pois: readonly PoiDto[],
  opts: {
    activeMapId: string | null
    category: string
    query: string
  },
): PoiDto[] {
  const q = opts.query.trim().toLowerCase()
  return pois.filter((p) => {
    if (p.map_id !== null && p.map_id !== opts.activeMapId) return false
    if (opts.category !== 'all' && p.category_id !== opts.category) return false
    if (q && !p.name.toLowerCase().includes(q)) return false
    return true
  })
}

// Pointer position → clamped percentage coordinates on the map canvas.
export function pointerToPct(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const clamp = (n: number): number => Math.min(100, Math.max(0, Math.round(n)))
  return {
    x: clamp(((clientX - rect.left) / rect.width) * 100),
    y: clamp(((clientY - rect.top) / rect.height) * 100),
  }
}

// Pick the map whose layer is active, or null when the organizer hasn't
// uploaded that layer.
export function mapForLayer(maps: readonly MapDto[], layer: MapLayer | null): MapDto | null {
  if (layer === null) return null
  return maps.find((m) => m.layer === layer) ?? null
}
