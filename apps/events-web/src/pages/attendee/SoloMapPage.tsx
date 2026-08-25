import { useCallback, useEffect, useMemo, useState } from 'react'
import { EmptyState } from '@rallypoint/ui'
import { useAsyncTask } from '@rallypoint/web-kit'
import {
  listMaps,
  listPois,
  listZones,
  type MapDto,
  type MapLayer,
  type PoiDto,
  type ZoneDto,
} from '../../lib/api.js'
import {
  LAYER_LABELS,
  MAP_CATS,
  filterMarkers,
  mapForLayer,
  readStoredLayer,
  storeLayer,
} from '../../lib/map-view.js'
import { useRefreshBus } from '../../lib/refresh-bus.js'
import { subscribeEventStream } from '../../lib/realtime.js'
import { AttendeeMap } from '../../ui/AttendeeMap.js'
import { useSoloEventOutlet } from './_solo-event-outlet.js'

// Map tab in the solo shell (took Social's nav slot). Venue-only mode
// of the shared AttendeeMap: layers + POIs + no-go zones with search
// and category filters — no crew pins, rally pins, or long-press rally
// creation (those are group-coupled). Solo attendees always carry an
// event_members viewer row, so the event-scoped reads and event
// realtime channel work directly.

type LoadState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string }

export function SoloMapPage() {
  const { event } = useSoloEventOutlet()

  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [maps, setMaps] = useState<MapDto[]>([])
  const [pois, setPois] = useState<PoiDto[]>([])
  const [zones, setZones] = useState<ZoneDto[]>([])
  const [layer, setLayerState] = useState<MapLayer | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const run = useAsyncTask()
  const load = useCallback(() => {
    void run(async (ctx) => {
      try {
        const [m, p, z] = await Promise.all([
          listMaps(event.id),
          listPois(event.id).catch(() => [] as PoiDto[]),
          listZones(event.id).catch(() => [] as ZoneDto[]),
        ])
        if (ctx.stale()) return
        setMaps(m)
        setPois(p)
        setZones(z)
        setLayerState((prev) => {
          const available = m.map((x) => x.layer)
          if (prev && available.includes(prev)) return prev
          return readStoredLayer(available)
        })
        setState({ status: 'ready' })
      } catch (err) {
        if (ctx.stale()) return
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : 'Failed to load the map.',
        })
      }
    })
  }, [event.id, run])

  useEffect(() => {
    load()
  }, [load])
  useRefreshBus(load)

  useEffect(() => {
    return subscribeEventStream(event.id, {
      onEvent: (env) => {
        if (env.resource !== 'maps' && env.resource !== 'pois' && env.resource !== 'no_go_zones')
          return
        load()
      },
      onReconnect: load,
    })
  }, [event.id, load])

  const setLayer = (next: MapLayer): void => {
    setLayerState(next)
    storeLayer(next)
    setSelectedId(null)
  }

  const activeMap = mapForLayer(maps, layer)
  const markers = useMemo(
    () => filterMarkers(pois, { activeMapId: activeMap?.id ?? null, category, query }),
    [pois, activeMap, category, query],
  )
  const activeZones = useMemo(
    () => (activeMap ? zones.filter((z) => z.map_id === activeMap.id) : []),
    [zones, activeMap],
  )
  const selected = markers.find((p) => p.id === selectedId) ?? null

  if (state.status === 'loading') {
    return (
      <main className="page-pad">
        <p className="text-sm text-[color:var(--ink-dim)]">Loading map…</p>
      </main>
    )
  }

  if (state.status === 'error') {
    return (
      <main className="page-pad">
        <p className="text-sm" style={{ color: 'var(--hot)' }}>
          {state.message}
        </p>
      </main>
    )
  }

  if (maps.length === 0 || layer === null) {
    return (
      <main className="page-pad">
        <div className="max-w-xl mx-auto">
          <EmptyState
            title="No maps yet"
            body={
              <>
                The organizer hasn&rsquo;t uploaded a site map for <strong>{event.name}</strong>{' '}
                yet. Check back closer to the event.
              </>
            }
          />
        </div>
      </main>
    )
  }

  return (
    <main className="page-pad">
      <div className="max-w-3xl mx-auto">
        <header style={{ marginBottom: 8 }}>
          <span className="am-eyebrow">Map · {event.name}</span>
          <h1 className="text-xl font-semibold mt-1" style={{ color: 'var(--ink)' }}>
            Site map
          </h1>
        </header>

        <div className="am-bar">
          <div className="am-layers" role="tablist" aria-label="Map layers">
            {maps.map((m) => (
              <button
                key={m.id}
                type="button"
                role="tab"
                aria-selected={m.layer === layer}
                className={'am-layer' + (m.layer === layer ? ' on' : '')}
                onClick={() => setLayer(m.layer)}
              >
                {LAYER_LABELS[m.layer]}
              </button>
            ))}
          </div>
        </div>

        <div className="am-bar">
          <input
            className="pl-input am-search"
            placeholder="Search the map…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="loc-chiprow">
            {MAP_CATS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={'loc-chip' + (category === key ? ' is-active' : '')}
                onClick={() => setCategory(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <AttendeeMap
          imageUrl={
            activeMap
              ? `/api/v1/ui/events/${encodeURIComponent(event.id)}/maps/${encodeURIComponent(activeMap.id)}/image`
              : null
          }
          layerLabel={LAYER_LABELS[layer]}
          markers={markers}
          zones={activeZones}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />

        <div className="am-legend">
          <span>
            <span className="sq" />
            Stage
          </span>
          <span>
            <span className="ci" />
            POI
          </span>
        </div>

        {selected && (
          <div className="am-selrow">
            <span className="am-selcat">
              {selected.category_id === 'stage' ? 'Stage' : selected.category_id}
            </span>
            <span className="nm">{selected.name}</span>
            <button type="button" className="am-clear" onClick={() => setSelectedId(null)}>
              Clear
            </button>
          </div>
        )}
      </div>
    </main>
  )
}
