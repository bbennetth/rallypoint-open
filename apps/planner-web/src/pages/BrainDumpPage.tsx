import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ApiError,
  braindumpEntriesQuery,
  braindumpListQuery,
  createBraindumpEntry,
  createEntryDirect,
  createPersonalEvent,
  createTaskItem,
  deleteBraindumpEntry,
  deleteDiaryEntry,
  deleteNote,
  diaryEntriesQuery,
  diaryListQuery,
  ensureAnalysisField,
  enrichBraindump,
  fieldDefsQuery,
  listTaskLists,
  notesQuery,
  saveEntryAnalysis,
  sendAssistFeedback,
  summarizeBraindump,
  updateBraindumpEntry,
  updateDiaryEntry,
  updateNote,
  type BraindumpEnrichment,
  type BraindumpEntryDto,
  type BraindumpRangeSummary,
  type FieldDefDto,
  type NoteDto,
} from '../lib/api.js'
import { useCachedQuery } from '../lib/offline/use-cached-query.js'
import {
  UNCATEGORIZED,
  buildStream,
  categoriesInStream,
  encodeAiAnalysis,
  filterByCategory,
  findAnalysisField,
  findCategoryField,
  type StreamEntry,
} from '../lib/braindump-helpers.js'
import {
  DEFAULT_BACKFILL_LIMIT,
  analyzableText,
  backfillProgressLabel,
  noteConversionInput,
  runBackfill,
  selectUnanalyzed,
} from '../lib/braindump-backfill.js'
import { knownConceptLabels } from '../lib/braindump-concepts.js'
import {
  categoryDistribution,
  entriesPerWeek,
  selectEntriesForSummary,
  topThemes,
} from '../lib/braindump-analytics.js'
import { buildConceptGraph, layoutGraph, type LaidOutNode } from '../lib/braindump-graph.js'
import {
  eventSuggestionKey,
  hasSchedulableStart,
  hasSuggestions,
  suggestedEventFields,
  suggestedTaskOpts,
  taskSuggestionKey,
} from '../lib/braindump-suggestions.js'
import { formatEntryDate } from '../lib/diary-helpers.js'
import { localToday } from '../lib/planner-helpers.js'
import { SkeletonRows } from '../ui/Skeleton.js'
import { onCreated } from '../lib/refresh-bus.js'
import { Drawer } from '@rallypoint/ui'
import { Icon } from '../ui/icons.js'

// Brain Dump — the single free-text capture surface replacing the separate
// Diary and Notes tabs. Capture is offline-first (the entry saves through
// the generic braindump list create); AI enrichment (category + themes/
// entities/summary + task/event suggestions) is a stateless online-only BFF
// call that degrades to a plain save. Legacy diary entries and notes appear
// merged into the stream (no data migration) and stay editable here.

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

const CANCEL_POLL_MS = 300

// Sleep in short slices, checking `cancelRef` between each so Stop can
// interrupt a multi-second (or 60s rate-limit) wait instead of the loop
// sitting through it before noticing.
async function abortableSleep(ms: number, cancelRef: { current: boolean }): Promise<void> {
  let remaining = ms
  while (remaining > 0 && !cancelRef.current) {
    const slice = Math.min(CANCEL_POLL_MS, remaining)
    await new Promise((resolve) => setTimeout(resolve, slice))
    remaining -= slice
  }
}

// Sentinel `analyzing` value while the bulk backfill runs, so per-entry
// Analyze buttons share the same single-flight disable as one-off analyze().
const BACKFILL_SENTINEL = 'backfill'

interface BackfillState {
  running: boolean
  done: number
  failed: number
  total: number
}

type View = 'stream' | 'map' | 'insights'

// Resolve an enrichment's category label to the seeded field's choice id.
function categoryChoiceId(field: FieldDefDto | null, label: string): string | null {
  if (!field) return null
  return (field.options.choices ?? []).find((c) => c.label === label)?.id ?? null
}

// Whether an entry has somewhere to save an analysis: diary rows need their
// own listId, notes get converted into the brain-dump list (need its
// listId AND the provisioned analysis field, since a note conversion can't
// carry an analysis without it), braindump rows always carry their own
// listId already. Guards the per-entry Analyze button against a dead click
// (and a burned AI call) while a list/field is still resolving.
function analyzeTargetReady(
  entry: StreamEntry,
  braindumpListId: string | null,
  analysisField: FieldDefDto | null,
): boolean {
  if (entry.source === 'diary') return entry.listId !== null
  if (entry.source === 'note') return braindumpListId !== null && analysisField !== null
  // braindump rows: without the analysis field def the save would write no
  // analysis at all — same doomed-call class as the note branch — and a row
  // from a stream built before the owning list resolved has nowhere to save.
  return entry.listId !== null && analysisField !== null
}

// The customFields payload carrying an enrichment (category + analysis).
function enrichmentFields(
  enrichment: BraindumpEnrichment,
  categoryField: FieldDefDto | null,
  analysisField: FieldDefDto | null,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  const choice = categoryChoiceId(categoryField, enrichment.category)
  if (categoryField && choice) fields[categoryField.id] = choice
  if (analysisField) {
    fields[analysisField.id] = encodeAiAnalysis({
      themes: enrichment.themes,
      entities: enrichment.entities,
      summary: enrichment.summary,
      model: 'workers-ai',
    })
  }
  return fields
}

// Suggested tasks/events from the latest dump, offered as confirm chips.
function SuggestionsPanel({
  enrichment,
  onDone,
}: {
  enrichment: BraindumpEnrichment
  onDone: () => void
}) {
  const [added, setAdded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const events = enrichment.eventSuggestions.filter(hasSchedulableStart)

  async function addTask(key: string, index: number) {
    if (busy) return
    setBusy(key)
    setError(null)
    try {
      const s = enrichment.taskSuggestions[index]!
      const lists = await listTaskLists()
      const listId = lists[0]?.id
      if (!listId) throw new Error('No task list is available yet.')
      await createTaskItem(listId, s.title, suggestedTaskOpts(s))
      setAdded((prev) => new Set(prev).add(key))
      void sendAssistFeedback(enrichment.responseId, 'accepted')
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setBusy(null)
    }
  }

  async function addEvent(key: string, index: number) {
    if (busy) return
    setBusy(key)
    setError(null)
    try {
      const s = events[index]!
      await createPersonalEvent(suggestedEventFields(s))
      setAdded((prev) => new Set(prev).add(key))
      void sendAssistFeedback(enrichment.responseId, 'accepted')
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="pl-card" style={{ display: 'grid', gap: 8, padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <b style={{ fontSize: 13 }}>Found in your dump</b>
        <button
          type="button"
          className="pl-iconbtn"
          style={{ marginLeft: 'auto' }}
          aria-label="Dismiss suggestions"
          title="Dismiss"
          onClick={() => {
            if (added.size === 0) void sendAssistFeedback(enrichment.responseId, 'rejected')
            onDone()
          }}
        >
          ✕
        </button>
      </div>
      {enrichment.taskSuggestions.map((s, i) => {
        const key = taskSuggestionKey(s, i)
        return (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="pl-chip">Task</span>
            <span style={{ fontSize: 13, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {s.title}
            </span>
            <button
              type="button"
              className="pl-btn ghost"
              style={{ marginLeft: 'auto', flexShrink: 0 }}
              disabled={busy !== null || added.has(key)}
              onClick={() => void addTask(key, i)}
            >
              {added.has(key) ? 'Added' : 'Add task'}
            </button>
          </div>
        )
      })}
      {events.map((s, i) => {
        const key = eventSuggestionKey(s, i)
        return (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="pl-chip accent">Event</span>
            <span style={{ fontSize: 13, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {s.title}
            </span>
            <button
              type="button"
              className="pl-btn ghost"
              style={{ marginLeft: 'auto', flexShrink: 0 }}
              disabled={busy !== null || added.has(key)}
              onClick={() => void addEvent(key, i)}
            >
              {added.has(key) ? 'Added' : 'Add event'}
            </button>
          </div>
        )
      })}
      {error && (
        <p role="alert" className="pl-fab-error">
          {error}
        </p>
      )}
    </div>
  )
}

// Edit/delete form for one stream entry, rendered in a Drawer. Braindump and
// legacy diary rows edit through the generic item routes; legacy notes edit
// through the notes routes. Keyed by entry key by the parent.
function EntryEditor({
  entry,
  categoryField,
  onSaved,
  onClose,
}: {
  entry: StreamEntry
  categoryField: FieldDefDto | null
  onSaved: () => void
  onClose: () => void
}) {
  const item = entry.source === 'note' ? null : (entry.raw as BraindumpEntryDto)
  const [title, setTitle] = useState(entry.title)
  const [body, setBody] = useState(entry.body ?? '')
  const [category, setCategory] = useState<string>(() => {
    if (entry.source !== 'braindump' || !categoryField || !item) return ''
    const raw = item.customFields[categoryField.id]
    return typeof raw === 'string' ? raw : ''
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const trimmedTitle = title.trim() || 'Untitled'
      const trimmedBody = body.trim() ? body.trim() : null
      if (entry.source === 'note') {
        await updateNote(entry.id, { title: trimmedTitle, notes: trimmedBody })
      } else if (entry.source === 'diary') {
        await updateDiaryEntry(entry.listId!, entry.id, { title: trimmedTitle, notes: trimmedBody })
      } else {
        const patch: Record<string, unknown> = { title: trimmedTitle, notes: trimmedBody }
        if (categoryField) {
          patch['customFields'] = {
            ...item!.customFields,
            [categoryField.id]: category || null,
          }
        }
        await updateBraindumpEntry(entry.listId!, entry.id, patch)
      }
      onSaved()
      onClose()
    } catch (err) {
      setError(errMessage(err))
      setBusy(false)
    }
  }

  async function remove() {
    if (busy) return
    if (!window.confirm('Delete this entry? This cannot be undone.')) return
    setBusy(true)
    setError(null)
    try {
      if (entry.source === 'note') await deleteNote(entry.id)
      else if (entry.source === 'diary') await deleteDiaryEntry(entry.listId!, entry.id)
      else await deleteBraindumpEntry(entry.listId!, entry.id)
      onSaved()
      onClose()
    } catch (err) {
      setError(errMessage(err))
      setBusy(false)
    }
  }

  const choices = (categoryField?.options.choices ?? []).filter((c) => !c.archived)

  return (
    <form
      className="pl-fab-form"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <label className="pl-fab-label">
        Title
        <input
          className="pl-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="Entry title"
          disabled={busy}
        />
      </label>
      <label className="pl-fab-label">
        Entry
        <textarea
          className="pl-input"
          rows={6}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          aria-label="Entry body"
          disabled={busy}
          style={{ resize: 'vertical' }}
        />
      </label>
      {entry.source === 'braindump' && categoryField && (
        <label className="pl-fab-label">
          Category
          <select
            className="pl-input"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="Category"
            disabled={busy}
          >
            <option value="">—</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && (
        <p role="alert" className="pl-fab-error">
          {error}
        </p>
      )}
      <button className="pl-btn" type="submit" disabled={busy}>
        Save entry
      </button>
      <button className="pl-btn ghost" type="button" onClick={() => void remove()} disabled={busy}>
        Delete entry
      </button>
    </form>
  )
}

// Inline SVG concept map. Nodes sized by frequency; tap filters the stream.
function ConceptMap({
  entries,
  onPickNode,
}: {
  entries: StreamEntry[]
  onPickNode: (node: LaidOutNode) => void
}) {
  const laidOut = useMemo(() => {
    const graph = buildConceptGraph(entries)
    return layoutGraph(graph, 720, 480)
  }, [entries])
  const byId = useMemo(() => new Map(laidOut.nodes.map((n) => [n.id, n])), [laidOut])

  if (laidOut.nodes.length === 0) {
    return (
      <p className="meta" style={{ color: 'var(--ink-mute)' }}>
        No analyzed entries yet — dump something (online) and the map builds itself from the
        themes and people the AI finds.
      </p>
    )
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg
        viewBox={`0 0 ${laidOut.width} ${laidOut.height}`}
        role="img"
        aria-label="Concept map of your brain dumps"
        style={{ width: '100%', minWidth: 480, height: 'auto' }}
      >
        {laidOut.edges.map((e) => {
          const a = byId.get(e.a)
          const b = byId.get(e.b)
          if (!a || !b) return null
          return (
            <line
              key={`${e.a}|${e.b}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke="var(--line, #8884)"
              strokeWidth={Math.min(4, 0.5 + e.weight)}
              opacity={0.55}
            />
          )
        })}
        {laidOut.nodes.map((n) => (
          <g
            key={n.id}
            transform={`translate(${n.x},${n.y})`}
            style={{ cursor: 'pointer' }}
            onClick={() => onPickNode(n)}
          >
            <circle
              r={n.r}
              fill={n.kind === 'theme' ? 'var(--accent, #6a5acd)' : 'var(--accent-soft, #b0a6ee)'}
              opacity={0.85}
            />
            <title>{`${n.label} — ${n.weight} ${n.weight === 1 ? 'entry' : 'entries'}`}</title>
            <text
              y={n.r + 12}
              textAnchor="middle"
              style={{ fontSize: 11, fill: 'var(--ink, currentColor)' }}
            >
              {n.label.length > 18 ? `${n.label.slice(0, 17)}…` : n.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  )
}

// Insights: local tiles (no API) + the on-demand AI range summary.
function InsightsView({ entries }: { entries: StreamEntry[] }) {
  const distribution = useMemo(() => categoryDistribution(entries), [entries])
  const themes = useMemo(() => topThemes(entries), [entries])
  const weeks = useMemo(() => entriesPerWeek(entries).slice(0, 6), [entries])
  const [summary, setSummary] = useState<BraindumpRangeSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function summarize() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const corpus = selectEntriesForSummary(entries)
      if (corpus.length === 0) throw new Error('Nothing to summarize yet.')
      setSummary(await summarizeBraindump(corpus))
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {weeks.map((w) => (
          <span key={w.week} className="pl-chip">
            <b style={{ marginRight: 4 }}>{w.week}</b>
            {w.count} {w.count === 1 ? 'entry' : 'entries'}
          </span>
        ))}
      </div>
      {distribution.length > 0 && (
        <div>
          <b style={{ fontSize: 13 }}>Categories</b>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            {distribution.map((c) => (
              <span key={c.category} className="pl-chip">
                {c.category} · {c.count}
              </span>
            ))}
          </div>
        </div>
      )}
      {themes.length > 0 && (
        <div>
          <b style={{ fontSize: 13 }}>Top themes</b>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            {themes.map((t) => (
              <span key={t.theme} className="pl-chip accent">
                {t.theme} · {t.count}
              </span>
            ))}
          </div>
        </div>
      )}
      <div style={{ display: 'grid', gap: 8 }}>
        <button
          type="button"
          className="pl-btn"
          style={{ justifySelf: 'start' }}
          onClick={() => void summarize()}
          disabled={busy}
        >
          {busy ? 'Summarizing…' : 'Summarize recent entries'}
        </button>
        {error && (
          <p role="alert" className="pl-fab-error">
            {error}
          </p>
        )}
        {summary && (
          <div className="pl-card" style={{ padding: 12, display: 'grid', gap: 8 }}>
            <p style={{ margin: 0, fontSize: 14 }}>{summary.summary}</p>
            {summary.highlights.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {summary.highlights.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            )}
            {summary.moodTrend && (
              <p className="meta" style={{ margin: 0, color: 'var(--ink-mute)', fontSize: 13 }}>
                {summary.moodTrend}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export function BrainDumpPage() {
  const listQ = useCachedQuery(useMemo(() => braindumpListQuery(), []))
  const listId = listQ.data?.id ?? null
  const entriesQ = useCachedQuery(
    useMemo(() => (listId ? braindumpEntriesQuery(listId) : null), [listId]),
  )
  const defsQ = useCachedQuery(useMemo(() => (listId ? fieldDefsQuery(listId) : null), [listId]))
  // Legacy surfaces merged into the stream (no data migration).
  const diaryListQ = useCachedQuery(useMemo(() => diaryListQuery(), []))
  const diaryListId = diaryListQ.data?.id ?? null
  const diaryEntriesQ = useCachedQuery(
    useMemo(() => (diaryListId ? diaryEntriesQuery(diaryListId) : null), [diaryListId]),
  )
  const notesQ = useCachedQuery(useMemo(() => notesQuery(), []))

  const defs = useMemo(() => defsQ.data ?? [], [defsQ.data])
  const categoryField = useMemo(() => findCategoryField(defs), [defs])
  const analysisField = useMemo(() => findAnalysisField(defs), [defs])

  const stream = useMemo(
    () =>
      buildStream(
        entriesQ.data ?? [],
        diaryEntriesQ.data ?? [],
        (notesQ.data ?? []).filter((n: NoteDto) => !n.completed),
        categoryField,
        analysisField,
      ),
    [entriesQ.data, diaryEntriesQ.data, notesQ.data, categoryField, analysisField],
  )
  // Read by the backfill loop each iteration (via knownConceptLabels) so its
  // vocabulary grows as refetches land mid-run, instead of the stale
  // `stream` the loop's closure was created with.
  const streamRef = useRef<StreamEntry[]>(stream)
  streamRef.current = stream

  const [view, setView] = useState<View>('stream')
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null)
  // Set by tapping a map node: narrows the stream to that concept's entries.
  const [nodeFilter, setNodeFilter] = useState<{ label: string; keys: Set<string> } | null>(null)
  const [text, setText] = useState('')
  const [capturing, setCapturing] = useState(false)
  const [captureNote, setCaptureNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<BraindumpEnrichment | null>(null)
  const [editing, setEditing] = useState<StreamEntry | null>(null)
  const [analyzing, setAnalyzing] = useState<string | null>(null)
  const [backfillState, setBackfillState] = useState<BackfillState | null>(null)
  // Surfaced during a 429 backoff mid-backfill, cleared on the next
  // progress tick (see runBackfill's onProgress/onRateLimited).
  const [rateLimitedNote, setRateLimitedNote] = useState<string | null>(null)
  // Per-list "AI Analysis" field def, resolved (and provisioned) once per
  // diary list id rather than on every entry.
  const analysisFieldByList = useRef<Map<string, FieldDefDto>>(new Map())
  const backfillCancelRef = useRef(false)
  // Single-flight guard for analyze()/backfill(): `analyzing` state updates
  // are batched, so two clicks landing in the same frame could both pass an
  // `if (analyzing) return` check before the first setState commits. A ref
  // is synchronous, so it closes that race.
  const busyRef = useRef(false)

  // Stop an in-flight backfill loop if the page unmounts mid-run.
  useEffect(() => {
    return () => {
      backfillCancelRef.current = true
    }
  }, [])

  const categories = useMemo(() => categoriesInStream(stream), [stream])
  // The true count of eligible entries (uncapped) for the button label — the
  // run itself still processes at most `selectUnanalyzed`'s default limit.
  const unanalyzedCount = useMemo(
    () => selectUnanalyzed(stream, Number.POSITIVE_INFINITY).length,
    [stream],
  )
  const visible = useMemo(() => {
    const byCategory = filterByCategory(stream, categoryFilter)
    if (!nodeFilter) return byCategory
    return byCategory.filter((e) => nodeFilter.keys.has(e.key))
  }, [stream, categoryFilter, nodeFilter])

  useEffect(() => {
    if (listQ.status === 'error') setError(errMessage(listQ.error))
    else if (entriesQ.status === 'error') setError(errMessage(entriesQ.error))
  }, [listQ.status, listQ.error, entriesQ.status, entriesQ.error])

  const refetchEntries = entriesQ.refetch
  const refetchDiary = diaryEntriesQ.refetch
  const refetchNotes = notesQ.refetch
  // Captures from the global quick-add FAB land on the legacy lists; refresh
  // the merged stream when they do.
  useEffect(() => onCreated('diary', () => void refetchDiary()), [refetchDiary])
  useEffect(() => onCreated('note', () => void refetchNotes()), [refetchNotes])

  function refetchAll() {
    void refetchEntries()
    void refetchDiary()
    void refetchNotes()
  }

  async function dump() {
    const body = text.trim()
    if (body === '' || capturing || !listId) return
    setCapturing(true)
    setError(null)
    setCaptureNote(null)
    setSuggestions(null)
    const { date, tz } = localToday()
    // Enrich FIRST (stateless), then save once with the enrichment folded
    // in — offline or AI-down degrades to a plain, re-analyzable save.
    let enrichment: BraindumpEnrichment | null = null
    try {
      enrichment = await enrichBraindump({
        text: body,
        clientNow: new Date().toISOString(),
        tz,
        knownConcepts: knownConceptLabels(stream),
      })
    } catch {
      setCaptureNote('Saved without AI analysis — use Analyze on the entry to retry.')
    }
    try {
      await createBraindumpEntry(listId, {
        title: enrichment?.title ?? formatEntryDate(date),
        notes: body,
        dueDate: date,
        ...(enrichment
          ? { customFields: enrichmentFields(enrichment, categoryField, analysisField) }
          : {}),
      })
      setText('')
      if (enrichment && hasSuggestions(enrichment)) setSuggestions(enrichment)
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setCapturing(false)
    }
  }

  // Enrich + save one entry, routed by source: braindump analyzes in place
  // (existing path); legacy diary analyzes in place onto a provisioned "AI
  // Analysis" field; legacy notes convert into a braindump entry (create +
  // soft-delete the note) since notes have nowhere to store an analysis.
  // Shared by the per-entry Analyze button and the bulk backfill loop.
  // `knownConcepts` is supplied by the caller rather than computed here so
  // the bulk loop can pass a freshly-recomputed vocabulary each iteration
  // (see streamRef). `refetch: false` lets the backfill batch its refetches
  // instead of one per entry; `offerSuggestions: false` keeps the
  // suggestions panel from popping mid-run.
  async function analyzeCore(
    entry: StreamEntry,
    knownConcepts: string[],
    opts: { refetch?: boolean; offerSuggestions?: boolean } = {},
  ): Promise<void> {
    const text = analyzableText(entry)
    if (!text) return
    // Pre-flight: every guard that would otherwise throw once we're already
    // past enrichBraindump, hoisted above the call so a doomed save can't
    // burn an AI call / rate-limit slot first.
    if (entry.source === 'braindump' && entry.listId === null) {
      throw new Error('This entry has no list to save to yet — try again in a moment.')
    }
    if (entry.source === 'braindump' && analysisField === null) {
      // Without the field def the save would silently store no analysis.
      throw new Error('Brain dump fields are still loading — try again in a moment.')
    }
    if (entry.source === 'diary' && entry.listId === null) {
      throw new Error('This diary entry has no list to save to yet — try again in a moment.')
    }
    if (entry.source === 'note') {
      // A note converts into a new braindump entry — never delete the note
      // before we know the replacement can actually carry the analysis.
      if (analysisField === null) {
        throw new Error('Brain dump fields are still loading — try again in a moment.')
      }
      if (!listId) throw new Error('Brain dump is not ready yet — try again in a moment.')
    }

    const { tz } = localToday()
    const enrichment = await enrichBraindump({
      text,
      clientNow: new Date().toISOString(),
      tz,
      knownConcepts,
    })
    if (entry.source === 'braindump') {
      const entryListId = entry.listId!
      // Analyze fills gaps, it doesn't clobber the user: an entry whose
      // category was already set (manually via the editor) keeps it — only
      // an uncategorized entry takes the AI's pick.
      const fields = enrichmentFields(enrichment, categoryField, analysisField)
      if (entry.category !== null && categoryField) delete fields[categoryField.id]
      await updateBraindumpEntry(entryListId, entry.id, {
        // A title-only entry (body === null, the text lives in the title)
        // would lose its only content if overwritten with the AI's title —
        // only overwrite when the entry actually carries a body.
        ...(entry.body?.trim() ? { title: enrichment.title } : {}),
        // Only the enrichment's own fields, never `...item.customFields` —
        // the lists API merges patch keys over the stored customFields map
        // server-side (see saveEntryAnalysis's comment below), so
        // re-sending the whole map risks reverting a concurrent edit.
        customFields: fields,
      })
      // updateBraindumpEntry writes straight into the shared cache table
      // the stream reads from, so no explicit refetch is needed here.
    } else if (entry.source === 'diary') {
      const entryListId = entry.listId!
      let def = analysisFieldByList.current.get(entryListId)
      if (!def) {
        def = await ensureAnalysisField(entryListId)
        analysisFieldByList.current.set(entryListId, def)
      }
      try {
        // Only the analysis field's own key — the lists API merges patch
        // keys over the stored customFields map server-side, so re-sending
        // the whole map risks reverting a concurrent edit or 400ing on a
        // since-deleted field def.
        await saveEntryAnalysis(entryListId, entry.id, {
          [def.id]: encodeAiAnalysis({
            themes: enrichment.themes,
            entities: enrichment.entities,
            summary: enrichment.summary,
            model: 'workers-ai',
          }),
        })
      } catch (err) {
        // A 4xx here most likely means the cached field def is stale (e.g.
        // deleted concurrently) — drop it so a retry re-provisions instead
        // of repeating the same failing id.
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
          analysisFieldByList.current.delete(entryListId)
        }
        throw err
      }
      if (opts.refetch !== false) refetchAll()
    } else {
      await createEntryDirect(listId!, {
        ...noteConversionInput(
          entry,
          enrichment,
          enrichmentFields(enrichment, categoryField, analysisField),
        ),
        // Idempotency: a retried conversion (lost response) re-resolves to
        // the already-created row instead of duplicating the entry.
        ref: `note-convert:${entry.id}`,
      })
      await deleteNote(entry.id)
      if (opts.refetch !== false) refetchAll()
    }
    if ((opts.offerSuggestions ?? true) && hasSuggestions(enrichment)) setSuggestions(enrichment)
  }

  // Re-run enrichment for one saved (un-analyzed) entry via the per-row
  // Analyze button.
  async function analyze(entry: StreamEntry) {
    if (busyRef.current || analyzableText(entry) === null) return
    if (!analyzeTargetReady(entry, listId, analysisField)) return
    busyRef.current = true
    setAnalyzing(entry.key)
    setError(null)
    try {
      await analyzeCore(entry, knownConceptLabels(stream))
    } catch (err) {
      setError(errMessage(err))
    } finally {
      busyRef.current = false
      setAnalyzing(null)
    }
  }

  // Bulk-analyze the older un-analyzed entries, paced under the enrich
  // route's rate limit (runBackfill in braindump-backfill.ts owns the
  // retry/backoff/abort semantics; this wires it to analyzeCore + the
  // page's cancel/sleep primitives). Cancelable via the Stop button
  // (interrupts sleeps, not just between-entry gaps); a fatal auth error
  // aborts the whole run instead of burning through the rest.
  async function backfill() {
    if (busyRef.current) return
    const targets = selectUnanalyzed(stream)
    if (targets.length === 0) return
    if (analysisField === null) {
      setError('Brain dump fields are still loading — try again in a moment.')
      return
    }
    busyRef.current = true
    backfillCancelRef.current = false
    setAnalyzing(BACKFILL_SENTINEL)
    setError(null)
    setCaptureNote(null)
    setRateLimitedNote(null)
    const total = targets.length
    setBackfillState({ running: true, done: 0, failed: 0, total })

    try {
      const result = await runBackfill({
        targets,
        analyzeOne: (entry) => {
          // Recomputed each call so the vocabulary grows as refetches land
          // mid-run instead of staying frozen at the run's start.
          const knownConcepts = knownConceptLabels(streamRef.current)
          return analyzeCore(entry, knownConcepts, { refetch: false, offerSuggestions: false })
        },
        sleep: (ms) => abortableSleep(ms, backfillCancelRef),
        isCancelled: () => backfillCancelRef.current,
        onProgress: ({ done, failed }) => {
          setRateLimitedNote(null)
          setBackfillState({ running: true, done, failed, total })
          if ((done + failed) % 5 === 0) refetchAll()
        },
        onRateLimited: () => setRateLimitedNote('Rate-limited — retrying…'),
      })

      refetchAll()
      setBackfillState({ running: false, done: result.done, failed: result.failed, total })
      if (result.fatal !== null) {
        // The fatal error is already surfaced via setError below — the
        // progress note must not read as a clean/success finish, so it gets
        // a distinct "stopped due to an error" phrasing instead.
        setError(errMessage(result.fatal))
        setCaptureNote(
          backfillProgressLabel({
            running: false,
            done: result.done,
            failed: result.failed,
            total,
            aborted: true,
          }),
        )
      } else {
        setCaptureNote(
          backfillProgressLabel({
            running: false,
            done: result.done,
            failed: result.failed,
            total,
            stopped: result.cancelled,
          }),
        )
      }
    } catch (err) {
      // runBackfill swallows per-entry errors, but onProgress/refetchAll can
      // throw — without this the UI would sit on "Analyzing…" forever.
      setError(errMessage(err))
      setBackfillState((s) => (s ? { ...s, running: false } : s))
    } finally {
      // Unconditional release: a latched busyRef would permanently disable
      // both analyze entry points with no re-render to recover them.
      busyRef.current = false
      setAnalyzing(null)
      setRateLimitedNote(null)
    }
  }

  const loading = listQ.status === 'loading'

  // Shared by the stream and map views: "Analyze older entries" while idle,
  // a progress line + Stop while the bulk backfill is running.
  function backfillControl() {
    if (backfillState?.running) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <span className="meta" style={{ color: 'var(--ink-mute)' }}>
            {/* Keep the position visible during a rate-limit backoff — the
                note supplements the progress line, it doesn't replace it. */}
            {backfillProgressLabel(backfillState)}
            {rateLimitedNote ? ` ${rateLimitedNote}` : ''}
          </span>
          <button
            type="button"
            className="pl-btn ghost"
            onClick={() => {
              backfillCancelRef.current = true
            }}
          >
            Stop
          </button>
        </div>
      )
    }
    if (unanalyzedCount === 0) return null
    // One run only ever processes DEFAULT_BACKFILL_LIMIT entries
    // (selectUnanalyzed's default cap) — when the true eligible count
    // exceeds it, say so rather than promising more than the click delivers.
    const label =
      unanalyzedCount > DEFAULT_BACKFILL_LIMIT
        ? `Analyze older entries (${DEFAULT_BACKFILL_LIMIT} of ${unanalyzedCount})`
        : `Analyze older entries (${unanalyzedCount})`
    return (
      <button
        type="button"
        className="pl-btn ghost"
        onClick={() => void backfill()}
        disabled={analyzing !== null}
      >
        {label}
      </button>
    )
  }

  return (
    <>
      <div className="pg-head pl-wide">
        <div>
          <h1>Brain Dump</h1>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['stream', 'map', 'insights'] as const).map((v) => (
            <button
              key={v}
              type="button"
              className={view === v ? 'pl-btn' : 'pl-btn ghost'}
              onClick={() => setView(v)}
              aria-pressed={view === v}
            >
              {v === 'stream' ? 'Stream' : v === 'map' ? 'Map' : 'Insights'}
            </button>
          ))}
        </div>
      </div>

      <form
        style={{ display: 'grid', gap: 8, marginBottom: 16 }}
        onSubmit={(e) => {
          e.preventDefault()
          void dump()
        }}
      >
        <textarea
          className="pl-input"
          rows={3}
          placeholder="Dump whatever's on your mind — it gets sorted for you."
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Brain dump"
          disabled={capturing || !listId}
          maxLength={4000}
          style={{ resize: 'vertical' }}
        />
        <button
          className="pl-btn"
          type="submit"
          disabled={capturing || !listId || text.trim() === ''}
          style={{ justifySelf: 'start' }}
        >
          {capturing ? 'Dumping…' : 'Dump it'}
        </button>
      </form>

      {captureNote && (
        <p className="meta" style={{ color: 'var(--ink-mute)', fontSize: 13 }}>
          {captureNote}
        </p>
      )}
      {error && (
        <p role="alert" style={{ color: 'var(--hot)', fontSize: 13, marginTop: 0 }}>
          {error}
        </p>
      )}
      {suggestions && (
        <div style={{ marginBottom: 16 }}>
          <SuggestionsPanel enrichment={suggestions} onDone={() => setSuggestions(null)} />
        </div>
      )}

      {loading ? (
        <SkeletonRows count={4} height={72} label="Loading brain dump" />
      ) : view === 'map' ? (
        <div style={{ display: 'grid', gap: 12 }}>
          {(backfillState?.running || unanalyzedCount > 0) && (
            <div>{backfillControl()}</div>
          )}
          <ConceptMap
            entries={stream}
            onPickNode={(node) => {
              setNodeFilter({ label: node.label, keys: new Set(node.entryKeys) })
              setCategoryFilter(null)
              setView('stream')
            }}
          />
        </div>
      ) : view === 'insights' ? (
        <InsightsView entries={stream} />
      ) : (
        <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
          {(categories.length > 0 || nodeFilter || backfillState?.running || unanalyzedCount > 0) && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {nodeFilter ? (
                <button
                  type="button"
                  className="pl-chip accent"
                  onClick={() => setNodeFilter(null)}
                  title="Clear concept filter"
                >
                  {nodeFilter.label} ✕
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className={categoryFilter === null ? 'pl-chip accent' : 'pl-chip'}
                    onClick={() => setCategoryFilter(null)}
                  >
                    All
                  </button>
                  {categories.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={categoryFilter === c ? 'pl-chip accent' : 'pl-chip'}
                      onClick={() => setCategoryFilter(categoryFilter === c ? null : c)}
                    >
                      {c}
                    </button>
                  ))}
                </>
              )}
              {(backfillState?.running || unanalyzedCount > 0) && (
                <div style={{ marginLeft: 'auto' }}>{backfillControl()}</div>
              )}
            </div>
          )}
          {visible.length === 0 ? (
            <p className="meta" style={{ color: 'var(--ink-mute)' }}>
              Nothing here yet — dump your first thought above.
            </p>
          ) : (
            <ul className="diary-grid">
              {visible.map((entry) => (
                <li key={entry.key} className="pl-diary">
                  <div className="pl-diary-hd">
                    <span className="pl-diary-date">{entry.title}</span>
                    {entry.day && (
                      <span className="meta" style={{ color: 'var(--ink-mute)', fontSize: 12 }}>
                        {formatEntryDate(entry.day)}
                      </span>
                    )}
                    <span
                      style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                      {entry.category ? (
                        <span className="pl-chip accent">{entry.category}</span>
                      ) : entry.source !== 'braindump' ? (
                        <span className="pl-chip">
                          {entry.source === 'diary' ? 'Diary' : 'Note'}
                        </span>
                      ) : (
                        <span className="pl-chip">{UNCATEGORIZED}</span>
                      )}
                      {!entry.analysis &&
                        analyzableText(entry) !== null &&
                        analyzeTargetReady(entry, listId, analysisField) && (
                        <button
                          type="button"
                          className="pl-btn ghost"
                          onClick={() => void analyze(entry)}
                          disabled={analyzing !== null}
                        >
                          {analyzing === entry.key ? 'Analyzing…' : 'Analyze'}
                        </button>
                      )}
                      <button
                        type="button"
                        className="pl-iconbtn"
                        onClick={() => setEditing(entry)}
                        aria-label="Edit entry"
                        title="Edit"
                      >
                        <Icon name="pencil" size={13} />
                      </button>
                    </span>
                  </div>
                  {entry.body && <p className="pl-diary-body">{entry.body}</p>}
                  {entry.analysis && entry.analysis.themes.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {entry.analysis.themes.map((t) => (
                        <span key={t} className="pl-chip">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Drawer
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="Entry"
        mobileSheet
      >
        {editing && (
          <EntryEditor
            key={editing.key}
            entry={editing}
            categoryField={categoryField}
            onSaved={refetchAll}
            onClose={() => setEditing(null)}
          />
        )}
      </Drawer>
    </>
  )
}
