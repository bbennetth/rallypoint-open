import { useEffect, useRef, useState } from 'react'
import {
  MAP_LAYERS,
  POI_CATEGORY_IDS,
  pixelsToPct,
  validateMapUpload,
  validateMapDimensions,
  type PoiCategoryId,
} from '@rallypoint/events-shared'
import { ConfirmDialog, SwipeActions, useToast } from '@rallypoint/ui'
import { useAsyncTask } from '@rallypoint/web-kit'
import { LAYER_LABELS } from '../lib/map-view.js'
import {
  ApiError,
  createPoi,
  createZone,
  deleteMap,
  deletePoi,
  deleteZone,
  listMaps,
  listPois,
  listZones,
  patchPoi,
  uploadMap,
  type MapDto,
  type MapLayer,
  type PoiDto,
  type ZoneDto,
  type ZoneVertex,
} from '../lib/api.js'

const inputCls = 'cyber-input'
const btnPrimary = 'btn-brutal'
const btnGhost = 'btn-ghost'
const btnDelete = 'btn-hot'
const alertCls = 'p-3 text-sm'
const alertStyle = { background: 'var(--hot-soft)', color: 'var(--hot-text)', borderRadius: 'var(--radius-lg)' }

// Decode a File into an HTMLImageElement to read its pixel dimensions
// (the server can't read dimensions from a HEAD — design §3.8).
function decodeImage(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const dims = { width: img.naturalWidth, height: img.naturalHeight }
      URL.revokeObjectURL(url)
      resolve(dims)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not decode image.'))
    }
    img.src = url
  })
}

// `reloadSignal` is bumped by the parent on a realtime map invalidation,
// forcing a silent re-fetch of maps/POIs/zones without remounting (which
// would drop the active map selection and any in-progress zone draft).
export function MapEditor({
  eventId,
  canEdit,
  reloadSignal = 0,
}: {
  eventId: string
  canEdit: boolean
  reloadSignal?: number
}) {
  const toast = useToast()
  const [maps, setMaps] = useState<MapDto[]>([])
  const [pois, setPois] = useState<PoiDto[]>([])
  const [zones, setZones] = useState<ZoneDto[]>([])
  const [activeMapId, setActiveMapId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Upload form
  const [uploadLayer, setUploadLayer] = useState<MapLayer>('site')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // POI placement
  const [category, setCategory] = useState<PoiCategoryId>(POI_CATEGORY_IDS[0])
  const [poiName, setPoiName] = useState('')

  // Selected POI (edit panel: rename / recategorize / arrow nudge)
  const [selectedPoiId, setSelectedPoiId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editCategory, setEditCategory] = useState<PoiCategoryId>(POI_CATEGORY_IDS[0])
  const [savingPoi, setSavingPoi] = useState(false)

  // Zone draw tool
  const [drawing, setDrawing] = useState(false)
  const [draft, setDraft] = useState<ZoneVertex[]>([])

  // Delete-map confirmation dialog
  const [confirmDeleteMapId, setConfirmDeleteMapId] = useState<string | null>(null)
  // Swipe/hover Delete on a POI/zone row stages it here; ConfirmDialog commits.
  const [pendingDelete, setPendingDelete] = useState<
    { kind: 'poi'; id: string; name: string } | { kind: 'zone'; id: string; name: string } | null
  >(null)
  const [deletingMap, setDeletingMap] = useState(false)

  const imgRef = useRef<HTMLImageElement>(null)

  const run = useAsyncTask()
  useEffect(() => {
    void run(async (ctx) => {
      try {
        const [m, p, z] = await Promise.all([listMaps(eventId), listPois(eventId), listZones(eventId)])
        if (ctx.stale()) return
        setMaps(m)
        setPois(p)
        setZones(z)
        // Keep the current selection only if it still exists (a collaborator
        // may have deleted the active map); otherwise fall back to the first.
        setActiveMapId((cur) => (cur && m.some((x) => x.id === cur) ? cur : m[0]?.id ?? null))
      } catch (err) {
        if (ctx.stale()) return
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load map data.')
      }
    })
  }, [eventId, reloadSignal, run])

  const activeMap = maps.find((m) => m.id === activeMapId) ?? null
  const mapPois = pois.filter((p) => p.map_id === activeMapId)
  const mapZones = zones.filter((z) => z.map_id === activeMapId)

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault()
    setUploadError(null)
    const file = fileInputRef.current?.files?.[0]
    if (!file) {
      setUploadError('Please choose an image file.')
      return
    }
    const upCheck = validateMapUpload({ contentType: file.type, contentLength: file.size })
    if (!upCheck.ok) {
      setUploadError(
        upCheck.code === 'unsupported_image_type'
          ? 'Image must be JPEG, PNG, or WebP.'
          : 'Image must be at most 10 MB.',
      )
      return
    }
    setUploading(true)
    try {
      const dims = await decodeImage(file)
      const dimCheck = validateMapDimensions({ widthPx: dims.width, heightPx: dims.height })
      if (!dimCheck.ok) {
        setUploadError(
          dimCheck.code === 'image_too_small'
            ? `Image ${dimCheck.dimension} must be at least 512px.`
            : `Image ${dimCheck.dimension} must be at most 4096px.`,
        )
        setUploading(false)
        return
      }
      // Single same-origin upload (#409): one multipart POST to the Worker.
      const map = await uploadMap(eventId, {
        file,
        layer: uploadLayer,
        widthPx: dims.width,
        heightPx: dims.height,
      })
      setMaps((prev) => [...prev.filter((m) => m.id !== map.id), map])
      setActiveMapId(map.id)
      if (fileInputRef.current) fileInputRef.current.value = ''
    } catch (err) {
      if (err instanceof ApiError && err.code === 'map_layer_taken') {
        setUploadError('A map for that layer already exists. Delete it first.')
      } else {
        setUploadError(err instanceof ApiError ? err.message : 'Upload failed.')
      }
    } finally {
      setUploading(false)
    }
  }

  async function confirmDeleteMap() {
    if (!confirmDeleteMapId) return
    const mapId = confirmDeleteMapId
    setDeletingMap(true)
    try {
      await deleteMap(eventId, mapId)
      setMaps((prev) => prev.filter((m) => m.id !== mapId))
      setZones((prev) => prev.filter((z) => z.map_id !== mapId))
      setPois((prev) => prev.map((p) => (p.map_id === mapId ? { ...p, map_id: null } : p)))
      setActiveMapId((cur) => (cur === mapId ? null : cur))
      setConfirmDeleteMapId(null)
      toast({ tone: 'success', body: 'Map deleted.' })
    } catch (err) {
      toast({ tone: 'error', body: err instanceof ApiError ? err.message : 'Delete failed.' })
    } finally {
      setDeletingMap(false)
    }
  }

  // Convert a pointer event to a percentage point on the rendered image.
  function eventToPct(e: React.PointerEvent | React.MouseEvent): ZoneVertex {
    const img = imgRef.current!
    const rect = img.getBoundingClientRect()
    return pixelsToPct(
      { x: e.clientX - rect.left, y: e.clientY - rect.top },
      { width: rect.width, height: rect.height },
    )
  }

  async function handleCanvasClick(e: React.MouseEvent) {
    if (!canEdit || !activeMap) return
    const pt = eventToPct(e)
    if (drawing) {
      setDraft((prev) => [...prev, pt])
      return
    }
    // Place a POI.
    if (!poiName.trim()) {
      setUploadError('Enter a POI name before placing it on the map.')
      return
    }
    setUploadError(null)
    try {
      const poi = await createPoi(eventId, {
        categoryId: category,
        name: poiName.trim(),
        mapId: activeMap.id,
        xPct: pt.xPct,
        yPct: pt.yPct,
      })
      setPois((prev) => [...prev, poi])
      setPoiName('')
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : 'Failed to add POI.')
    }
  }

  // Drag a POI marker to a new position; PATCH on drop.
  async function handlePoiDrop(poi: PoiDto, e: React.PointerEvent) {
    if (!canEdit) return
    const pt = eventToPct(e)
    setPois((prev) =>
      prev.map((p) =>
        p.id === poi.id ? { ...p, x_pct: pt.xPct, y_pct: pt.yPct } : p,
      ),
    )
    try {
      await patchPoi(eventId, poi.id, { xPct: pt.xPct, yPct: pt.yPct })
    } catch {
      // On failure, reload to restore truth.
      void listPois(eventId).then(setPois)
    }
  }

  function selectPoi(poi: PoiDto): void {
    if (selectedPoiId === poi.id) {
      setSelectedPoiId(null)
      return
    }
    setEditName(poi.name)
    setEditCategory(poi.category_id as PoiCategoryId)
    setSelectedPoiId(poi.id)
  }

  async function handleSavePoiEdit(poi: PoiDto) {
    if (!editName.trim()) return
    setSavingPoi(true)
    try {
      const updated = await patchPoi(eventId, poi.id, {
        name: editName.trim(),
        categoryId: editCategory,
      })
      setPois((prev) => prev.map((p) => (p.id === poi.id ? updated : p)))
      toast({ tone: 'success', body: 'POI updated.' })
    } catch (err) {
      toast({ tone: 'error', body: err instanceof ApiError ? err.message : 'Failed to update POI.' })
    } finally {
      setSavingPoi(false)
    }
  }

  // Arrow-button nudge: ±2% clamped to 2–98 (drag is poor on mobile).
  async function handleNudgePoi(poi: PoiDto, dx: number, dy: number) {
    const clamp = (n: number): number => Math.min(98, Math.max(2, n))
    const xPct = clamp(poi.x_pct + dx)
    const yPct = clamp(poi.y_pct + dy)
    setPois((prev) => prev.map((p) => (p.id === poi.id ? { ...p, x_pct: xPct, y_pct: yPct } : p)))
    try {
      await patchPoi(eventId, poi.id, { xPct, yPct })
    } catch {
      void listPois(eventId).then(setPois)
    }
  }

  async function handleDeletePoi(poiId: string) {
    try {
      await deletePoi(eventId, poiId)
      setPois((prev) => prev.filter((p) => p.id !== poiId))
      setSelectedPoiId((cur) => (cur === poiId ? null : cur))
    } catch (err) {
      toast({ tone: 'error', body: err instanceof ApiError ? err.message : 'Failed to delete POI.' })
    }
  }

  async function handleSaveZone() {
    if (!activeMap || draft.length < 3) {
      setUploadError('A zone needs at least 3 points.')
      return
    }
    try {
      const zone = await createZone(eventId, { mapId: activeMap.id, polygon: draft })
      setZones((prev) => [...prev, zone])
      setDraft([])
      setDrawing(false)
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : 'Failed to save zone.')
    }
  }

  async function handleDeleteZone(zoneId: string) {
    try {
      await deleteZone(eventId, zoneId)
      setZones((prev) => prev.filter((z) => z.id !== zoneId))
    } catch (err) {
      toast({ tone: 'error', body: err instanceof ApiError ? err.message : 'Failed to delete zone.' })
    }
  }

  if (loadError) {
    return (
      <div role="alert" className={alertCls} style={alertStyle}>
        {loadError}
      </div>
    )
  }

  const polygonPoints = (poly: ZoneVertex[]): string =>
    poly.map((v) => `${v.xPct},${v.yPct}`).join(' ')

  return (
    <div className="p-4 space-y-4 pl-card">
      {/* Layer tabs — all three layers; uploaded ones carry an · IMG
          suffix, empty ones (editors only) pre-select the upload form. */}
      <div className="flex items-center gap-2 flex-wrap">
        {MAP_LAYERS.map((layer) => {
          const m = maps.find((x) => x.layer === layer)
          if (!m && !canEdit) return null
          const isActive = m ? m.id === activeMapId : uploadLayer === layer && !activeMap
          return (
            <button
              key={layer}
              type="button"
              onClick={() => {
                if (m) {
                  setActiveMapId(m.id)
                } else {
                  setUploadLayer(layer)
                  setActiveMapId(null)
                }
              }}
              className={isActive ? 'chip-solid' : 'chip'}
              style={isActive ? undefined : { color: 'var(--ink-dim)' }}
            >
              {LAYER_LABELS[layer]}
              {m ? ' · IMG' : ''}
            </button>
          )
        })}
        {maps.length === 0 && <p className="text-xs text-[color:var(--ink-mute)]">No maps uploaded yet.</p>}
      </div>

      {/* Upload form */}
      {canEdit && (
        <form onSubmit={(e) => void handleUpload(e)} className="flex items-end gap-2 flex-wrap">
          <div className="space-y-1">
            <label htmlFor="map-layer" className="block text-xs font-medium text-[color:var(--ink-mute)]">
              Layer
            </label>
            <select
              id="map-layer"
              value={uploadLayer}
              onChange={(e) => setUploadLayer(e.target.value as MapLayer)}
              className={inputCls}
            >
              {MAP_LAYERS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="map-file" className="block text-xs font-medium text-[color:var(--ink-mute)]">
              Image (JPEG/PNG/WebP, ≤10MB, 512–4096px)
            </label>
            <input
              id="map-file"
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="text-sm text-[color:var(--ink)] file:mr-3 file:border-0 file:px-3 file:py-1.5 file:text-[var(--ink-dim)]"
              style={{ background: 'var(--surface-2)' }}
            />
          </div>
          <button type="submit" disabled={uploading} className={btnPrimary} style={{ width: 'auto' }}>
            {uploading ? 'Uploading…' : 'Upload map'}
          </button>
        </form>
      )}

      {uploadError && (
        <div role="alert" className={alertCls} style={alertStyle}>
          {uploadError}
        </div>
      )}

      {/* Editor controls */}
      {canEdit && activeMap && (
        <div className="flex items-center gap-2 flex-wrap text-sm">
          {!drawing && (
            <>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as PoiCategoryId)}
                className={inputCls}
                aria-label="POI category"
              >
                {POI_CATEGORY_IDS.map((c) => (
                  <option key={c} value={c}>
                    {c.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={poiName}
                onChange={(e) => setPoiName(e.target.value)}
                placeholder="POI name, then click the map"
                className={`${inputCls} flex-1 min-w-48`}
              />
              <button type="button" onClick={() => setDrawing(true)} className={btnGhost} style={{ width: 'auto' }}>
                Draw no-go zone
              </button>
            </>
          )}
          {drawing && (
            <>
              <span className="text-[color:var(--ink)]">
                Click the map to add points ({draft.length}).
              </span>
              <button
                type="button"
                onClick={() => void handleSaveZone()}
                disabled={draft.length < 3}
                className={btnPrimary}
                style={{ width: 'auto' }}
              >
                Save zone
              </button>
              <button
                type="button"
                onClick={() => {
                  setDrawing(false)
                  setDraft([])
                }}
                className={btnGhost}
                style={{ width: 'auto' }}
              >
                Cancel
              </button>
            </>
          )}
          <button type="button" onClick={() => setConfirmDeleteMapId(activeMap.id)} className={btnDelete} style={{ width: 'auto' }}>
            Delete map
          </button>
        </div>
      )}

      {/* Canvas overlay */}
      {activeMap && (
        <div className="relative inline-block max-w-full select-none">
          <img
            ref={imgRef}
            src={`/api/v1/ui/events/${eventId}/maps/${activeMap.id}/image`}
            alt={`${activeMap.layer} map`}
            onClick={(e) => void handleCanvasClick(e)}
            className={`block max-w-full h-auto rounded ${
              canEdit ? (drawing ? 'cursor-crosshair' : 'cursor-copy') : ''
            }`}
          />

          {/* No-go zones (SVG overlay, percentage viewBox) */}
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="pointer-events-none absolute inset-0 h-full w-full"
          >
            {mapZones.map((z) => (
              <polygon
                key={z.id}
                points={polygonPoints(z.polygon)}
                style={{
                  fill: 'color-mix(in srgb, var(--hot) 22%, transparent)',
                  stroke: 'var(--hot)',
                }}
                strokeWidth={0.4}
              />
            ))}
            {draft.length > 0 && (
              <polygon
                points={polygonPoints(draft)}
                style={{
                  fill: 'color-mix(in srgb, var(--acid) 20%, transparent)',
                  stroke: 'var(--acid)',
                  strokeDasharray: '2 1.2',
                }}
                strokeWidth={0.4}
              />
            )}
          </svg>

          {/* POI markers */}
          {mapPois.map((poi) => (
            <button
              key={poi.id}
              type="button"
              draggable={false}
              // Capture the pointer so the drop fires on this marker even
              // when the release lands away from it (otherwise the move
              // never persists). Stop the click bubbling to the canvas so
              // dragging a POI doesn't also place a new one.
              onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
              onPointerUp={(e) => void handlePoiDrop(poi, e)}
              onClick={(e) => {
                e.stopPropagation()
                if (canEdit) selectPoi(poi)
              }}
              title={`${poi.name} (${poi.category_id})`}
              style={{
                left: `${poi.x_pct}%`,
                top: `${poi.y_pct}%`,
                background: 'var(--acid)',
                color: 'var(--bg)',
                border: '2px solid var(--surface)',
                boxShadow: 'var(--shadow-card)',
              }}
              className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full px-2 py-0.5 text-[10px] font-medium"
            >
              {poi.name}
            </button>
          ))}
        </div>
      )}

      {/* POI list */}
      {mapPois.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-medium text-[color:var(--ink-mute)]">POIs</h4>
          <ul className="space-y-2">
            {mapPois.map((poi) => (
              <SwipeActions
                key={poi.id}
                as="li"
                contentClassName="ev-editrow text-sm"
                actions={
                  canEdit
                    ? [
                        {
                          key: 'delete',
                          label: `Delete POI ${poi.name}`,
                          icon: <>✕</>,
                          onAction: () => setPendingDelete({ kind: 'poi', id: poi.id, name: poi.name }),
                        },
                      ]
                    : []
                }
              >
                <button
                  type="button"
                  className="flex-1 text-left"
                  style={{ all: 'unset', cursor: canEdit ? 'pointer' : 'default', flex: 1 }}
                  onClick={() => canEdit && selectPoi(poi)}
                >
                  {poi.name}{' '}
                  <span className="text-xs text-[color:var(--ink-mute)]">{poi.category_id}</span>
                  {poi.id === selectedPoiId && (
                    <span className="text-xs" style={{ color: 'var(--acid)' }}>
                      {' '}
                      · editing
                    </span>
                  )}
                </button>
              </SwipeActions>
            ))}
          </ul>
        </div>
      )}

      {/* Selected-POI edit panel: name/category + arrow nudge (handoff §3). */}
      {canEdit &&
        (() => {
          const sel = mapPois.find((p) => p.id === selectedPoiId)
          if (!sel) return null
          const nudge = (dx: number, dy: number, label: string) => (
            <button
              type="button"
              className={btnGhost}
              style={{ width: 34, padding: '4px 0', textAlign: 'center' }}
              aria-label={label}
              onClick={() => void handleNudgePoi(sel, dx, dy)}
            >
              {label}
            </button>
          )
          return (
            <div className="p-3 space-y-2" style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-lg)' }}>
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-xs font-medium text-[color:var(--ink-mute)]">Edit POI</h4>
                <button
                  type="button"
                  className="text-xs"
                  style={{ all: 'unset', cursor: 'pointer', color: 'var(--ink-mute)' }}
                  onClick={() => setSelectedPoiId(null)}
                >
                  Close
                </button>
              </div>
              <div className="flex items-end gap-2 flex-wrap">
                <div className="space-y-1">
                  <label htmlFor="poi-edit-name" className="block text-xs font-medium text-[color:var(--ink-mute)]">
                    Name
                  </label>
                  <input
                    id="poi-edit-name"
                    className={inputCls}
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="poi-edit-cat" className="block text-xs font-medium text-[color:var(--ink-mute)]">
                    Category
                  </label>
                  <select
                    id="poi-edit-cat"
                    className={inputCls}
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value as PoiCategoryId)}
                  >
                    {POI_CATEGORY_IDS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  className={btnPrimary}
                  style={{ width: 'auto' }}
                  disabled={savingPoi || !editName.trim()}
                  onClick={() => void handleSavePoiEdit(sel)}
                >
                  {savingPoi ? 'Saving…' : 'Save'}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-[color:var(--ink-mute)]">
                  Nudge ({Math.round(sel.x_pct)}%, {Math.round(sel.y_pct)}%)
                </span>
                {nudge(0, -2, '↑')}
                {nudge(0, 2, '↓')}
                {nudge(-2, 0, '←')}
                {nudge(2, 0, '→')}
              </div>
            </div>
          )
        })()}

      {/* Zone list */}
      {mapZones.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-medium text-[color:var(--ink-mute)]">
            No-go zones
          </h4>
          <ul className="space-y-2">
            {mapZones.map((z, i) => (
              <SwipeActions
                key={z.id}
                as="li"
                contentClassName="ev-editrow text-sm"
                actions={
                  canEdit
                    ? [
                        {
                          key: 'delete',
                          label: `Delete zone ${i + 1}`,
                          icon: <>✕</>,
                          onAction: () => setPendingDelete({ kind: 'zone', id: z.id, name: `Zone ${i + 1}` }),
                        },
                      ]
                    : []
                }
              >
                <span className="flex-1">
                  Zone {i + 1}{' '}
                  <span className="text-xs text-[color:var(--ink-mute)]">{z.polygon.length} points</span>
                </span>
              </SwipeActions>
            ))}
          </ul>
        </div>
      )}

      <ConfirmDialog
        open={confirmDeleteMapId !== null}
        title="Delete this map?"
        body="Its no-go zones are removed and POIs detach from the map."
        confirmLabel="Delete"
        confirmVariant="hot"
        busy={deletingMap}
        onCancel={() => {
          if (!deletingMap) setConfirmDeleteMapId(null)
        }}
        onConfirm={() => void confirmDeleteMap()}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete?.kind === 'poi' ? 'Delete POI?' : 'Delete zone?'}
        body={pendingDelete ? `Remove “${pendingDelete.name}” from this map.` : undefined}
        confirmLabel="Delete"
        confirmVariant="hot"
        onConfirm={async () => {
          if (!pendingDelete) return
          const { kind, id } = pendingDelete
          setPendingDelete(null)
          if (kind === 'poi') await handleDeletePoi(id)
          else await handleDeleteZone(id)
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  )
}
