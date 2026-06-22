import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import {
  ApiError,
  getTicketDownloadUrl,
  listTickets,
  uploadTicket,
  type TicketDto,
} from '../lib/api.js'

// Client-side affordance only; events-api is the real gate on type + size.
export const ACCEPTED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
export const ACCEPT_ATTR = ACCEPTED_MIME.join(',')

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

// Shared ticket machinery for an event-detail surface: loads the active event's
// tickets, uploads a picked file, and opens a download. Owns the hidden file
// <input> ref (the caller renders the input with `fileInputRef` + `onPickFile`).
// Errors surface through the caller's `onError` so the page keeps a single error
// banner. `onError` MUST be a stable reference (e.g. a useState setter) — it's a
// dependency of the load effect; an inline closure would refetch every render.
export function useEventTickets(
  activeEventId: string | null,
  onError: (msg: string) => void,
) {
  const [tickets, setTickets] = useState<TicketDto[]>([])
  const [loadingTickets, setLoadingTickets] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const refreshTickets = useCallback(
    async (eventId: string) => {
      setLoadingTickets(true)
      try {
        setTickets(await listTickets(eventId))
      } catch (err) {
        onError(errMessage(err))
      } finally {
        setLoadingTickets(false)
      }
    },
    [onError],
  )

  useEffect(() => {
    if (activeEventId) void refreshTickets(activeEventId)
    else setTickets([])
  }, [activeEventId, refreshTickets])

  async function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file later
    if (!file || !activeEventId) return
    if (!ACCEPTED_MIME.includes(file.type)) {
      onError('Tickets must be a JPEG, PNG, WebP, or PDF file.')
      return
    }
    setUploading(true)
    try {
      const bound = await uploadTicket(activeEventId, file)
      setTickets((prev) => [...prev, bound])
    } catch (err) {
      onError(errMessage(err))
    } finally {
      setUploading(false)
    }
  }

  function onDownload(ticket: TicketDto) {
    if (!activeEventId) return
    try {
      window.open(getTicketDownloadUrl(activeEventId, ticket.id), '_blank', 'noopener,noreferrer')
    } catch (err) {
      onError(errMessage(err))
    }
  }

  function triggerAttach() {
    fileInputRef.current?.click()
  }

  return { tickets, loadingTickets, uploading, fileInputRef, onPickFile, onDownload, triggerAttach }
}
