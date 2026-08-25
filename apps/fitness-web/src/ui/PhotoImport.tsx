// Whiteboard photo import card for the composer (S9). Three states:
// idle (camera icon + dashed accent border), reading (spinner +
// thumbnail), done (parsed banner + re-scan button). Reads the file
// via a hidden <input type=file>, base64-encodes it, hits the OCR
// route, and hands the parsed shape back to the parent so it can
// pre-fill the composer fields. The "done" state explicitly asks the
// user to review the parse — we never auto-save.

import { useEffect, useRef, useState } from 'react'
import { Icon, useFilePicker } from '@rallypoint/ui'
import { captureException, useAsyncTask } from '@rallypoint/web-kit'
import type { ScanWodResponse } from '../lib/api.js'
import { ApiError, scanWodPhoto, sendAiFeedback } from '../lib/api.js'

type Status = 'idle' | 'reading' | 'done' | 'error'

export interface PhotoImportProps {
  // responseId is the scan's AI-trace id (null when tracing is off);
  // the composer echoes it back with feedback when the user saves.
  onParsed: (parsed: ScanWodResponse['parsed'], responseId: string | null) => void
  // A photo already picked elsewhere (the global FAB's "Scan a whiteboard",
  // handed over through the pending-photo slot). Reads it on mount, so
  // arriving here IS the scan — no second tap on the scan zone.
  initialFile?: File | null
}

export function PhotoImport({ onParsed, initialFile }: PhotoImportProps) {
  const lastResponseId = useRef<string | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [thumb, setThumb] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const picker = useFilePicker({
    onPick: (file) => void handleFile(file),
    ariaLabel: 'Scan a whiteboard photo',
  })
  // Gate the post-scan commits: the mount auto-scan and a manual re-pick can be
  // in flight together (and the component can unmount mid-scan) — only the
  // latest should land.
  const run = useAsyncTask()

  // Mount-only, ref-guarded: StrictMode double-invokes this effect, and a
  // second read would fire a duplicate OCR call on the same image.
  const claimed = useRef(false)
  useEffect(() => {
    if (claimed.current || !initialFile) return
    claimed.current = true
    void handleFile(initialFile)
  }, [])

  async function handleFile(file: File) {
    setError(null)
    setStatus('reading')
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') setThumb(reader.result)
    }
    reader.readAsDataURL(file)
    // Scanning again over a previous parse is a retry signal.
    if (lastResponseId.current) void sendAiFeedback(lastResponseId.current, 'retried')
    await run(async (ctx) => {
      try {
        const res = await scanWodPhoto(file)
        if (ctx.stale()) return
        lastResponseId.current = res.responseId
        onParsed(res.parsed, res.responseId)
        setStatus('done')
      } catch (err: unknown) {
        captureException(err, {
          feature: 'wod-scan',
          scan_step: 'photo-scan',
          image_bytes: file.size,
          image_mime: file.type || 'unknown',
        })
        if (ctx.stale()) return
        setError(
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Could not read that image.',
        )
        setStatus('error')
      }
    })
  }

  return (
    <section className="scan">
      <button
        type="button"
        className={`scan-zone${status === 'reading' || status === 'done' ? ` ${status}` : ''}`}
        onClick={picker.open}
        disabled={status === 'reading'}
        aria-label="Scan a whiteboard photo"
      >
        {thumb ? (
          <img src={thumb} alt="" className="scan-thumb" />
        ) : (
          <span className="scan-ic">
            <Icon name="file" size={18} />
          </span>
        )}
        <div className="scan-main">
          <strong style={{ fontSize: 14, color: 'var(--ink)' }}>
            {status === 'idle' && 'Scan a whiteboard'}
            {status === 'reading' && 'Reading the board…'}
            {status === 'done' && 'Parsed from photo · review it'}
            {status === 'error' && 'Could not read that image'}
          </strong>
          <span className="scan-t">
            {status === 'idle' &&
              'Snap or upload a photo of the WOD board to pre-fill the form. We never auto-save.'}
            {status === 'reading' && 'Workers AI is reading the prescription.'}
            {status === 'done' &&
              'We filled the fields below — eyeball + edit before saving.'}
            {status === 'error' && (error ?? 'Try again with a clearer angle.')}
          </span>
        </div>
        {status === 'reading' && <span className="scan-spin" />}
        {(status === 'done' || status === 'error') && (
          <span className="scan-redo" aria-label="Re-scan">
            <Icon name="repeat" size={14} />
          </span>
        )}
      </button>
      {picker.input}
    </section>
  )
}
