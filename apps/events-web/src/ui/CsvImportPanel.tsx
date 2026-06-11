import { useRef, useState } from 'react'

// Collapsible CSV import surface shared by the Lineup and Sessions tabs
// (issue #191 Phase 3). Download a template, pick a file, see a client-side
// dry-run preview (create/update/delete counts + per-row errors), then apply
// — which POSTs to the snapshot-protected bulk endpoint, so an import is
// revertible from Version history. Parsing/planning is done by pure helpers
// the caller wires through `buildPreview`; `onApply` performs the network
// write and refetch.

export interface CsvPreview {
  summary: { create: number; update: number; delete: number; error: number }
  errors: { line: number; message: string }[]
  rowLabels: string[]
}

export function CsvImportPanel({
  label,
  templateCsv,
  templateFilename,
  replaceHint,
  buildPreview,
  onApply,
}: {
  label: string
  templateCsv: () => string
  templateFilename: string
  replaceHint: string
  buildPreview: (text: string, replace: boolean) => CsvPreview
  onApply: (text: string, replace: boolean) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [fileName, setFileName] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [replace, setReplace] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Derived (not stored): always reflects the current file + replace toggle,
  // so toggling replace while a file is loaded can't leave a stale preview.
  const preview: CsvPreview | null = text != null ? buildPreview(text, replace) : null

  function downloadTemplate() {
    const blob = new Blob([templateCsv()], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = templateFilename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    setDone(null)
    try {
      const t = await file.text()
      setText(t)
      setFileName(file.name)
    } catch {
      setError('Could not read that file.')
    }
  }

  function clearFile() {
    setText(null)
    setFileName(null)
    setError(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  async function apply() {
    if (text == null) return
    setApplying(true)
    setError(null)
    setDone(null)
    try {
      await onApply(text, replace)
      setDone('Import applied. Revert from Version history if needed.')
      clearFile()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.')
    } finally {
      setApplying(false)
    }
  }

  const canApply =
    preview != null &&
    preview.summary.error === 0 &&
    preview.summary.create + preview.summary.update + preview.summary.delete > 0 &&
    !applying

  const alertStyle = {
    border: '1.5px solid var(--hot)',
    background: 'color-mix(in srgb, var(--hot) 12%, transparent)',
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs font-medium text-[color:var(--ink-mute)]"
        aria-expanded={open}
      >
        {open ? '▾' : '▸'} Import {label} from CSV
      </button>

      {open && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={downloadTemplate}
              className="btn-brutal"
              style={{ width: 'auto' }}
            >
              Download template
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => void onFile(e)}
              className="text-xs text-[color:var(--ink-dim)]"
              aria-label={`Choose a ${label} CSV file`}
            />
            {fileName && (
              <button
                type="button"
                onClick={clearFile}
                className="btn-hot"
                style={{ width: 'auto' }}
              >
                Clear
              </button>
            )}
          </div>

          <label className="flex items-center gap-2 text-xs text-[color:var(--ink-dim)]">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            {replaceHint}
          </label>

          {preview && (
            <div className="space-y-2">
              <div className="flex items-center gap-3 text-xs mono flex-wrap">
                <span style={{ color: 'var(--map-highlight)' }}>+{preview.summary.create} new</span>
                <span className="text-[color:var(--ink-dim)]">~{preview.summary.update} updated</span>
                <span style={{ color: 'var(--hot)' }}>−{preview.summary.delete} removed</span>
                {preview.summary.error > 0 && (
                  <span style={{ color: 'var(--hot)' }}>{preview.summary.error} error(s)</span>
                )}
              </div>

              {preview.summary.error > 0 && (
                <ul role="alert" className="space-y-1 p-3 text-xs text-[color:var(--ink)]" style={alertStyle}>
                  {preview.errors.slice(0, 20).map((er, i) => (
                    <li key={i}>
                      Line {er.line}: {er.message}
                    </li>
                  ))}
                  {preview.errors.length > 20 && <li>…and {preview.errors.length - 20} more.</li>}
                </ul>
              )}

              {preview.rowLabels.length > 0 && (
                <ul className="space-y-0.5 text-xs text-[color:var(--ink-mute)] max-h-40 overflow-y-auto">
                  {preview.rowLabels.slice(0, 50).map((l, i) => (
                    <li key={i} className="mono">
                      {l}
                    </li>
                  ))}
                  {preview.rowLabels.length > 50 && (
                    <li className="text-[color:var(--ink-mute)]">…and {preview.rowLabels.length - 50} more.</li>
                  )}
                </ul>
              )}

              <button
                type="button"
                onClick={() => void apply()}
                disabled={!canApply}
                className="btn-hot"
                style={{ width: 'auto' }}
              >
                {applying ? 'Applying…' : 'Apply import'}
              </button>
            </div>
          )}

          {error && (
            <div role="alert" className="p-3 text-sm text-[color:var(--ink)]" style={alertStyle}>
              {error}
            </div>
          )}
          {done && <p className="text-xs" style={{ color: 'var(--map-highlight)' }}>{done}</p>}
        </div>
      )}
    </div>
  )
}
