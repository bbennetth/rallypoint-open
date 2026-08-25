import { useCallback, useEffect, useRef, useState } from 'react'
import { useAsyncTask } from '@rallypoint/web-kit'
import { Banner, Button, SubBar, SubBarSeg } from '@rallypoint/ui'
import {
  DISCIPLINES,
  MOVEMENT_PATTERNS,
  METRIC_SHAPES,
  MUSCLES,
  MUSCLE_GROUPS,
  type MuscleRole,
} from '@rallypoint/fitness-shared'
import {
  ApiError,
  applyAiReview,
  bulkDecideAiReviews,
  dismissAiReview,
  listAiReviews,
  listCatalogExercises,
  runAiReview,
  runAiReviewBatch,
  updateCatalogExercise,
  type BulkAiReviewAction,
  type ExerciseAiReviewDto,
  type ExerciseDto,
} from '../lib/api.js'

// The global exercise-catalog editor + AI muscle-map review pipeline.
// Catalog tab: search/filter the curated globals and edit any of them
// directly (fields + per-muscle role map). Proposals tab: pending AI
// reviews rendered as a current-vs-proposed diff with Apply/Dismiss.
// A "Run AI sweep" action walks the whole catalog in cursor-paged batches.

// Mirrors the server's per-request cap on POST /ai-reviews/bulk.
const BULK_DECIDE_MAX_IDS = 200

const ROLE_CYCLE: (MuscleRole | null)[] = [null, 'primary', 'secondary', 'stabilizer']
const ROLE_BADGE: Record<MuscleRole, string> = {
  primary: 'P',
  secondary: 'S',
  stabilizer: 'st',
}

function muscleLine(muscles: ExerciseDto['muscles']): string {
  if (muscles.length === 0) return '—'
  const name = (id: string) => MUSCLES.find((m) => m.id === id)?.name ?? id
  return muscles.map((m) => `${name(m.muscleId)} (${m.role})`).join(', ')
}

// --- inline editor ----------------------------------------------------

function ExerciseEditor({
  exercise,
  onSaved,
  onCancel,
}: {
  exercise: ExerciseDto
  onSaved: (updated: ExerciseDto) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(exercise.name)
  const [discipline, setDiscipline] = useState<string>(exercise.discipline)
  const [pattern, setPattern] = useState<string>(exercise.movementPattern)
  const [shape, setShape] = useState<string>(exercise.metricShape)
  const [unilateral, setUnilateral] = useState(exercise.unilateral)
  const [roles, setRoles] = useState<Map<string, MuscleRole>>(
    () => new Map(exercise.muscles.map((m) => [m.muscleId, m.role])),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function cycleRole(muscleId: string) {
    setRoles((cur) => {
      const next = new Map(cur)
      const current = next.get(muscleId) ?? null
      const idx = ROLE_CYCLE.indexOf(current)
      const nextRole = ROLE_CYCLE[(idx + 1) % ROLE_CYCLE.length]
      if (nextRole === null || nextRole === undefined) next.delete(muscleId)
      else next.set(muscleId, nextRole)
      return next
    })
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const updated = await updateCatalogExercise(exercise.id, {
        name: name.trim(),
        discipline: discipline as ExerciseDto['discipline'],
        movementPattern: pattern as ExerciseDto['movementPattern'],
        metricShape: shape as ExerciseDto['metricShape'],
        unilateral,
        muscles: [...roles.entries()].map(([muscleId, role]) => ({ muscleId, role })),
      })
      onSaved(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save exercise.')
    } finally {
      setSaving(false)
    }
  }

  const selectStyle = { minWidth: 140 } as const

  return (
    <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
      {error && <Banner tone="error">{error}</Banner>}
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={120}
        aria-label="Exercise name"
      />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <select value={discipline} onChange={(e) => setDiscipline(e.target.value)} style={selectStyle} aria-label="Discipline">
          {DISCIPLINES.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <select value={pattern} onChange={(e) => setPattern(e.target.value)} style={selectStyle} aria-label="Movement pattern">
          {MOVEMENT_PATTERNS.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <select value={shape} onChange={(e) => setShape(e.target.value)} style={selectStyle} aria-label="Metric shape">
          {METRIC_SHAPES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <input type="checkbox" checked={unilateral} onChange={(e) => setUnilateral(e.target.checked)} />
          unilateral
        </label>
      </div>
      {/* Per-muscle role map: click a muscle to cycle none → primary →
          secondary → stabilizer. */}
      <div style={{ display: 'grid', gap: 6 }}>
        {MUSCLE_GROUPS.map((g) => (
          <div key={g.id} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="muted" style={{ fontSize: 12, width: 76 }}>{g.name}</span>
            {MUSCLES.filter((m) => m.groupId === g.id).map((m) => {
              const role = roles.get(m.id)
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => cycleRole(m.id)}
                  title={role ?? 'not worked'}
                  style={{
                    padding: '4px 8px',
                    fontSize: 12,
                    cursor: 'pointer',
                    border: '1px solid',
                    borderColor: role ? 'var(--accent, #7c5cff)' : 'var(--edge, #444)',
                    background: role ? 'color-mix(in srgb, var(--accent, #7c5cff) 18%, transparent)' : 'transparent',
                    color: 'inherit',
                    borderRadius: 4,
                  }}
                >
                  {m.name}
                  {role ? ` · ${ROLE_BADGE[role]}` : ''}
                </button>
              )
            })}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button onClick={() => void save()} disabled={saving || !name.trim()}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

// --- proposals diff row -----------------------------------------------

function ReviewRow({
  review,
  acting,
  selected,
  onToggleSelect,
  onApply,
  onDismiss,
}: {
  review: ExerciseAiReviewDto
  acting: boolean
  selected: boolean
  onToggleSelect: () => void
  onApply: () => void
  onDismiss: () => void
}) {
  return (
    <li className="card" style={{ padding: '12px 16px', marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          {review.status === 'pending' && (
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelect}
              disabled={acting}
              aria-label={`Select proposal for ${review.exerciseName}`}
              style={{ marginTop: 4 }}
            />
          )}
          <div>
            <strong>{review.exerciseName}</strong>
            <div className="muted" style={{ fontSize: 13 }}>
              Current: {muscleLine(review.currentMuscles)}
            </div>
            <div style={{ fontSize: 13 }}>
              Proposed: {muscleLine(review.proposedMuscles)}
            </div>
            {review.rationale && (
              <div className="muted" style={{ fontSize: 13 }}>AI: {review.rationale}</div>
            )}
            <div className="muted" style={{ fontSize: 12 }}>{review.model}</div>
          </div>
        </div>
        {review.status === 'pending' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <Button onClick={onApply} disabled={acting}>Apply</Button>
            <Button variant="ghost" onClick={onDismiss} disabled={acting}>Dismiss</Button>
          </div>
        )}
      </div>
    </li>
  )
}

// --- page ---------------------------------------------------------------

export function ExerciseCatalogPage() {
  const [tab, setTab] = useState<'catalog' | 'proposals'>('catalog')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Catalog state
  const [exercises, setExercises] = useState<ExerciseDto[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [group, setGroup] = useState('')
  const [muscle, setMuscle] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [aiRunningId, setAiRunningId] = useState<string | null>(null)
  const generationRef = useRef(0)

  // Proposals state
  const [reviews, setReviews] = useState<ExerciseAiReviewDto[]>([])
  const [actingIds, setActingIds] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkActing, setBulkActing] = useState<BulkAiReviewAction | null>(null)
  // Mirrors bulkActing for loadReviews, which must not capture it as a
  // dependency (that would re-fire the tab effect on every bulk op).
  const bulkActingRef = useRef(false)

  // Sweep state
  const [sweeping, setSweeping] = useState(false)
  const sweepAbort = useRef(false)
  const [sweepProgress, setSweepProgress] = useState<string | null>(null)

  const loadCatalog = useCallback(async () => {
    const generation = ++generationRef.current
    setLoading(true)
    setError(null)
    try {
      const rows = await listCatalogExercises({
        ...(q.trim() ? { q: q.trim() } : {}),
        ...(group ? { group } : {}),
        ...(muscle ? { muscle } : {}),
      })
      if (generation !== generationRef.current) return
      setExercises(rows)
    } catch (err) {
      if (generation !== generationRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to load the catalog.')
    } finally {
      if (generation === generationRef.current) setLoading(false)
    }
  }, [q, group, muscle])

  const runReviews = useAsyncTask()
  const loadReviews = useCallback(async () => {
    // A refetch during a bulk op could snapshot the server mid-batch and
    // resurrect rows a chunk already decided; the local state is the
    // fresher view until the bulk loop finishes.
    if (bulkActingRef.current) return
    setError(null)
    await runReviews(async (ctx) => {
      try {
        const rows = await listAiReviews('pending')
        // Gate on both a superseding refetch (ctx.stale) and an in-flight bulk op.
        if (ctx.stale() || bulkActingRef.current) return
        setReviews(rows)
        // A fresh fetch invalidates any selection made against the old list.
        setSelected(new Set())
      } catch (err) {
        if (ctx.stale()) return
        setError(err instanceof Error ? err.message : 'Failed to load AI proposals.')
      }
    })
  }, [runReviews])

  useEffect(() => {
    if (tab === 'catalog') void loadCatalog()
    else void loadReviews()
  }, [tab, loadCatalog, loadReviews])

  async function reviewOne(exerciseId: string) {
    setAiRunningId(exerciseId)
    setError(null)
    setNotice(null)
    try {
      const res = await runAiReview(exerciseId)
      if (res.outcome === 'proposed') {
        setNotice('Proposal created — see the AI proposals tab.')
      } else if (res.outcome === 'unchanged') {
        setNotice('AI agrees with the current muscle map — nothing to change.')
      } else if (res.outcome === 'already_pending') {
        setNotice('A proposal for this exercise is already pending.')
      } else {
        setNotice('The AI response was unusable — try again.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI review failed.')
    } finally {
      setAiRunningId(null)
    }
  }

  async function sweep() {
    setSweeping(true)
    sweepAbort.current = false
    setError(null)
    setNotice(null)
    let cursor: string | null = null
    let proposed = 0
    let processed = 0
    try {
      // Cursor-paged batches keep each Worker call small; loop until the
      // catalog is exhausted or the admin cancels.
      do {
        const res = await runAiReviewBatch(cursor, 5)
        processed += res.processed
        proposed += res.proposed
        cursor = res.next_cursor
        setSweepProgress(`${processed} reviewed, ${proposed} proposals so far…`)
      } while (cursor && !sweepAbort.current)
      setNotice(
        sweepAbort.current
          ? `Sweep stopped: ${processed} reviewed, ${proposed} proposals.`
          : `Sweep complete: ${processed} reviewed, ${proposed} proposals.`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI sweep failed.')
    } finally {
      setSweeping(false)
      setSweepProgress(null)
    }
  }

  const proposalsBusy = bulkActing !== null || actingIds.size > 0
  const allSelected = reviews.length > 0 && reviews.every((r) => selected.has(r.id))
  const someSelected = selected.size > 0 && !allSelected

  // Deciding one proposal removes just that row locally — no refetch, so
  // the other rows (and the admin's scroll position) stay put while
  // triaging a long post-sweep queue.
  async function decide(review: ExerciseAiReviewDto, kind: BulkAiReviewAction) {
    setActingIds((cur) => new Set(cur).add(review.id))
    setError(null)
    setNotice(null)
    let remove = false
    try {
      if (kind === 'apply') await applyAiReview(review.id)
      else await dismissAiReview(review.id)
      remove = true
    } catch (err) {
      // 409/404 are terminal: the proposal was decided elsewhere (or
      // deleted), so the row leaves the list rather than sitting stuck.
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        remove = true
        setNotice('That proposal had already been decided elsewhere and left the list.')
      } else {
        setError(err instanceof Error ? err.message : `Failed to ${kind} the proposal.`)
      }
    } finally {
      if (remove) {
        setReviews((cur) => cur.filter((r) => r.id !== review.id))
        setSelected((cur) => {
          if (!cur.has(review.id)) return cur
          const next = new Set(cur)
          next.delete(review.id)
          return next
        })
      }
      setActingIds((cur) => {
        const next = new Set(cur)
        next.delete(review.id)
        return next
      })
    }
  }

  function toggleSelect(id: string) {
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function bulkDecide(action: BulkAiReviewAction) {
    const ids = [...selected]
    setBulkActing(action)
    bulkActingRef.current = true
    setError(null)
    setNotice(null)
    // Hoisted out of the try so a mid-loop failure can still report the
    // progress the earlier chunks committed.
    let succeededCount = 0
    let staleCount = 0
    const verb = action === 'apply' ? 'applied' : 'dismissed'
    try {
      // The route caps a batch at 200 ids; a post-sweep select-all can
      // exceed that, so chunk client-side and aggregate the outcomes.
      for (let i = 0; i < ids.length; i += BULK_DECIDE_MAX_IDS) {
        const res = await bulkDecideAiReviews(ids.slice(i, i + BULK_DECIDE_MAX_IDS), action)
        // Every reported outcome is terminal — not_found / not_pending
        // mean the proposal is no longer pending (decided elsewhere or
        // deleted), so those rows leave the list too instead of sitting
        // un-retryable.
        const decided = new Set(res.items.map((item) => item.id))
        succeededCount += res.applied + res.dismissed
        staleCount += res.failed
        setReviews((cur) => cur.filter((r) => !decided.has(r.id)))
        setSelected((cur) => {
          const next = new Set(cur)
          for (const id of decided) next.delete(id)
          return next
        })
      }
      if (staleCount > 0) {
        setNotice(
          `${succeededCount} proposal${succeededCount === 1 ? '' : 's'} ${verb}; ` +
            `${staleCount} had already been decided elsewhere and left the list.`,
        )
      } else {
        setNotice(`${succeededCount} proposal${succeededCount === 1 ? '' : 's'} ${verb}.`)
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : `Bulk ${action} failed.`
      const progress =
        succeededCount > 0 || staleCount > 0
          ? ` ${succeededCount} ${verb} before the failure; the remaining rows are still selected — retry to continue.`
          : ''
      setError(`${reason}${progress}`)
    } finally {
      bulkActingRef.current = false
      setBulkActing(null)
    }
  }

  return (
    <div className="page">
      <SubBar>
        <SubBarSeg active={tab === 'catalog'} onClick={() => setTab('catalog')}>
          Catalog
        </SubBarSeg>
        <SubBarSeg active={tab === 'proposals'} onClick={() => setTab('proposals')}>
          AI proposals{reviews.length > 0 ? ` (${reviews.length})` : ''}
        </SubBarSeg>
      </SubBar>

      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="info">{notice}</Banner>}

      {tab === 'catalog' ? (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
            <input
              type="search"
              placeholder="Search…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search exercises"
            />
            <select
              value={group}
              onChange={(e) => {
                setGroup(e.target.value)
                setMuscle('')
              }}
              aria-label="Muscle group filter"
            >
              <option value="">All groups</option>
              {MUSCLE_GROUPS.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
            <select
              value={muscle}
              onChange={(e) => setMuscle(e.target.value)}
              aria-label="Muscle filter"
              disabled={!group}
            >
              <option value="">All muscles</option>
              {MUSCLES.filter((m) => !group || m.groupId === group).map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
            <Button variant="ghost" onClick={() => void sweep()} disabled={sweeping}>
              {sweeping ? 'Sweeping…' : 'Run AI sweep'}
            </Button>
            {sweeping && (
              <Button variant="ghost" onClick={() => { sweepAbort.current = true }}>
                Stop
              </Button>
            )}
          </div>
          {sweepProgress && <p className="muted">{sweepProgress}</p>}

          {loading ? (
            <p className="muted">Loading…</p>
          ) : exercises.length === 0 ? (
            <p className="muted">No exercises match.</p>
          ) : (
            <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {exercises.map((ex) => (
                <li key={ex.id} className="card" style={{ padding: '12px 16px', marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div>
                      <strong>{ex.name}</strong>
                      <div className="muted" style={{ fontSize: 13 }}>
                        {ex.discipline} · {ex.movementPattern} · {ex.metricShape}
                        {ex.unilateral ? ' · unilateral' : ''}
                      </div>
                      <div className="muted" style={{ fontSize: 13 }}>
                        Muscles: {muscleLine(ex.muscles)}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                      <Button
                        variant="ghost"
                        onClick={() => setEditingId(editingId === ex.id ? null : ex.id)}
                      >
                        {editingId === ex.id ? 'Close' : 'Edit'}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => void reviewOne(ex.id)}
                        disabled={aiRunningId !== null || sweeping}
                      >
                        {aiRunningId === ex.id ? 'Reviewing…' : 'AI review'}
                      </Button>
                    </div>
                  </div>
                  {editingId === ex.id && (
                    <ExerciseEditor
                      exercise={ex}
                      onSaved={(updated) => {
                        setEditingId(null)
                        setExercises((cur) => cur.map((e) => (e.id === updated.id ? updated : e)))
                      }}
                      onCancel={() => setEditingId(null)}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : reviews.length === 0 ? (
        <p className="muted" style={{ marginTop: 12 }}>
          No pending AI proposals. Run an AI review from the Catalog tab.
        </p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '12px 0', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someSelected
                }}
                onChange={() =>
                  setSelected(allSelected ? new Set() : new Set(reviews.map((r) => r.id)))
                }
                disabled={proposalsBusy}
                aria-label="Select all proposals"
              />
              Select all
            </label>
            {selected.size > 0 && (
              <>
                <span className="muted" style={{ fontSize: 13 }}>{selected.size} selected</span>
                <Button className="fit" onClick={() => void bulkDecide('apply')} disabled={proposalsBusy}>
                  {bulkActing === 'apply' ? 'Applying…' : `Apply selected (${selected.size})`}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void bulkDecide('dismiss')}
                  disabled={proposalsBusy}
                >
                  {bulkActing === 'dismiss' ? 'Dismissing…' : `Dismiss selected (${selected.size})`}
                </Button>
              </>
            )}
          </div>
          <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {reviews.map((r) => (
              <ReviewRow
                key={r.id}
                review={r}
                acting={actingIds.has(r.id) || bulkActing !== null}
                selected={selected.has(r.id)}
                onToggleSelect={() => toggleSelect(r.id)}
                onApply={() => void decide(r, 'apply')}
                onDismiss={() => void decide(r, 'dismiss')}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
