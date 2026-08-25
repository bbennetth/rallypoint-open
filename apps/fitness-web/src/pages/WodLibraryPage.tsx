// Slice 2 — workout-template library. Lists benchmark + custom WODs AND
// the user's saved strength ("standard") workouts, with kind + type
// filter chips and a search input. Tapping a row opens a detail drawer
// with the prescription, an "Add to plan" day picker (appends to the
// active training plan), and a "Start workout" CTA that routes by kind
// (WOD live session vs strength live session). Strength templates used
// to be save-only orphans — saved fine but listed nowhere — so this
// page is the canonical browser for both kinds.

import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Banner, ConfirmDialog, Drawer, EmptyState, Icon, SwipeActions } from '@rallypoint/ui'
import { DAY_KEYS, WOD_TYPES, formatWodScheme, formatWodTime } from '@rallypoint/fitness-shared'
import type { DayKey, WodType, WodBody, StrengthBody } from '@rallypoint/fitness-shared'
import { deleteWodTemplate, wodTemplatesQuery, ApiError } from '../lib/api.js'
import type { WodTemplateDto, WodTemplateFilters } from '../lib/api.js'
import { exerciseLabel } from '../lib/exercise-label.js'
import { useCachedQuery } from '../lib/offline/use-cached-query.js'
import { useExerciseNames } from '../lib/use-exercise-names.js'
import { LibrarySubBar } from '../ui/LibrarySubBar.js'
import { addToActivePlan } from '../lib/plan-add.js'
import { DAY_LABELS } from '../lib/plan-build.js'
import { formatLoad, useWeightUnit, type WeightUnit } from '../lib/units.js'

function errMessage(err: unknown): string {
  return err instanceof ApiError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Something went wrong. Please try again.'
}

type KindFilter = 'all' | 'wod' | 'strength'

function wodTypeLabel(t: WodType): string {
  switch (t) {
    case 'for_time':
      return 'For Time'
    case 'rounds_for_time':
      return 'Rounds For Time'
    case 'amrap':
      return 'AMRAP'
    case 'emom':
      return 'EMOM'
    case 'interval':
      return 'Intervals'
    case 'max_reps_rounds':
      return 'Max Reps'
  }
}

function modalityLabel(tpl: WodTemplateDto): string {
  if (tpl.kind === 'strength') return 'Strength'
  if (tpl.body.wodType === 'amrap') return `${Math.round(tpl.body.durationS / 60)} min AMRAP`
  return wodTypeLabel(tpl.body.wodType)
}

// ── Summary lines ─────────────────────────────────────────────────────
// Compact subtitles for list rows: "thrusters · pull-ups" for WODs,
// "3 exercises · 9 sets · back squat · bench press" for strength (drop
// the per-rep counts to keep rows scannable; full prescription shows in
// the drawer).

function summarizeMovementsCompact(body: WodBody, names: ReadonlyMap<string, string>): string {
  return body.movements
    .map((m) => exerciseLabel(m.exerciseId, names))
    .slice(0, 3)
    .join(' · ')
}

function summarizeStrengthCompact(body: StrengthBody): string {
  const totalSets = body.blocks.reduce((n, b) => n + b.sets.length, 0)
  const names = body.blocks
    .map((b) => b.name)
    .slice(0, 3)
    .join(' · ')
  return `${body.blocks.length} × exercises · ${totalSets} sets · ${names}`
}

// One set target as a short string: "5 @ 225 lb", "12 cal", "400m".
function describeSetTarget(
  s: StrengthBody['blocks'][number]['sets'][number],
  unit: WeightUnit,
): string {
  // Max-effort sets render MAX (with the optional rep hint) — without
  // this an amrap set with no rep target shows a bare "—".
  const amount = s.amrap
    ? s.reps != null
      ? `MAX (${s.reps})`
      : 'MAX'
    : s.reps != null
      ? `${s.reps}`
      : s.calories != null
        ? `${s.calories} cal`
        : s.distanceM != null
          ? `${s.distanceM}m`
          : s.timeS != null
            ? `${s.timeS}s`
            : '—'
  return s.loadKg != null ? `${amount} @ ${formatLoad(s.loadKg, unit)}` : amount
}

// A block's set list, collapsed when uniform: "3 × 5 @ 225 lb", else
// "5 @ 225 lb, 5 @ 245 lb, 3 @ 265 lb".
function describeBlockSets(
  b: StrengthBody['blocks'][number],
  unit: WeightUnit,
): string {
  const descs = b.sets.map((s) => describeSetTarget(s, unit))
  const uniform = descs.every((d) => d === descs[0])
  return uniform ? `${descs.length} × ${descs[0]}` : descs.join(', ')
}

// ── Row ──────────────────────────────────────────────────────────────

function TemplateRow({
  tpl,
  names,
  onClick,
  onEdit,
  onDelete,
}: {
  tpl: WodTemplateDto
  names: ReadonlyMap<string, string>
  onClick: () => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
}) {
  // Custom templates get the swipe/hover tray (edit hops to the composer,
  // delete stages the confirm the page owns); benchmarks pass an empty
  // actions array so the wrapper is a plain passthrough — one code path.
  return (
    <SwipeActions
      actions={
        tpl.isCustom
          ? [
              {
                key: 'edit',
                label: `Edit ${tpl.name}`,
                icon: <Icon name="sliders" size={13} />,
                onAction: () => onEdit(tpl.id),
              },
              {
                key: 'delete',
                label: `Delete ${tpl.name}`,
                icon: <Icon name="trash" size={14} />,
                onAction: () => onDelete(tpl.id),
              },
            ]
          : []
      }
      contentClassName="pl-row"
      contentStyle={{ gridTemplateColumns: '1fr', padding: '10px 12px' }}
    >
      <button
        type="button"
        onClick={onClick}
        className="pl-rowtitle"
        style={{ display: 'block', minWidth: 0 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          <span className="pl-chip" style={{ flexShrink: 0 }}>
            {modalityLabel(tpl)}
          </span>
          <span
            style={{
              fontSize: 14,
              color: 'var(--ink)',
              fontWeight: 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {tpl.name}
          </span>
        </div>
        <div
          style={{
            marginTop: 4,
            color: 'var(--ink-dim)',
            fontSize: 12,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {tpl.kind === 'wod'
            ? `${formatWodScheme(tpl.body)} · ${summarizeMovementsCompact(tpl.body, names)}`
            : summarizeStrengthCompact(tpl.body)}
        </div>
      </button>
    </SwipeActions>
  )
}

// ── Detail drawer ─────────────────────────────────────────────────────
// One drawer for both kinds — the prescription section branches on the
// kind discriminator; the add-to-plan flow and owner actions are shared.

function TemplateDetailDrawer({
  tpl,
  names,
  onClose,
  onStart,
  onEdit,
  onDelete,
  onViewPlan,
}: {
  tpl: WodTemplateDto
  names: ReadonlyMap<string, string>
  onClose: () => void
  onStart: () => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onViewPlan: () => void
}) {
  const unit = useWeightUnit()
  // Add-to-plan flow: reveal the day chips, POST on pick, confirm
  // inline. Mounted per-template (the parent keys the drawer), so this
  // state can't leak across templates.
  const [planOpen, setPlanOpen] = useState(false)
  const [planBusyDay, setPlanBusyDay] = useState<DayKey | null>(null)
  const [planAddedDay, setPlanAddedDay] = useState<DayKey | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)

  async function handleAddToPlan(day: DayKey) {
    if (planBusyDay) return
    setPlanBusyDay(day)
    setPlanAddedDay(null)
    setPlanError(null)
    try {
      await addToActivePlan(day, {
        sourceKind: tpl.kind === 'wod' ? 'wod_template' : 'strength_template',
        sourceId: tpl.id,
      })
      setPlanAddedDay(day)
    } catch (err: unknown) {
      setPlanError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not add that to your plan.',
      )
    } finally {
      setPlanBusyDay(null)
    }
  }

  return (
    <Drawer open title={tpl.name} onClose={onClose}>
      <div style={{ display: 'grid', gap: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <span className="pl-chip">{modalityLabel(tpl)}</span>
          {tpl.isBenchmark && <span className="pl-chip">Benchmark</span>}
          {tpl.isCustom && <span className="pl-chip">Custom</span>}
          {tpl.timeCapS != null && (
            <span className="pl-chip">Cap {formatWodTime(tpl.timeCapS)}</span>
          )}
        </div>

        {tpl.description && (
          <p style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--ink)', margin: 0 }}>
            {tpl.description}
          </p>
        )}

        <div style={{ display: 'grid', gap: 8 }}>
          <div className="cmp-label">Prescription</div>
          {tpl.kind === 'wod' ? (
            <>
              <div style={{ fontSize: 14, color: 'var(--ink)' }}>
                <strong>{formatWodScheme(tpl.body)}</strong>
              </div>
              <ol style={{ paddingLeft: 18, margin: 0, display: 'grid', gap: 4 }}>
                {tpl.body.movements.map((m, i) => {
                  const slug = exerciseLabel(m.exerciseId, names)
                  const parts: string[] = []
                  if (m.reps !== undefined && m.reps !== 1) parts.push(`${m.reps} reps`)
                  if (m.calories !== undefined) parts.push(`${m.calories} cal`)
                  if (m.distanceM !== undefined) parts.push(`${m.distanceM}m`)
                  if (m.timeS !== undefined) parts.push(`${m.timeS}s`)
                  // stored kg -> display unit; storage stays kg
                  if (m.loadKg !== undefined) parts.push(formatLoad(m.loadKg, unit))
                  return (
                    <li key={`${m.exerciseId}-${i}`} style={{ fontSize: 14, color: 'var(--ink)' }}>
                      {slug}
                      {parts.length > 0 && (
                        <span style={{ color: 'var(--ink-dim)' }}> — {parts.join(' · ')}</span>
                      )}
                    </li>
                  )
                })}
              </ol>
            </>
          ) : (
            <ol style={{ paddingLeft: 18, margin: 0, display: 'grid', gap: 4 }}>
              {tpl.body.blocks.map((b, i) => (
                <li key={`${b.exerciseId}-${i}`} style={{ fontSize: 14, color: 'var(--ink)' }}>
                  {b.name}
                  <span style={{ color: 'var(--ink-dim)' }}>
                    {' '}
                    — {describeBlockSets(b, unit)}
                    {b.restS != null && ` · rest ${b.restS}s`}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>

        {/* Owner-only actions for custom templates. Edit hops into the
            composer at /composer/:id (which handles both kinds); Delete
            runs through a confirm dialog the parent owns so the drawer
            stays presentational. */}
        {tpl.isCustom && (
          <div className="btn-row" style={{ marginTop: 4 }}>
            <button
              type="button"
              className="fit-startbtn ghost"
              onClick={() => onEdit(tpl.id)}
            >
              Edit
            </button>
            <button
              type="button"
              className="fit-startbtn ghost hot"
              onClick={() => onDelete(tpl.id)}
            >
              Delete
            </button>
          </div>
        )}
        {/* Add to plan — reveal the weekday chips, append to the
            active plan on pick (bootstrapping "My plan" for a user
            who has none). */}
        <div style={{ display: 'grid', gap: 8 }}>
          <button
            type="button"
            className="fit-startbtn ghost"
            onClick={() => setPlanOpen((o) => !o)}
            aria-expanded={planOpen}
          >
            Add to plan
          </button>
          {planOpen && (
            <>
              <div className="day-chips">
                {DAY_KEYS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={`day-chip${planAddedDay === d ? ' on' : ''}`}
                    disabled={planBusyDay !== null}
                    onClick={() => void handleAddToPlan(d)}
                  >
                    {planBusyDay === d ? '…' : DAY_LABELS[d]}
                  </button>
                ))}
              </div>
              {planAddedDay && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 13,
                    color: 'var(--ink)',
                  }}
                >
                  <span>Added to {DAY_LABELS[planAddedDay]} ✓</span>
                  <button
                    type="button"
                    className="fit-startbtn ghost"
                    onClick={onViewPlan}
                    style={{ width: 'auto', padding: '4px 10px', fontSize: 12 }}
                  >
                    View plan
                  </button>
                </div>
              )}
              {planError && <Banner tone="error">{planError}</Banner>}
            </>
          )}
        </div>

        <button
          type="button"
          className="btn-brutal"
          onClick={onStart}
          style={{ width: '100%', marginTop: 8 }}
        >
          Start workout
        </button>
      </div>
    </Drawer>
  )
}

// ── Page ──────────────────────────────────────────────────────────────

export function WodLibraryPage() {
  const navigate = useNavigate()
  const exerciseNames = useExerciseNames()
  const [filters, setFilters] = useState<WodTemplateFilters>({})
  const [searchInput, setSearchInput] = useState('')
  const [detailTpl, setDetailTpl] = useState<WodTemplateDto | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [mutationError, setMutationError] = useState<string | null>(null)

  // No default kind filter — the library shows both WOD and strength
  // templates. The kind chips write `filters.kind`, which the server
  // honors and which is part of the cache key, so each kind window is
  // cached separately.
  const templatesQ = useCachedQuery(
    useMemo(() => wodTemplatesQuery(filters), [filters]),
  )
  const allTemplates = templatesQ.data ?? []
  const loading = templatesQ.status === 'loading'
  const error = mutationError ?? (templatesQ.status === 'error' ? errMessage(templatesQ.error) : null)

  // Debounce the search input into the filter to avoid a request per keystroke.
  useEffect(() => {
    const id = setTimeout(() => {
      setFilters((f) => {
        const next = { ...f }
        const q = searchInput.trim()
        if (q) next.q = q
        else delete next.q
        return next
      })
    }, 320)
    return () => clearTimeout(id)
  }, [searchInput])

  // Group by source (Benchmarks first, then the user's own of either kind).
  const { benchmarks, customs } = useMemo(() => {
    const benchmarks: WodTemplateDto[] = []
    const customs: WodTemplateDto[] = []
    for (const w of allTemplates) {
      if (w.isCustom) customs.push(w)
      else benchmarks.push(w)
    }
    return { benchmarks, customs }
  }, [allTemplates])

  const activeKind: KindFilter = filters.kind ?? 'all'
  const activeType = filters.type ?? null
  const activeSource: 'all' | 'builtin' | 'custom' = filters.benchmarkOnly
    ? 'builtin'
    : filters.customOnly
      ? 'custom'
      : 'all'

  function setActiveKind(k: KindFilter) {
    setFilters((f) => {
      const next = { ...f }
      if (k === 'all') delete next.kind
      else next.kind = k
      // WOD-type chips don't apply to strength rows — clear a stale
      // type filter so the cache key (and the result set) stay sane.
      if (k === 'strength') delete next.type
      return next
    })
  }

  function setActiveType(t: WodType | null) {
    setFilters((f) => {
      const next = { ...f }
      if (t) next.type = t
      else delete next.type
      return next
    })
  }

  function setActiveSource(s: 'all' | 'builtin' | 'custom') {
    setFilters((f) => {
      const next = { ...f }
      delete next.benchmarkOnly
      delete next.customOnly
      if (s === 'builtin') next.benchmarkOnly = true
      if (s === 'custom') next.customOnly = true
      return next
    })
  }

  function startTemplate(tpl: WodTemplateDto) {
    if (tpl.kind === 'wod') {
      navigate(`/live/wod/${encodeURIComponent(tpl.id)}/run`)
    } else {
      navigate(`/live/strength/new?templateId=${encodeURIComponent(tpl.id)}`)
    }
  }

  return (
    <>
      <LibrarySubBar active="wods" />
      <div className="page-pad">
      <header>
        <h1 className="display" style={{ fontSize: 28, margin: 0 }}>
          Workouts
        </h1>
        <p style={{ color: 'var(--ink-dim)', fontSize: 14, margin: '4px 0 0' }}>
          Pick a benchmark WOD or one of your saved workouts and start a live session.
        </p>
      </header>

      {error && <Banner tone="error">{error}</Banner>}

      {/* Search */}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 11, color: 'var(--ink-dim)', fontWeight: 500 }}>Search</span>
        <input
          type="search"
          className="pl-input"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="e.g. Fran…"
          style={{ fontSize: 16 }}
        />
      </label>

      {/* Kind filter chips (WODs vs saved strength workouts) */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {(
          [
            { key: 'all', label: 'All' },
            { key: 'wod', label: 'WODs' },
            { key: 'strength', label: 'Strength' },
          ] as const
        ).map((k) => (
          <button
            key={k.key}
            type="button"
            onClick={() => setActiveKind(k.key)}
            className={`pl-chip${activeKind === k.key ? ' pl-chip-active' : ''}`}
            style={{ cursor: 'pointer' }}
          >
            {k.label}
          </button>
        ))}
      </div>

      {/* Type filter chips — WOD kinds only; meaningless for strength */}
      {activeKind !== 'strength' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button
            type="button"
            onClick={() => setActiveType(null)}
            className={`pl-chip${activeType === null ? ' pl-chip-active' : ''}`}
            style={{ cursor: 'pointer' }}
          >
            All
          </button>
          {WOD_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setActiveType(t)}
              className={`pl-chip${activeType === t ? ' pl-chip-active' : ''}`}
              style={{ cursor: 'pointer' }}
            >
              {wodTypeLabel(t)}
            </button>
          ))}
        </div>
      )}

      {/* Source filter chips (built-in benchmarks vs the user's own) */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {(
          [
            { key: 'all', label: 'All sources' },
            { key: 'builtin', label: 'Built-in' },
            { key: 'custom', label: 'Custom' },
          ] as const
        ).map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setActiveSource(s.key)}
            className={`pl-chip${activeSource === s.key ? ' pl-chip-active' : ''}`}
            style={{ cursor: 'pointer' }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Sections */}
      {loading ? (
        <p style={{ color: 'var(--ink-dim)' }}>Loading…</p>
      ) : allTemplates.length === 0 ? (
        <EmptyState
          title="No workouts match"
          body={
            activeSource === 'custom' || activeKind === 'strength'
              ? 'Nothing saved here yet — build a workout in the composer and save it.'
              : 'Try clearing the search or filters.'
          }
        />
      ) : (
        <div style={{ display: 'grid', gap: 24 }}>
          {benchmarks.length > 0 && (
            <section style={{ display: 'grid', gap: 8 }}>
              <h2
                className="display"
                style={{
                  fontSize: 16,
                  margin: 0,
                  color: 'var(--ink-dim)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                }}
              >
                Benchmark WODs
              </h2>
              <div style={{ display: 'grid', gap: 6 }}>
                {benchmarks.map((w) => (
                  <TemplateRow
                    key={w.id}
                    tpl={w}
                    names={exerciseNames}
                    onClick={() => setDetailTpl(w)}
                    onEdit={(id) => navigate(`/composer/${encodeURIComponent(id)}`)}
                    onDelete={(id) => setConfirmDeleteId(id)}
                  />
                ))}
              </div>
            </section>
          )}
          {customs.length > 0 && (
            <section style={{ display: 'grid', gap: 8 }}>
              <h2
                className="display"
                style={{
                  fontSize: 16,
                  margin: 0,
                  color: 'var(--ink-dim)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                }}
              >
                Your workouts
              </h2>
              <div style={{ display: 'grid', gap: 6 }}>
                {customs.map((w) => (
                  <TemplateRow
                    key={w.id}
                    tpl={w}
                    names={exerciseNames}
                    onClick={() => setDetailTpl(w)}
                    onEdit={(id) => navigate(`/composer/${encodeURIComponent(id)}`)}
                    onDelete={(id) => setConfirmDeleteId(id)}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {detailTpl && (
        <TemplateDetailDrawer
          key={detailTpl.id}
          tpl={detailTpl}
          names={exerciseNames}
          onClose={() => setDetailTpl(null)}
          onStart={() => startTemplate(detailTpl)}
          onEdit={(id) => navigate(`/composer/${encodeURIComponent(id)}`)}
          onDelete={(id) => setConfirmDeleteId(id)}
          onViewPlan={() => navigate('/plan')}
        />
      )}

      {confirmDeleteId && (
        <ConfirmDialog
          open
          title="Delete this workout?"
          body="The template will be removed from your library. Sessions you've already logged stay intact, but they'll no longer link back to a template."
          confirmLabel="Delete"
          confirmVariant="hot"
          busy={deleting}
          onCancel={() => setConfirmDeleteId(null)}
          onConfirm={async () => {
            const id = confirmDeleteId
            setDeleting(true)
            try {
              // Local-first: patches the wodTemplates cache and notifies
              // subscribers, so the list drops the row on its own.
              await deleteWodTemplate(id)
              setConfirmDeleteId(null)
              setDetailTpl(null)
            } catch (err: unknown) {
              setMutationError(errMessage(err))
            } finally {
              setDeleting(false)
            }
          }}
        />
      )}
      </div>
    </>
  )
}
