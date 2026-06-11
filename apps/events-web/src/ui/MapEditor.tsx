import { useEffect, useRef, useState } from 'react'
import {
  MAP_LAYERS,
  POI_CATEGORY_IDS,
  pixelsToPct,
  validateMapUpload,
  validateMapDimensions,
  type PoiCategoryId,
} from '@rallypoint/events-shared'
import { ConfirmDialog, useToast } from '@rallypoint/ui'
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
const alertCls = 'p-3 text-sm text-[color:var(--ink)]'
const alertStyle = { border: '1.5px solid var(--hot)', background: 'color-mix(in srgb, var(--hot) 12%, transparent)' }

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

  // Zone draw tool
  const [drawing, setDrawing] = useState(false)
  const [draft, setDraft] = useState<ZoneVertex[]>([])

  // Delete-map confirmation dialog
  const [confirmDeleteMapId, setConfirmDeleteMapId] = useState<string | null>(null)
  const [deletingMap, setDeletingMap] = useState(false)

  const imgRef = useRef<HTMLImageElement>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([listMaps(eventId), listPois(eventId), listZones(eventId)])
      .then(([m, p, z]) => {
        if (cancelled) return
        setMaps(m)
        setPois(p)
        setZones(z)
        // Keep the current selection only if it still exists (a collaborator
        // may have deleted the active map); otherwise fall back to the first.
        setActiveMapId((cur) => (cur && m.some((x) => x.id === cur) ? cur : m[0]?.id ?? null))
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load map data.')
      })
    return () => {
      cancelled = true
    }
  }, [eventId, reloadSignal])

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

  async function handleDeletePoi(poiId: string) {
    try {
      await deletePoi(eventId, poiId)
      setPois((prev) => prev.filter((p) => p.id !== poiId))
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
    <div className="p-4 space-y-4" style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}>
      {/* Layer tabs */}
      <div className="flex items-center gap-2 flex-wrap">
        {maps.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setActiveMapId(m.id)}
            className={m.id === activeMapId ? 'chip-solid' : 'chip'}
            style={m.id === activeMapId ? undefined : { color: 'var(--ink-dim)' }}
          >
            {m.layer}
          </button>
        ))}
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
                  fill: 'color-mix(in srgb, var(--hot) 25%, transparent)',
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
              onClick={(e) => e.stopPropagation()}
              title={`${poi.name} (${poi.category_id})`}
              style={{
                left: `${poi.x_pct}%`,
                top: `${poi.y_pct}%`,
                background: 'var(--acid)',
                color: 'var(--bg)',
              }}
              className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/30 px-2 py-0.5 text-[10px] font-medium shadow"
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
          <ul className="space-y-1">
            {mapPois.map((poi) => (
              <li key={poi.id} className="flex items-center gap-2 text-sm">
                <span className="flex-1">
                  {poi.name}{' '}
                  <span className="text-xs text-[color:var(--ink-mute)]">{poi.category_id}</span>
                </span>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => void handleDeletePoi(poi.id)}
                    className={btnDelete}
                    style={{ width: 'auto' }}
                    aria-label={`Delete POI ${poi.name}`}
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Zone list */}
      {mapZones.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-medium text-[color:var(--ink-mute)]">
            No-go zones
          </h4>
          <ul className="space-y-1">
            {mapZones.map((z, i) => (
              <li key={z.id} className="flex items-center gap-2 text-sm">
                <span className="flex-1">
                  Zone {i + 1}{' '}
                  <span className="text-xs text-[color:var(--ink-mute)]">{z.polygon.length} points</span>
                </span>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => void handleDeleteZone(z.id)}
                    className={btnDelete}
                    style={{ width: 'auto' }}
                    aria-label={`Delete zone ${i + 1}`}
                  >
                    ×
                  </button>
                )}
              </li>
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
    </div>
  )
}
