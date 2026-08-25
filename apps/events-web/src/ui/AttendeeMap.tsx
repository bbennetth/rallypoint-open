import { useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Avatar, Icon } from '@rallypoint/ui'
import type { PoiDto, ZoneDto } from '../lib/api.js'
import { pointerToPct } from '../lib/map-view.js'

// Shared attendee map canvas (group Map tab + solo venue-only mode).
// Renders the organizer's uploaded plan image (or the schematic grid
// fallback) with POI/stage markers, no-go zones, crew pins, rally pins,
// and a draft rally pin. All positions are percentage coordinates so
// they survive any render size (handoff §2 positioning model).
//
// Interaction plumbing lives here; state lives in the page:
//   - marker tap → onSelect (toggled by the page)
//   - map tap while "armed" (place-my-pin mode) → onMapTap
//   - ~550ms press-and-hold on empty space → onLongPress (rally draft);
//     cancelled by pointer up/leave/move and ignored when the press
//     starts on a marker/crew/rally pin or while armed.

const LONG_PRESS_MS = 550
// A hold that drifts more than this many px is a pan/scroll, not a press.
const LONG_PRESS_DRIFT_PX = 12

export interface CrewPin {
  userId: string
  displayName: string | null
  xPct: number
  yPct: number
  isSelf: boolean
}

export interface RallyPin {
  id: string
  title: string
  xPct: number
  yPct: number
}

export interface AttendeeMapProps {
  imageUrl: string | null
  layerLabel: string
  markers: readonly PoiDto[]
  zones: readonly ZoneDto[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  crew?: readonly CrewPin[]
  rallies?: readonly RallyPin[]
  draft?: { x: number; y: number } | null
  // Place-my-pin mode: the next map tap reports coordinates instead of
  // selecting/long-pressing.
  armed?: boolean
  onMapTap?: (x: number, y: number) => void
  onLongPress?: (x: number, y: number) => void
  onRallyTap?: (id: string) => void
}

export function AttendeeMap({
  imageUrl,
  layerLabel,
  markers,
  zones,
  selectedId,
  onSelect,
  crew = [],
  rallies = [],
  draft = null,
  armed = false,
  onMapTap,
  onLongPress,
  onRallyTap,
}: AttendeeMapProps) {
  const mapRef = useRef<HTMLDivElement | null>(null)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pressStart = useRef<{ clientX: number; clientY: number } | null>(null)

  // Clear a pending long-press timer if the component unmounts mid-press.
  useEffect(() => {
    return () => {
      if (pressTimer.current !== null) clearTimeout(pressTimer.current)
    }
  }, [])

  const cancelPress = (): void => {
    if (pressTimer.current !== null) clearTimeout(pressTimer.current)
    pressTimer.current = null
    pressStart.current = null
  }

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!onLongPress || armed) return
    // A press starting on an interactive pin is that pin's gesture.
    if ((e.target as HTMLElement).closest('.gm-marker, .am-crew, .am-rally')) return
    const el = mapRef.current
    if (!el) return
    const { x, y } = pointerToPct(el.getBoundingClientRect(), e.clientX, e.clientY)
    pressStart.current = { clientX: e.clientX, clientY: e.clientY }
    pressTimer.current = setTimeout(() => {
      cancelPress()
      onLongPress(x, y)
    }, LONG_PRESS_MS)
  }

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const start = pressStart.current
    if (!start) return
    const drift = Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY)
    if (drift > LONG_PRESS_DRIFT_PX) cancelPress()
  }

  const handleClick = (e: ReactPointerEvent<HTMLDivElement> | React.MouseEvent): void => {
    if (!armed || !onMapTap) return
    if ((e.target as HTMLElement).closest('.gm-marker, .am-crew, .am-rally')) return
    const el = mapRef.current
    if (!el) return
    const { x, y } = pointerToPct(el.getBoundingClientRect(), e.clientX, e.clientY)
    onMapTap(x, y)
  }

  return (
    <div
      ref={mapRef}
      className={`gm-map am-map${armed ? ' is-armed' : ''}`}
      style={imageUrl ? { backgroundImage: 'none', aspectRatio: 'auto' } : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={cancelPress}
      onPointerLeave={cancelPress}
      onClick={handleClick}
    >
      {imageUrl ? (
        <img src={imageUrl} alt={`${layerLabel} plan`} className="am-img" draggable={false} />
      ) : null}
      <span className="gm-label">{layerLabel} plan · N ↑</span>

      {/* No-go zones (SVG overlay, percentage viewBox — mirrors MapEditor). */}
      {zones.length > 0 && (
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="am-zones">
          {zones.map((z) => (
            <polygon
              key={z.id}
              points={z.polygon.map((v) => `${v.xPct},${v.yPct}`).join(' ')}
              style={{
                fill: 'color-mix(in srgb, var(--hot) 22%, transparent)',
                stroke: 'var(--hot)',
              }}
              strokeWidth={0.4}
            />
          ))}
        </svg>
      )}

      {markers.map((p) => (
        <button
          key={p.id}
          type="button"
          className={
            'gm-marker' +
            (p.category_id === 'stage' ? ' stage' : '') +
            (p.id === selectedId ? ' is-sel' : '')
          }
          style={{ left: `${p.x_pct}%`, top: `${p.y_pct}%` }}
          onClick={(e) => {
            e.stopPropagation()
            if (armed && onMapTap) return
            onSelect(p.id === selectedId ? null : p.id)
          }}
          title={p.name}
        >
          <span className="gm-dot" />
          <span className="gm-name">{p.name}</span>
        </button>
      ))}

      {crew.map((m) => (
        <span
          key={m.userId}
          className={'am-crew' + (m.isSelf ? ' me' : '')}
          style={{ left: `${m.xPct}%`, top: `${m.yPct}%` }}
          title={m.isSelf ? 'You' : (m.displayName ?? 'Crew member')}
        >
          <Avatar name={m.displayName} size={26} />
        </span>
      ))}

      {rallies.map((r) => (
        <button
          key={r.id}
          type="button"
          className="am-rally"
          style={{ left: `${r.xPct}%`, top: `${r.yPct}%` }}
          onClick={(e) => {
            e.stopPropagation()
            onRallyTap?.(r.id)
          }}
          title={r.title}
        >
          <span className="ic">
            <Icon name="bell" size={12} />
          </span>
          <span className="tx">{r.title}</span>
        </button>
      ))}

      {draft && (
        <span className="am-rally is-draft" style={{ left: `${draft.x}%`, top: `${draft.y}%` }}>
          <span className="ic">
            <Icon name="bell" size={12} />
          </span>
          <span className="tx">New rally</span>
        </span>
      )}
    </div>
  )
}
