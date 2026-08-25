// /library — the redesigned exercise catalog. Page head + search +
// rows grouped by discipline; All/Saved selection lives in the docked
// SubBar (route-driven: `/library` = all, `/library/saved` = saved-
// only). Each row has a leading star toggle (per-user favorites
// against the `exercise_favorites` table); tapping the body opens
// QuickLogSheet pre-filled for that exercise.

import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Banner, EmptyState, Icon } from '@rallypoint/ui'
import type { ExerciseDto } from '@rallypoint/fitness-shared'
import { DISCIPLINES } from '@rallypoint/fitness-shared'
import {
  ApiError,
  exercisesQuery,
  favoritesQuery,
  muscleGroupsQuery,
  starExercise,
  unstarExercise,
} from '../lib/api.js'
import { buildMuscleIndex, type MuscleIndex } from '../lib/exercise-view.js'
import { useCachedQuery } from '../lib/offline/use-cached-query.js'
import { QuickLogSheet } from '../ui/QuickLogSheet.js'
import { AddExerciseSheet } from '../ui/AddExerciseSheet.js'
import { MachineSettingsSheet } from '../ui/MachineSettingsSheet.js'
import { LibrarySubBar } from '../ui/LibrarySubBar.js'

const DEBOUNCE_MS = 320

function errMessage(err: unknown): string {
  return err instanceof ApiError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Something went wrong. Please try again.'
}

function disciplineLabel(d: string): string {
  return d.charAt(0).toUpperCase() + d.slice(1)
}

function muscleSummary(ex: ExerciseDto, index: MuscleIndex): string {
  if (ex.muscles.length === 0) return ''
  const primary = ex.muscles
    .filter((m) => m.role === 'primary')
    .slice(0, 2)
    .map((m) => index.get(m.muscleId)?.name ?? m.muscleId.replace(/_/g, ' '))
  return primary.join(' · ')
}

function LibRow({
  exercise,
  starred,
  onToggleStar,
  onQuickLog,
  onEdit,
  onMachineSettings,
  muscleIndex,
}: {
  exercise: ExerciseDto
  muscleIndex: MuscleIndex
  starred: boolean
  onToggleStar: () => void
  onQuickLog: () => void
  onEdit: () => void
  onMachineSettings: () => void
}) {
  return (
    <div className="lib-row">
      <button
        type="button"
        className={`lib-star${starred ? ' on' : ''}`}
        onClick={onToggleStar}
        aria-pressed={starred}
        aria-label={starred ? `Unstar ${exercise.name}` : `Star ${exercise.name}`}
      >
        <Icon name="star" size={16} />
      </button>
      <button type="button" className="lib-main" onClick={onQuickLog}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="nm">
            {exercise.name}
            {exercise.isCustom && (
              <span className="pl-chip sm">CUSTOM</span>
            )}
          </div>
          <div className="meta">
            {disciplineLabel(exercise.discipline)}
            {muscleSummary(exercise, muscleIndex) &&
              ` · ${muscleSummary(exercise, muscleIndex)}`}
          </div>
        </div>
        <Icon name="plus" size={16} />
      </button>
      <button
        type="button"
        className="lib-star"
        onClick={onMachineSettings}
        aria-label={`Machine settings for ${exercise.name}`}
      >
        <Icon name="gear" size={14} />
      </button>
      {/* Fixed trailing slot (the .set-row recipe): the Edit button is
          always rendered so the [star][gear][edit] cluster — and the
          width left for the name — never shifts between custom and
          built-in rows. Hidden (not unmounted) when not editable. */}
      <button
        type="button"
        className="lib-star"
        onClick={onEdit}
        aria-label={`Edit ${exercise.name}`}
        disabled={!exercise.isCustom}
        tabIndex={exercise.isCustom ? 0 : -1}
        style={exercise.isCustom ? undefined : { visibility: 'hidden' }}
      >
        <Icon name="pencil" size={14} />
      </button>
    </div>
  )
}

export function LibraryPage() {
  const { pathname } = useLocation()
  const tab: 'all' | 'saved' = pathname.endsWith('/saved') ? 'saved' : 'all'
  // Render-from-cache: both reads paint the last-known value instantly
  // and re-render on every cache write — including the star/unstar
  // mutations below, so no manual setAllExercises/setFavoriteIds
  // mirroring is needed.
  const exercisesQ = useCachedQuery(useMemo(() => exercisesQuery(), []))
  const favoritesQ = useCachedQuery(useMemo(() => favoritesQuery(), []))
  const muscleGroupsQ = useCachedQuery(useMemo(() => muscleGroupsQuery(), []))
  const muscleGroups = muscleGroupsQ.data ?? []
  const muscleIndex = useMemo(() => buildMuscleIndex(muscleGroups), [muscleGroups])
  const allExercises = exercisesQ.data ?? []
  const favoriteIds = useMemo(() => new Set(favoritesQ.data ?? []), [favoritesQ.data])
  const loading = exercisesQ.status === 'loading' || favoritesQ.status === 'loading'
  const [mutationError, setMutationError] = useState<string | null>(null)
  const error =
    mutationError ??
    (exercisesQ.status === 'error'
      ? errMessage(exercisesQ.error)
      : favoritesQ.status === 'error'
        ? errMessage(favoritesQ.error)
        : null)
  const [searchInput, setSearchInput] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  // Muscle filter: pick a group to narrow the list, then optionally one of
  // that group's specific muscles. Filters over the cached catalog's muscle
  // maps (works offline, same semantics as the API's ?group=/?muscle=).
  const [filterGroupId, setFilterGroupId] = useState<string | null>(null)
  const [filterMuscleId, setFilterMuscleId] = useState<string | null>(null)
  const [quickLogFor, setQuickLogFor] = useState<ExerciseDto | null>(null)
  const [adding, setAdding] = useState(false)
  const [editingExercise, setEditingExercise] = useState<ExerciseDto | null>(null)
  const [machineSettingsFor, setMachineSettingsFor] = useState<ExerciseDto | null>(null)

  // Debounce the search input — same pattern as ExerciseLibraryPage.
  useEffect(() => {
    const id = setTimeout(() => setSearchTerm(searchInput.trim().toLowerCase()), DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [searchInput])

  const filtered = useMemo(() => {
    let rows = allExercises
    if (tab === 'saved') rows = rows.filter((r) => favoriteIds.has(r.id))
    if (searchTerm) rows = rows.filter((r) => r.name.toLowerCase().includes(searchTerm))
    if (filterMuscleId) {
      rows = rows.filter((r) => r.muscles.some((m) => m.muscleId === filterMuscleId))
    } else if (filterGroupId) {
      rows = rows.filter((r) =>
        r.muscles.some((m) => muscleIndex.get(m.muscleId)?.groupId === filterGroupId),
      )
    }
    return rows
  }, [allExercises, favoriteIds, tab, searchTerm, filterGroupId, filterMuscleId, muscleIndex])

  // Group rows by discipline for the section eyebrows.
  const groups = useMemo(() => {
    const map = new Map<string, ExerciseDto[]>()
    for (const ex of filtered) {
      const k = ex.discipline
      const cur = map.get(k)
      if (cur) cur.push(ex)
      else map.set(k, [ex])
    }
    // Stable section order: follow the canonical DISCIPLINES enum, with
    // any unknown sections sorted alphabetically after.
    const known = DISCIPLINES.filter((d) => map.has(d))
    const unknown = Array.from(map.keys())
      .filter((k) => !(DISCIPLINES as readonly string[]).includes(k))
      .sort()
    return [...known, ...unknown].map((k) => ({ key: k, rows: map.get(k)! }))
  }, [filtered])

  async function toggleStar(ex: ExerciseDto) {
    // Local-first: the write patches the favorites cache and notifies
    // subscribers immediately; a hard failure reconciles the cache back
    // to server truth (engine.reconcileFailedOp), so no manual
    // optimistic toggle/rollback is needed here.
    const wasStarred = favoriteIds.has(ex.id)
    try {
      if (wasStarred) await unstarExercise(ex.id)
      else await starExercise(ex.id)
    } catch (err: unknown) {
      setMutationError(errMessage(err))
    }
  }

  return (
    <>
      <LibrarySubBar active={tab} />
      <div className="page-pad">
        <header className="fit-head">
          <div>
            <div className="eyebrow">EXERCISES</div>
            <h1>{tab === 'saved' ? 'Saved' : 'Library'}</h1>
          </div>
          <button
            type="button"
            className="fit-startbtn ghost"
            onClick={() => setAdding(true)}
            style={{ alignSelf: 'center' }}
          >
            + Add exercise
          </button>
        </header>

        {error && <Banner tone="error">{error}</Banner>}

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11, color: 'var(--ink-dim)', fontWeight: 500 }}>Search</span>
          <input
            type="search"
            className="pl-input"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search exercises…"
            style={{ fontSize: 16 }}
          />
        </label>

        {muscleGroups.length > 0 && (
          <div style={{ display: 'grid', gap: 6, margin: '10px 0' }}>
            <div className="day-chips" aria-label="Filter by muscle group">
              {muscleGroups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  aria-pressed={filterGroupId === g.id}
                  className={`day-chip${filterGroupId === g.id ? ' on' : ''}`}
                  onClick={() => {
                    setFilterGroupId((cur) => (cur === g.id ? null : g.id))
                    setFilterMuscleId(null)
                  }}
                >
                  {g.name}
                </button>
              ))}
            </div>
            {filterGroupId &&
              (() => {
                const group = muscleGroups.find((g) => g.id === filterGroupId)
                if (!group || group.muscles.length <= 1) return null
                return (
                  <div className="day-chips" aria-label="Filter by muscle">
                    {group.muscles.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        aria-pressed={filterMuscleId === m.id}
                        className={`day-chip sm${filterMuscleId === m.id ? ' on' : ''}`}
                        onClick={() =>
                          setFilterMuscleId((cur) => (cur === m.id ? null : m.id))
                        }
                      >
                        {m.name}
                      </button>
                    ))}
                  </div>
                )
              })()}
          </div>
        )}

      {loading ? (
        <div style={{ color: 'var(--ink-dim)' }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title={tab === 'saved' ? 'No saved exercises yet' : 'Nothing matches'}
          body={
            tab === 'saved'
              ? 'Tap the star on any exercise to save it here.'
              : 'Try clearing the search or switching back to All.'
          }
        />
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          {groups.map((g) => (
            <section key={g.key} style={{ display: 'grid', gap: 0 }}>
              <div className="sec-rule" style={{ margin: '4px 0' }}>
                <div className="eyebrow">{disciplineLabel(g.key)}</div>
                <div className="line" />
                <span className="ct">{g.rows.length}</span>
              </div>
              <div>
                {g.rows.map((ex) => (
                  <LibRow
                    key={ex.id}
                    exercise={ex}
                    muscleIndex={muscleIndex}
                    starred={favoriteIds.has(ex.id)}
                    onToggleStar={() => toggleStar(ex)}
                    onQuickLog={() => setQuickLogFor(ex)}
                    onEdit={() => setEditingExercise(ex)}
                    onMachineSettings={() => setMachineSettingsFor(ex)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

        {adding && (
          <AddExerciseSheet
            onClose={() => setAdding(false)}
            // createExercise is local-first — the exercises cache is
            // already patched and subscribers notified by the time this
            // fires, so there's nothing left to do here.
            onCreated={() => {}}
          />
        )}

        {editingExercise && (
          <AddExerciseSheet
            exercise={editingExercise}
            onClose={() => setEditingExercise(null)}
            onCreated={() => {}}
            onDeleted={() => {}}
          />
        )}

        {quickLogFor && (
          <QuickLogSheet
            exercise={quickLogFor}
            onClose={() => setQuickLogFor(null)}
            onSaved={() => setQuickLogFor(null)}
          />
        )}

        {machineSettingsFor && (
          <MachineSettingsSheet
            exerciseId={machineSettingsFor.id}
            exerciseName={machineSettingsFor.name}
            onClose={() => setMachineSettingsFor(null)}
          />
        )}

      </div>
    </>
  )
}
