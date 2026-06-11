import { useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  bulkApplyLineup,
  findOrCreateArtist,
  listDays,
  listLineup,
  listStages,
  type LineupDeleteRef,
  type LineupSlotDto,
  type LineupSlotInput,
  type LineupTier,
  type DayDto,
  type StageDto,
} from '../lib/api.js'
import { SnapshotHistory } from './SnapshotHistory.js'
import { CsvImportPanel, type CsvPreview } from './CsvImportPanel.js'
import { lineupTemplateCsv, planLineupImport } from '../lib/lineup-csv.js'
import {
  lineupRowsToTsv,
  parseLineupClipboard,
  type LineupClipboardRow,
} from '../lib/lineup-grid.js'

// A single editable row in the lineup grid. Existing rows are keyed by
// their composite (artist_id, day_id) PK; the artist + day of an existing
// row are immutable (changing either is a PK change, which the grid models
// as a delete + a fresh new row). New rows resolve their artist name to an
// id on save via find-or-create.
interface DraftRow {
  key: string
  isNew: boolean
  deleted: boolean
  artistId: string | null
  artistName: string
  dayId: string
  stageId: string
  tier: LineupTier | ''
  // Not editable in the grid (no column), but carried through so a
  // replace-style bulk upsert of another field doesn't wipe an existing
  // genre set elsewhere.
  genre: string
  startTime: string
  endTime: string
  displayName: string
}

const TIERS: LineupTier[] = ['headliner', 'support', 'opener']

let newRowSeq = 0

function rowFromSlot(slot: LineupSlotDto, artistName: string): DraftRow {
  return {
    key: `${slot.artist_id}:${slot.day_id}`,
    isNew: false,
    deleted: false,
    artistId: slot.artist_id,
    artistName,
    dayId: slot.day_id,
    stageId: slot.stage_id ?? '',
    tier: slot.tier ?? '',
    genre: slot.genre ?? '',
    startTime: slot.start_time ?? '',
    endTime: slot.end_time ?? '',
    displayName: slot.display_name ?? '',
  }
}

function blankRow(dayId: string): DraftRow {
  return {
    key: `new-${newRowSeq++}`,
    isNew: true,
    deleted: false,
    artistId: null,
    artistName: '',
    dayId,
    stageId: '',
    tier: '',
    genre: '',
    startTime: '',
    endTime: '',
    displayName: '',
  }
}

// Snapshot of an existing row's editable fields, used to detect whether a
// row needs to be re-upserted on save (skip clean rows to stay under the
// bulk cap and avoid pointless writes).
function rowSignature(r: DraftRow): string {
  return JSON.stringify([r.stageId, r.tier, r.genre, r.startTime, r.endTime, r.displayName])
}

// `reloadSignal` is a monotonically increasing counter the parent bumps when
// a realtime lineup invalidation arrives, forcing a silent re-fetch of the
// stages/days/slots without remounting the whole editor (which would drop
// in-progress form state). Stages and days are read-only here — they're
// managed on the Settings tab — and feed the grid's Day / Stage columns.
export function LineupEditor({
  eventId,
  reloadSignal = 0,
}: {
  eventId: string
  reloadSignal?: number
}) {
  const [stages, setStages] = useState<StageDto[]>([])
  const [days, setDays] = useState<DayDto[]>([])
  const [rows, setRows] = useState<DraftRow[]>([])
  // Raw slots from the last fetch, kept for the CSV import planner's
  // create-vs-update detection and replace-mode delete computation.
  const [slots, setSlots] = useState<LineupSlotDto[]>([])
  const [baseline, setBaseline] = useState<Map<string, string>>(new Map())
  const [loadError, setLoadError] = useState<string | null>(null)
  const [gridError, setGridError] = useState<string | null>(null)
  const [gridSaving, setGridSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  function hydrateRows(fetched: LineupSlotDto[]) {
    const next = fetched.map((s) => rowFromSlot(s, s.artist_name ?? s.display_name ?? s.artist_id))
    setSlots(fetched)
    setRows(next)
    setBaseline(new Map(next.map((r) => [r.key, rowSignature(r)])))
  }

  useEffect(() => {
    let cancelled = false
    Promise.all([listStages(eventId), listDays(eventId), listLineup(eventId)])
      .then(([s, d, l]) => {
        if (cancelled) return
        setStages(s)
        setDays(d)
        hydrateRows(l)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load lineup data.')
      })
    return () => {
      cancelled = true
    }
  }, [eventId, reloadSignal])

  async function refetchLineup() {
    const l = await listLineup(eventId)
    hydrateRows(l)
  }

  const dayById = useMemo(() => new Map(days.map((d) => [d.id, d])), [days])
  const stageById = useMemo(() => new Map(stages.map((s) => [s.id, s])), [stages])

  function patchRow(key: string, patch: Partial<DraftRow>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  }

  function addRow() {
    setRows((prev) => [...prev, blankRow(days[0]?.id ?? '')])
  }

  function removeRow(key: string) {
    setRows((prev) =>
      prev.flatMap((r) => {
        if (r.key !== key) return [r]
        // Drop unsaved new rows outright; mark existing rows for deletion.
        if (r.isNew) return []
        return [{ ...r, deleted: !r.deleted }]
      }),
    )
  }

  // ---- Copy / paste -------------------------------------------------------

  async function copyGrid() {
    setNotice(null)
    setGridError(null)
    const out: LineupClipboardRow[] = rows
      .filter((r) => !r.deleted)
      .map((r) => ({
        artist: r.artistName,
        day: dayById.get(r.dayId)?.day_label ?? '',
        stage: r.stageId ? stageById.get(r.stageId)?.name ?? '' : '',
        tier: r.tier,
        start: r.startTime,
        end: r.endTime,
        displayName: r.displayName,
      }))
    try {
      await navigator.clipboard.writeText(lineupRowsToTsv(out))
      setNotice(`Copied ${out.length} row${out.length === 1 ? '' : 's'} to the clipboard.`)
    } catch {
      setGridError('Could not access the clipboard. Check browser permissions.')
    }
  }

  // Resolve a pasted day cell (label or date) and stage name to ids, mint new
  // rows, and append them. Unresolved day falls back to the first day; unknown
  // stage / invalid tier fall back to empty so the user can fix them inline.
  function appendPastedRows(text: string) {
    const parsed = parseLineupClipboard(text)
    if (parsed.length === 0) return
    const dayByKey = new Map<string, string>()
    for (const d of days) {
      dayByKey.set(d.day_label.trim().toLowerCase(), d.id)
      dayByKey.set(d.date.trim().toLowerCase(), d.id)
    }
    const stageByName = new Map(stages.map((s) => [s.name.trim().toLowerCase(), s.id]))
    const validTiers = new Set<string>(TIERS)
    const fallbackDay = days[0]?.id ?? ''
    const additions: DraftRow[] = parsed
      .filter((p) => p.artist.trim() !== '')
      .map((p) => {
        const tierKey = p.tier.trim().toLowerCase()
        return {
          ...blankRow(dayByKey.get(p.day.trim().toLowerCase()) ?? fallbackDay),
          artistName: p.artist.trim(),
          stageId: stageByName.get(p.stage.trim().toLowerCase()) ?? '',
          tier: validTiers.has(tierKey) ? (tierKey as LineupTier) : '',
          startTime: p.start.trim(),
          endTime: p.end.trim(),
          displayName: p.displayName.trim(),
        }
      })
    if (additions.length === 0) return
    setRows((prev) => [...prev, ...additions])
    setNotice(
      `Pasted ${additions.length} row${additions.length === 1 ? '' : 's'}. Review, then Save changes.`,
    )
  }

  function onGridPaste(e: React.ClipboardEvent) {
    const text = e.clipboardData.getData('text')
    // Only hijack multi-cell pastes; a single value pasted into one input
    // should behave normally.
    if (text && /[\t\r\n]/.test(text)) {
      e.preventDefault()
      setGridError(null)
      appendPastedRows(text)
    }
  }

  async function pasteFromClipboard() {
    setNotice(null)
    setGridError(null)
    try {
      const text = await navigator.clipboard.readText()
      if (!text.trim()) {
        setGridError('Clipboard is empty.')
        return
      }
      appendPastedRows(text)
    } catch {
      setGridError('Could not read the clipboard. Check browser permissions.')
    }
  }

  // ---- Save ---------------------------------------------------------------

  const dirty = useMemo(() => {
    return rows.some((r) => {
      if (r.isNew && !r.deleted) return true
      if (!r.isNew && r.deleted) return true
      if (!r.isNew && baseline.get(r.key) !== rowSignature(r)) return true
      return false
    })
  }, [rows, baseline])

  function buildSlotInput(r: DraftRow, artistId: string): LineupSlotInput {
    return {
      artistId,
      dayId: r.dayId,
      stageId: r.stageId || null,
      tier: r.tier || null,
      genre: r.genre || null,
      startTime: r.startTime || null,
      endTime: r.endTime || null,
      displayName: r.displayName.trim() || null,
    }
  }

  async function handleSaveGrid() {
    setGridError(null)
    setNotice(null)

    const newRows = rows.filter((r) => r.isNew && !r.deleted)
    for (const r of newRows) {
      if (!r.artistName.trim()) {
        setGridError('Every new row needs an artist name.')
        return
      }
      if (!r.dayId) {
        setGridError('Every new row needs a day.')
        return
      }
    }

    setGridSaving(true)
    try {
      const slotInputs: LineupSlotInput[] = []

      // Existing rows that changed get re-upserted.
      for (const r of rows) {
        if (r.isNew || r.deleted || !r.artistId) continue
        if (baseline.get(r.key) !== rowSignature(r)) {
          slotInputs.push(buildSlotInput(r, r.artistId))
        }
      }

      // New rows: resolve artist name → id, then upsert.
      for (const r of newRows) {
        const artist = await findOrCreateArtist(r.artistName.trim())
        slotInputs.push(buildSlotInput(r, artist.id))
      }

      const deletes: LineupDeleteRef[] = rows
        .filter((r) => !r.isNew && r.deleted && r.artistId)
        .map((r) => ({ artistId: r.artistId!, dayId: r.dayId }))

      await bulkApplyLineup(eventId, { slots: slotInputs, deletes })
      await refetchLineup()
      const saved = slotInputs.length + deletes.length
      setNotice(`Saved ${saved} change${saved === 1 ? '' : 's'}.`)
    } catch (err) {
      setGridError(err instanceof ApiError ? err.message : 'Failed to save lineup.')
    } finally {
      setGridSaving(false)
    }
  }

  // ---- CSV import ---------------------------------------------------------

  function lineupPreview(text: string, replace: boolean): CsvPreview {
    const p = planLineupImport({ text, days, stages, currentSlots: slots, replace })
    return {
      summary: p.summary,
      errors: p.errors,
      rowLabels: [
        ...p.rows.map(
          (r) =>
            `${r.action === 'create' ? '+' : '~'} ${r.displayName ?? r.artistName} — ${r.dayLabel}`,
        ),
        ...p.deletes.map((d) => `− ${d.label}`),
      ],
    }
  }

  async function applyLineupCsv(text: string, replace: boolean) {
    const p = planLineupImport({ text, days, stages, currentSlots: slots, replace })
    if (p.summary.error > 0) throw new Error('Fix the errors in the preview before importing.')
    const slotInputs: LineupSlotInput[] = []
    for (const r of p.rows) {
      const artistId = r.artistId ?? (await findOrCreateArtist(r.artistName)).id
      slotInputs.push({
        artistId,
        dayId: r.dayId,
        stageId: r.stageId,
        tier: r.tier,
        genre: r.genre,
        startTime: r.startTime,
        endTime: r.endTime,
        displayName: r.displayName,
      })
    }
    const deletes: LineupDeleteRef[] = p.deletes.map((d) => ({ artistId: d.artistId, dayId: d.dayId }))
    await bulkApplyLineup(eventId, { slots: slotInputs, deletes })
    await refetchLineup()
  }

  if (loadError) {
    return (
      <div
        role="alert"
        className="p-3 text-sm text-[color:var(--ink)]"
        style={{ border: '1.5px solid var(--hot)', background: 'color-mix(in srgb, var(--hot) 12%, transparent)' }}
      >
        {loadError}
      </div>
    )
  }

  const inputCls = 'cyber-input'

  return (
    <div className="p-4 space-y-6" style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}>
      <div className="space-y-3" onPaste={onGridPaste}>
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-xs font-medium text-[color:var(--ink-mute)] flex-1">Lineup</h3>
          <button
            type="button"
            onClick={addRow}
            disabled={days.length === 0}
            className="btn-brutal"
            style={{ width: 'auto' }}
            title={days.length === 0 ? 'Add a day in Settings first' : 'Add a lineup row'}
          >
            + Add row
          </button>
          <button
            type="button"
            onClick={() => void copyGrid()}
            disabled={rows.length === 0}
            className="btn-ghost"
            style={{ width: 'auto' }}
            title="Copy the grid as tab-separated rows"
          >
            Copy
          </button>
          <button
            type="button"
            onClick={() => void pasteFromClipboard()}
            disabled={days.length === 0}
            className="btn-ghost"
            style={{ width: 'auto' }}
            title="Paste rows from the clipboard"
          >
            Paste
          </button>
          <button
            type="button"
            onClick={() => void handleSaveGrid()}
            disabled={!dirty || gridSaving}
            className="btn-hot"
            style={{ width: 'auto' }}
          >
            {gridSaving ? 'Saving…' : 'Save changes'}
          </button>
        </div>

        {days.length === 0 ? (
          <p className="text-xs text-[color:var(--ink-mute)]">
            No days yet — add days on the Settings tab before building the lineup.
          </p>
        ) : (
          <p className="text-xs text-[color:var(--ink-dim)]">
            Tip: paste rows straight from a spreadsheet (artist, day, stage, tier, start, end,
            display name). Save changes writes them all at once.
          </p>
        )}

        {days.length > 0 && rows.length === 0 && (
          <p className="text-xs text-[color:var(--ink-mute)]">No lineup slots yet.</p>
        )}

        {days.length > 0 && rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr className="text-[color:var(--ink-mute)] mono uppercase tracking-wide">
                  <th className="text-left p-1" style={{ minWidth: 150 }}>Artist</th>
                  <th className="text-left p-1" style={{ minWidth: 100 }}>Day</th>
                  <th className="text-left p-1" style={{ minWidth: 110 }}>Stage</th>
                  <th className="text-left p-1" style={{ minWidth: 110 }}>Tier</th>
                  <th className="text-left p-1" style={{ minWidth: 90 }}>Start</th>
                  <th className="text-left p-1" style={{ minWidth: 90 }}>End</th>
                  <th className="text-left p-1" style={{ minWidth: 120 }}>Display name</th>
                  <th className="p-1" style={{ minWidth: 44 }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.key}
                    style={{ opacity: r.deleted ? 0.45 : 1, borderTop: '1px solid var(--line)' }}
                  >
                    <td className="p-1 align-top">
                      {r.isNew ? (
                        <input
                          type="text"
                          value={r.artistName}
                          onChange={(e) => patchRow(r.key, { artistName: e.target.value })}
                          placeholder="Artist name"
                          className={`${inputCls} w-full`}
                          aria-label="Artist name"
                        />
                      ) : (
                        <span className="font-medium">{r.displayName.trim() || r.artistName}</span>
                      )}
                    </td>
                    <td className="p-1 align-top">
                      {r.isNew ? (
                        <select
                          value={r.dayId}
                          onChange={(e) => patchRow(r.key, { dayId: e.target.value })}
                          className={`${inputCls} w-full`}
                          aria-label="Day"
                        >
                          <option value="">Pick a day</option>
                          {days.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.day_label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-[color:var(--ink-dim)]">
                          {dayById.get(r.dayId)?.day_label ?? '—'}
                        </span>
                      )}
                    </td>
                    <td className="p-1 align-top">
                      <select
                        value={r.stageId}
                        onChange={(e) => patchRow(r.key, { stageId: e.target.value })}
                        className={`${inputCls} w-full`}
                        aria-label="Stage"
                        disabled={r.deleted}
                      >
                        <option value="">No stage</option>
                        {stages.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="p-1 align-top">
                      <select
                        value={r.tier}
                        onChange={(e) => patchRow(r.key, { tier: e.target.value as LineupTier | '' })}
                        className={`${inputCls} w-full`}
                        aria-label="Tier"
                        disabled={r.deleted}
                      >
                        <option value="">No tier</option>
                        {TIERS.map((t) => (
                          <option key={t} value={t}>
                            {t[0]!.toUpperCase() + t.slice(1)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="p-1 align-top">
                      <input
                        type="time"
                        value={r.startTime}
                        onChange={(e) => patchRow(r.key, { startTime: e.target.value })}
                        className={`${inputCls} w-full`}
                        aria-label="Start time"
                        disabled={r.deleted}
                      />
                    </td>
                    <td className="p-1 align-top">
                      <input
                        type="time"
                        value={r.endTime}
                        onChange={(e) => patchRow(r.key, { endTime: e.target.value })}
                        className={`${inputCls} w-full`}
                        aria-label="End time"
                        disabled={r.deleted}
                      />
                    </td>
                    <td className="p-1 align-top">
                      <input
                        type="text"
                        value={r.displayName}
                        onChange={(e) => patchRow(r.key, { displayName: e.target.value })}
                        placeholder="Optional"
                        className={`${inputCls} w-full`}
                        aria-label="Display name"
                        disabled={r.deleted}
                      />
                    </td>
                    <td className="p-1 align-top text-right">
                      <button
                        type="button"
                        onClick={() => removeRow(r.key)}
                        className="btn-hot"
                        style={{ width: 'auto' }}
                        aria-label={r.deleted ? 'Undo remove' : 'Remove row'}
                      >
                        {r.deleted ? '↺' : '×'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {notice && (
          <p className="text-xs" style={{ color: 'var(--map-highlight)' }}>
            {notice}
          </p>
        )}

        {gridError && (
          <div
            role="alert"
            className="p-3 text-sm text-[color:var(--ink)]"
            style={{ border: '1.5px solid var(--hot)', background: 'color-mix(in srgb, var(--hot) 12%, transparent)' }}
          >
            {gridError}
          </div>
        )}
      </div>

      <CsvImportPanel
        label="lineup"
        templateCsv={() => lineupTemplateCsv(days, stages)}
        templateFilename="lineup-template.csv"
        replaceHint="Remove lineup rows not present in the file"
        buildPreview={lineupPreview}
        onApply={applyLineupCsv}
      />

      <SnapshotHistory eventId={eventId} kind="lineup" onRestored={refetchLineup} />
    </div>
  )
}
