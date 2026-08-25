// Full-screen in-app viewer for an event ticket attachment. Replaces the old
// window.open('_blank') flow, which in the installed PWA opened a chromeless
// window with no way back to the event. Deliberately NOT a second <Drawer>
// nested inside the event-detail drawer: stacked Drawers can't coordinate
// (both listen for Escape/Tab on document, so one keypress would act on
// both), so this is a self-contained overlay layered above the drawer stack.
// Escape and Tab are handled in the CAPTURE phase with stopPropagation so the
// underlying Drawer's bubble-phase document listeners never fire while the
// viewer is open.

import { useEffect, useRef, useState } from 'react'
import { captureEvent } from '@rallypoint/web-kit'
import { Icon } from './icons.js'
import { getTicketDownloadUrl, type TicketDto } from '../lib/api.js'
import { ticketViewKind } from '../lib/events-helpers.js'

export function TicketViewer({
  eventId,
  ticket,
  onClose,
  onDownload,
}: {
  eventId: string
  ticket: TicketDto
  onClose: () => void
  onDownload: (ticket: TicketDto) => void
}) {
  const kind = ticketViewKind(ticket.contentType)
  const url = getTicketDownloadUrl(eventId, ticket.id)
  const label = ticket.fileName ?? 'Ticket'
  const rootRef = useRef<HTMLDivElement>(null)
  // Failed <img>/<iframe> load (e.g. offline): drop to the download-only
  // fallback instead of a broken image / blank frame.
  const [loadFailed, setLoadFailed] = useState(false)

  // Capture once per open — kind is fixed for a mounted ticket.
  useEffect(() => {
    captureEvent('ticket_viewed', { kind })
  }, [kind])

  // Capture the opener BEFORE moving focus (no autoFocus attribute — native
  // autofocus scheduling can beat a passive effect and make us capture the
  // Back button as "previous"), push focus to Back, and restore on close.
  const backRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    backRef.current?.focus()
    return () => prev?.focus?.()
  }, [])

  // Escape closes the viewer only; Tab cycles within the viewer. Both in the
  // capture phase + stopPropagation: the viewer's DOM sits inside the event
  // drawer's focus-trapped panel, so without this the Drawer's document-level
  // listeners would close the drawer on Escape and Tab onto controls hidden
  // behind the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !rootRef.current) return
      e.stopPropagation()
      const focusables = Array.from(
        rootRef.current.querySelectorAll<HTMLElement>('button, a[href], iframe'),
      )
      if (focusables.length === 0) return
      const first = focusables[0]!
      const last = focusables[focusables.length - 1]!
      const active = document.activeElement
      const inside = active instanceof HTMLElement && rootRef.current.contains(active)
      if (!inside) {
        e.preventDefault()
        first.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const fallback = (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        color: 'var(--ink-dim)',
      }}
    >
      <p className="meta" style={{ margin: 0 }}>
        {loadFailed
          ? 'Couldn’t load the ticket — check your connection, or download it instead.'
          : 'This file type can’t be previewed here.'}
      </p>
      <button className="pl-btn ghost sm" onClick={() => onDownload(ticket)}>
        <Icon name="download" size={13} />
        Download
      </button>
    </div>
  )

  return (
    // role=dialog without aria-modal: the hosting event-detail Drawer is
    // already the aria-modal surface; a second nested modal confuses AT.
    <div
      ref={rootRef}
      role="dialog"
      aria-label={label}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 300,
        background: 'var(--bg)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          flex: '0 0 auto',
          padding: '10px 14px',
          borderBottom: '1.5px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <button ref={backRef} className="pl-btn ghost sm" onClick={onClose}>
          <span style={{ display: 'inline-flex', transform: 'scaleX(-1)' }}>
            <Icon name="chevron" size={13} />
          </span>
          Back
        </button>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 13.5,
            color: 'var(--ink)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
        <button className="pl-btn ghost sm" onClick={() => onDownload(ticket)}>
          <Icon name="download" size={13} />
          Download
        </button>
      </div>

      {loadFailed || kind === 'other' ? (
        fallback
      ) : kind === 'image' ? (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: 'auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
        >
          <img
            src={url}
            alt={label}
            onError={() => setLoadFailed(true)}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          />
        </div>
      ) : (
        // Known limitation: while focus is INSIDE the iframe's document
        // (e.g. the browser's PDF controls), our capture-phase Escape/Tab
        // listeners don't see those key events — the Back/Download buttons
        // remain the escape route. Accepted for now.
        <iframe
          src={url}
          title={label}
          onError={() => setLoadFailed(true)}
          style={{ flex: 1, minHeight: 0, border: 'none', width: '100%' }}
        />
      )}
    </div>
  )
}
