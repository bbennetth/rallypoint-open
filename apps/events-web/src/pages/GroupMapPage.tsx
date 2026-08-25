import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { EmptyState, useToast } from '@rallypoint/ui'
import { useAsyncTask } from '@rallypoint/web-kit'
import {
  createRally,
  deleteMyMapPin,
  groupMapImageUrl,
  listGroupMaps,
  listGroupPois,
  listGroupZones,
  listMemberLocations,
  listRallies,
  putMyMapPin,
  type MapDto,
  type MapLayer,
  type MemberLocationDto,
  type PoiDto,
  type RallyDto,
  type ZoneDto,
} from '../lib/api.js'
import {
  LAYER_LABELS,
  MAP_CATS,
  filterMarkers,
  mapForLayer,
  readStoredLayer,
  storeLayer,
} from '../lib/map-view.js'
import { useRefreshBus } from '../lib/refresh-bus.js'
import { shouldRefetch, subscribeEventStream, subscribeGroupStream } from '../lib/realtime.js'
import { useActiveGroupStore } from '../stores/active-group.js'
import { useAttendeeOutlet } from '../ui/AttendeeChrome.js'
import { AttendeeMap, type CrewPin, type RallyPin } from '../ui/AttendeeMap.js'

// Map tab in the group shell (took Social's nav slot). One place to see
// the venue, find services, see where your crew pinned themselves, and
// rally people to a spot. Data comes from the group-scoped mirror reads
// (code-joined members have no event_members row); crew pins + rallies
// go live over the group channel, map/POI/zone edits over the event
// channel (widened token gate).

type LoadState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string }

export function GroupMapPage() {
  const { groupId } = useParams<{ groupId: string }>()
  const { userId } = useAttendeeOutlet()
  const eventName = useActiveGroupStore((s) => s.eventName)
  const eventId = useActiveGroupStore((s) => s.eventId)
  const navigate = useNavigate()
  const toast = useToast()

  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [maps, setMaps] = useState<MapDto[]>([])
  const [pois, setPois] = useState<PoiDto[]>([])
  const [zones, setZones] = useState<ZoneDto[]>([])
  const [locations, setLocations] = useState<MemberLocationDto[]>([])
  const [rallies, setRallies] = useState<RallyDto[]>([])

  const [layer, setLayerState] = useState<MapLayer | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Place-my-pin mode: next map tap saves the caller's crew pin.
  const [placing, setPlacing] = useState(false)
  // Long-press rally draft + its bottom-sheet form.
  const [draft, setDraft] = useState<{ x: number; y: number } | null>(null)
  const [rallyTitle, setRallyTitle] = useState('')
  const [rallyTime, setRallyTime] = useState('')
  const [savingRally, setSavingRally] = useState(false)

  const run = useAsyncTask()
  const load = useCallback(() => {
    if (!groupId) return
    void run(async (ctx) => {
      try {
        const [m, p, z, locs, r] = await Promise.all([
          listGroupMaps(groupId),
          listGroupPois(groupId).catch(() => [] as PoiDto[]),
          listGroupZones(groupId).catch(() => [] as ZoneDto[]),
          listMemberLocations(groupId).catch(() => [] as MemberLocationDto[]),
          listRallies(groupId).catch(() => [] as RallyDto[]),
        ])
        if (ctx.stale()) return
        setMaps(m)
        setPois(p)
        setZones(z)
        setLocations(locs)
        setRallies(r)
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
  }, [groupId, run])

  useEffect(() => {
    load()
  }, [load])
  useRefreshBus(load)

  // Group channel: crew pins + rallies mutate member-side, refetch on
  // envelopes we didn't author. Reconnect reconciles anything missed.
  useEffect(() => {
    if (!groupId) return
    return subscribeGroupStream(groupId, {
      onEvent: (env) => {
        if (env.resource !== 'rallies' && env.resource !== 'member_locations') return
        if (!shouldRefetch(env, userId)) return
        load()
      },
      onReconnect: load,
    })
  }, [groupId, userId, load])

  // Event channel: map/POI/zone edits by the organizer.
  useEffect(() => {
    if (!eventId) return
    return subscribeEventStream(eventId, {
      onEvent: (env) => {
        if (env.resource !== 'maps' && env.resource !== 'pois' && env.resource !== 'no_go_zones')
          return
        if (!shouldRefetch(env, userId)) return
        load()
      },
    })
  }, [eventId, userId, load])

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
  const crew: CrewPin[] = useMemo(
    () =>
      locations
        .filter((l) => l.layer === layer)
        .map((l) => ({
          userId: l.user_id,
          displayName: l.display_name,
          xPct: l.x_pct,
          yPct: l.y_pct,
          isSelf: l.user_id === userId,
        })),
    [locations, layer, userId],
  )
  const rallyPins: RallyPin[] = useMemo(
    () =>
      rallies
        .filter((r) => r.pin !== null && r.pin.layer === layer && r.status !== 'cancelled')
        .map((r) => ({ id: r.id, title: r.title, xPct: r.pin!.x_pct, yPct: r.pin!.y_pct })),
    [rallies, layer],
  )
  const myPin = locations.find((l) => l.user_id === userId) ?? null
  const selected = markers.find((p) => p.id === selectedId) ?? null

  const placeMyPin = async (x: number, y: number): Promise<void> => {
    if (!groupId || !layer) return
    setPlacing(false)
    try {
      const saved = await putMyMapPin(groupId, { layer, xPct: x, yPct: y })
      setLocations((prev) => [...prev.filter((l) => l.user_id !== userId), saved])
      toast({ tone: 'success', body: 'Pin placed — your crew can see you.' })
    } catch {
      toast({ tone: 'error', body: 'Could not place your pin.' })
    }
  }

  const removeMyPin = async (): Promise<void> => {
    if (!groupId) return
    try {
      await deleteMyMapPin(groupId)
      setLocations((prev) => prev.filter((l) => l.user_id !== userId))
      toast({ tone: 'success', body: 'Pin removed.' })
    } catch {
      toast({ tone: 'error', body: 'Could not remove your pin.' })
    }
  }

  const openDraft = (x: number, y: number): void => {
    setDraft({ x, y })
    setRallyTitle('')
    setRallyTime('')
  }

  const pinRally = async (): Promise<void> => {
    if (!groupId || !layer || !draft || !rallyTitle.trim()) return
    setSavingRally(true)
    try {
      const created = await createRally(groupId, {
        title: rallyTitle.trim(),
        ...(rallyTime ? { startTime: rallyTime } : {}),
        locationLabel: `Pinned on the ${LAYER_LABELS[layer].toLowerCase()} map`,
        pinLayer: layer,
        pinXPct: draft.x,
        pinYPct: draft.y,
      })
      setRallies((prev) => [created, ...prev])
      setDraft(null)
      toast({ tone: 'success', body: 'Rally pinned — crew notified.' })
    } catch {
      toast({ tone: 'error', body: 'Could not pin the rally.' })
    } finally {
      setSavingRally(false)
    }
  }

  if (!groupId) return null

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
            body="The organizer hasn't uploaded a site map yet. Check back closer to the event."
          />
        </div>
      </main>
    )
  }

  const layerLabel = LAYER_LABELS[layer]

  return (
    <main className="page-pad">
      <div className="max-w-3xl mx-auto">
        <header style={{ marginBottom: 8 }}>
          <span className="am-eyebrow">Map{eventName ? ` · ${eventName}` : ''}</span>
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
          <div className="am-pinctl">
            <button
              type="button"
              className={'am-pinbtn' + (placing ? ' is-armed' : '')}
              onClick={() => setPlacing((p) => !p)}
            >
              {placing ? 'Tap the map…' : myPin ? 'Move my pin' : 'Drop my pin'}
            </button>
            {myPin && !placing && (
              <button type="button" className="am-clear" onClick={() => void removeMyPin()}>
                Remove pin
              </button>
            )}
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
          imageUrl={activeMap ? groupMapImageUrl(groupId, activeMap.id) : null}
          layerLabel={layerLabel}
          markers={markers}
          zones={activeZones}
          selectedId={selectedId}
          onSelect={setSelectedId}
          crew={crew}
          rallies={rallyPins}
          draft={draft}
          armed={placing}
          onMapTap={(x, y) => void placeMyPin(x, y)}
          onLongPress={openDraft}
          onRallyTap={() => void navigate(`/groups/${encodeURIComponent(groupId)}/rallies`)}
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
          <span>
            <span className="av" />
            Crew
          </span>
          <span>
            <span className="ry">◆</span>
            Rally
          </span>
          <span className="hint">Press &amp; hold the map to pin a rally</span>
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

        {draft && (
          <div className="lu-sheet-scrim" onClick={() => setDraft(null)}>
            <div
              className="lu-sheet"
              role="dialog"
              aria-label="New rally"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="lu-sheet-hd">
                <div style={{ minWidth: 0 }}>
                  <div className="am-eyebrow">New rally</div>
                  <div style={{ fontSize: 17, fontWeight: 800, marginTop: 2, color: 'var(--ink)' }}>
                    Rally here
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10.5,
                      color: 'var(--ink-dim)',
                      marginTop: 3,
                    }}
                  >
                    {layerLabel} plan · {draft.x}%, {draft.y}% · your group sees the pin
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setDraft(null)}
                  aria-label="Close"
                  style={{
                    all: 'unset',
                    cursor: 'pointer',
                    width: 40,
                    height: 40,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--ink-dim)',
                    fontSize: 18,
                  }}
                >
                  ✕
                </button>
              </div>
              <div className="lu-sheet-body">
                <input
                  className="pl-input"
                  placeholder="What's the plan? (e.g. Meet at the med tent)"
                  value={rallyTitle}
                  onChange={(e) => setRallyTitle(e.target.value)}
                  autoFocus
                  style={{ marginBottom: 10, width: '100%' }}
                />
                <input
                  className="pl-input"
                  type="time"
                  aria-label="Time"
                  value={rallyTime}
                  onChange={(e) => setRallyTime(e.target.value)}
                  style={{ marginBottom: 12, width: '100%' }}
                />
                <button
                  type="button"
                  className="am-pinbtn is-primary"
                  style={{ width: '100%', opacity: rallyTitle.trim() ? 1 : 0.5 }}
                  disabled={!rallyTitle.trim() || savingRally}
                  onClick={() => void pinRally()}
                >
                  {savingRally ? 'Pinning…' : 'Pin rally'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
