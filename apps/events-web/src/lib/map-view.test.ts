import { describe, expect, it } from 'vitest'
import type { MapDto, PoiDto } from './api.js'
import {
  LAYER_LABELS,
  LAYER_STORAGE_KEY,
  filterMarkers,
  mapForLayer,
  pointerToPct,
  readStoredLayer,
  storeLayer,
} from './map-view.js'

function poi(over: Partial<PoiDto>): PoiDto {
  return {
    id: 'evp_x',
    event_id: 'event_x',
    map_id: 'emp_site',
    category_id: 'food',
    name: 'Noodle Bar',
    description: null,
    x_pct: 50,
    y_pct: 50,
    lat: null,
    lng: null,
    sort_order: 0,
    created_at: '',
    updated_at: '',
    ...over,
  }
}

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    length: 0,
  }
}

describe('layer persistence', () => {
  it('restores the stored layer when it is available', () => {
    const s = fakeStorage({ [LAYER_STORAGE_KEY]: 'camp' })
    expect(readStoredLayer(['site', 'camp'], s)).toBe('camp')
  })

  it('falls back to the first available layer when nothing (or garbage) is stored', () => {
    expect(readStoredLayer(['site', 'camp'], fakeStorage())).toBe('site')
    expect(readStoredLayer(['camp'], fakeStorage({ [LAYER_STORAGE_KEY]: 'parking' }))).toBe('camp')
  })

  it('returns null when no layers are available', () => {
    expect(readStoredLayer([], fakeStorage({ [LAYER_STORAGE_KEY]: 'site' }))).toBeNull()
  })

  it('round-trips through storeLayer', () => {
    const s = fakeStorage()
    storeLayer('full', s)
    expect(readStoredLayer(['site', 'full'], s)).toBe('full')
  })

  it('survives a throwing storage (private mode)', () => {
    const throwing = {
      getItem: () => {
        throw new Error('nope')
      },
    }
    expect(readStoredLayer(['site'], throwing)).toBe('site')
  })
})

describe('filterMarkers', () => {
  const pois = [
    poi({ id: 'p1', name: 'Main Stage', category_id: 'stage', map_id: 'emp_site' }),
    poi({ id: 'p2', name: 'Noodle Bar', category_id: 'food', map_id: 'emp_site' }),
    poi({ id: 'p3', name: 'Camp Medic', category_id: 'first_aid', map_id: 'emp_camp' }),
    poi({ id: 'p4', name: 'Floating Info', category_id: 'info', map_id: null }),
  ]

  it('scopes to the active map, letting floating POIs through everywhere', () => {
    const site = filterMarkers(pois, { activeMapId: 'emp_site', category: 'all', query: '' })
    expect(site.map((p) => p.id)).toEqual(['p1', 'p2', 'p4'])
    const camp = filterMarkers(pois, { activeMapId: 'emp_camp', category: 'all', query: '' })
    expect(camp.map((p) => p.id)).toEqual(['p3', 'p4'])
  })

  it('filters by category chip', () => {
    const stages = filterMarkers(pois, { activeMapId: 'emp_site', category: 'stage', query: '' })
    expect(stages.map((p) => p.id)).toEqual(['p1'])
  })

  it('searches names case-insensitively', () => {
    const hits = filterMarkers(pois, { activeMapId: 'emp_site', category: 'all', query: 'noodle' })
    expect(hits.map((p) => p.id)).toEqual(['p2'])
    expect(
      filterMarkers(pois, { activeMapId: 'emp_site', category: 'all', query: 'NOODLE' }).length,
    ).toBe(1)
  })

  it('combines all three filters', () => {
    expect(
      filterMarkers(pois, { activeMapId: 'emp_site', category: 'food', query: 'stage' }),
    ).toEqual([])
  })
})

describe('pointerToPct', () => {
  const rect = { left: 100, top: 200, width: 400, height: 300 }

  it('maps a pointer position into percentages', () => {
    expect(pointerToPct(rect, 300, 350)).toEqual({ x: 50, y: 50 })
    expect(pointerToPct(rect, 100, 200)).toEqual({ x: 0, y: 0 })
    expect(pointerToPct(rect, 500, 500)).toEqual({ x: 100, y: 100 })
  })

  it('clamps positions outside the canvas', () => {
    expect(pointerToPct(rect, 50, 100)).toEqual({ x: 0, y: 0 })
    expect(pointerToPct(rect, 900, 900)).toEqual({ x: 100, y: 100 })
  })
})

describe('mapForLayer', () => {
  const maps = [
    { id: 'emp_site', layer: 'site' },
    { id: 'emp_camp', layer: 'camp' },
  ] as MapDto[]

  it('resolves the active layer map, null when missing', () => {
    expect(mapForLayer(maps, 'camp')?.id).toBe('emp_camp')
    expect(mapForLayer(maps, 'full')).toBeNull()
    expect(mapForLayer(maps, null)).toBeNull()
  })
})

describe('LAYER_LABELS', () => {
  it('labels every repo layer', () => {
    expect(LAYER_LABELS).toEqual({ site: 'Site', camp: 'Camping', full: 'Full venue' })
  })
})
