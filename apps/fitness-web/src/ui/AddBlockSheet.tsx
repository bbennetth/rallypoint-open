// Bottom sheet for adding exercises to a RUNNING strength session
// (mid-workout edits). Mirrors the composer's per-exercise config —
// sets × reps with a MAX (amrap) toggle, load in the display unit,
// target RPE, rest between sets — and supports supersets: add several
// exercises at once as one bracket, or attach to an existing exercise/
// bracket (insertion lands after that bracket, never splitting it).
// Confirm returns ready blocks + placement for one ADD_BLOCKS dispatch.

import { useMemo, useState } from 'react'
import { Banner, Drawer, Icon, SwipeActions } from '@rallypoint/ui'
import type { ExerciseDto, StrengthBlock } from '@rallypoint/fitness-shared'
import { bracketRange, formatMmss, parseMmss, recommendLoad } from '@rallypoint/fitness-shared'
import { exercisesQuery } from '../lib/api.js'
import {
  defaultSetsForExercise,
  defaultWorkUnitForShape,
  slugify,
  unitSwitchable,
  WORK_UNITS,
  type WorkUnit,
} from '../lib/composer-state.js'
import { resolveExerciseIds, withResolvedId } from '../lib/exercise-resolve.js'
import {
  getDefaultReps,
  getDefaultSets,
  repsPrescriptionFromDefault,
} from '../lib/set-defaults.js'
import { displayToKg, useWeightUnit } from '../lib/units.js'
import { useCachedQuery } from '../lib/offline/use-cached-query.js'
import { AddExerciseSheet } from './AddExerciseSheet.js'
import { ExercisePicker } from './ExercisePicker.js'
import { MmssInput } from './MmssInput.js'
import { NumericField } from './NumericField.js'

export interface AddBlockSheetProps {
  onClose: () => void
  /** One ADD_BLOCKS dispatch: the built blocks plus placement. */
  onAdd: (payload: {
    blocks: Omit<StrengthBlock, 'currentSetIdx'>[]
    attachTo?: number
    asSuperset?: boolean
  }) => void
  /** Existing session blocks, for the attach-to picker. */
  blocks: readonly StrengthBlock[]
}

interface ExerciseRow {
  name: string
  exerciseId: string | null
  /** Prescription unit — reps × load for lifting, cal / distance / time
   *  for cardio machines. Flips to the picked exercise's natural shape
   *  (defaultWorkUnitForShape), switchable via the unit segment. */
  workUnit: WorkUnit
  sets: number
  /** True once the athlete has typed a set count themselves. Picking an
   *  exercise re-derives `sets` from its category only while this is
   *  false — a deliberately typed 5 survives the pick. */
  setsTouched: boolean
  reps: number
  /** Non-rep target amount: mm:ss text for `time`, plain number text
   *  for `calories`/`distance`. '' = no target (a time set left blank
   *  gets filled live by the per-set stopwatch). */
  cardioTarget: string
  /** Max-effort sets: reps becomes "as many as possible" (amrapTarget). */
  max: boolean
  /** Load in the user's display unit; '' = none (bodyweight/blank). */
  load: string
  /** Target RPE 1–10 in half steps; '' = none. */
  rpe: string
  /** Rest between this exercise's sets, mm:ss text; '' = engine default. */
  restS: string
}

function emptyRow(): ExerciseRow {
  // Read the athlete's preferred sets × reps at row-creation time
  // (Settings → "Default sets × reps") rather than module load, so a
  // mid-session settings change applies to the next added exercise.
  // A 'max' reps preference starts the row as a max-effort set (MAX
  // toggle on) with the product-default count behind the toggle.
  const { reps, max } = repsPrescriptionFromDefault(getDefaultReps())
  return {
    name: '',
    exerciseId: null,
    workUnit: 'reps',
    sets: getDefaultSets(),
    setsTouched: false,
    reps,
    cardioTarget: '',
    max,
    load: '',
    rpe: '',
    restS: '',
  }
}

/** The prescription defaults a picked catalog exercise implies: its
 *  natural work unit (Ski Erg → distance, not reps × load) and its set
 *  count (cardio / timed work is a single entry, not 3 sets). Shared by
 *  BOTH pick paths — the typeahead and the inline "create exercise"
 *  sheet — which previously derived the unit in one and neither in the
 *  other, so a custom "Duration only" exercise landed as reps × 3. */
function prescriptionForPicked(
  row: ExerciseRow,
  picked: ExerciseDto,
): Partial<ExerciseRow> {
  return {
    workUnit: defaultWorkUnitForShape(picked.metricShape),
    ...(row.setsTouched ? {} : { sets: defaultSetsForExercise(picked, getDefaultSets()) }),
  }
}

/** One attach option per existing bracket (keyed by its first block).
 *  A grouped bracket lists all member names under its letter. */
function attachOptions(blocks: readonly StrengthBlock[]): { idx: number; label: string }[] {
  const out: { idx: number; label: string }[] = []
  let i = 0
  while (i < blocks.length) {
    const [start, end] = bracketRange(blocks, i)
    const names = blocks.slice(start, end + 1).map((b) => b.name)
    const g = blocks[start]!.group
    out.push({
      idx: start,
      label: end > start && g != null ? `${g}: ${names.join(' + ')}` : names[0]!,
    })
    i = end + 1
  }
  return out
}

export function AddBlockSheet({ onClose, onAdd, blocks }: AddBlockSheetProps) {
  // Render-from-cache like the composer: the catalog is usually warm
  // by the time a session is running; a cold miss degrades to typing a
  // free-form name (slug fallback at save).
  const catalogQ = useCachedQuery(useMemo(() => exercisesQuery(), []))
  const catalog: ExerciseDto[] = catalogQ.data ?? []
  const unit = useWeightUnit()

  const [rows, setRows] = useState<ExerciseRow[]>([emptyRow()])
  // '' = standalone (append at end); otherwise the bracket-start index
  // of the existing exercise/bracket to superset with.
  const [attachTo, setAttachTo] = useState('')
  const [intraRest, setIntraRest] = useState('')
  const [restAfter, setRestAfter] = useState('')
  const [createFor, setCreateFor] = useState<{ index: number; query: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // In-flight guard: confirm() awaits exercise creation for free-typed
  // names, so a fast double-tap must not create duplicates.
  const [confirming, setConfirming] = useState(false)

  const targets = useMemo(() => attachOptions(blocks), [blocks])
  const isSuperset = rows.length > 1 || attachTo !== ''

  /** Patch row `i`. A patch FUNCTION is evaluated against the row as it
   *  exists in the setter, so derivations that read the current row
   *  (prescriptionForPicked's setsTouched check) can't see a stale copy
   *  from the render closure. */
  function updateRow(
    i: number,
    patch: Partial<ExerciseRow> | ((row: ExerciseRow) => Partial<ExerciseRow>),
  ) {
    setRows((rs) =>
      rs.map((r, idx) =>
        idx === i ? { ...r, ...(typeof patch === 'function' ? patch(r) : patch) } : r,
      ),
    )
  }

  async function confirm() {
    if (confirming) return
    const filled = rows.map((r) => ({ ...r, name: r.name.trim() })).filter((r) => r.name)
    if (filled.length === 0) {
      setError('Pick or type an exercise.')
      return
    }
    setConfirming(true)
    // Free-typed names resolve to REAL catalog ids (match or create) —
    // never a synthesized fx_seed_ id, which 404s on machine settings
    // and the final workout save.
    let resolvedRows: typeof filled
    try {
      const resolved = await resolveExerciseIds(filled, catalog)
      resolvedRows = filled.map((r) => withResolvedId(r, resolved))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not add that exercise.')
      setConfirming(false)
      return
    }
    // mm:ss text parses on confirm; unparseable = no prescription (same
    // silent-drop convention as the composer's rest fields).
    const intraRestS = intraRest ? parseMmss(intraRest) : null
    const restAfterS = restAfter ? parseMmss(restAfter) : null
    // Recompute against the FILLED rows: an added-then-left-blank second
    // row must not turn a single exercise into a one-member "superset".
    const superset = filled.length > 1 || attachTo !== ''
    const built = resolvedRows.map((r, i) => {
      const isReps = r.workUnit === 'reps'
      const rec = !isReps || r.max ? null : recommendLoad(r.reps, null)
      const loadKg = r.load ? Number(r.load) : NaN
      const rpe = r.rpe ? Math.round(Number(r.rpe) * 2) / 2 : NaN
      const targetRpe = Number.isFinite(rpe) && rpe >= 1 && rpe <= 10 ? rpe : null
      const isLast = i === filled.length - 1
      const mkSet = (): Omit<StrengthBlock, 'currentSetIdx'>['sets'][number] => {
        if (isReps) {
          return {
            // A MAX set has no rep target — the athlete enters the
            // achieved count before checking off (mirrors
            // sessionFromStrengthBody).
            reps: r.max ? null : Math.max(1, r.reps),
            calories: null,
            distanceM: null,
            timeS: null,
            inclinePct: null,
            loadKg:
              Number.isFinite(loadKg) && loadKg >= 0 ? displayToKg(loadKg, unit) : null,
            done: false,
            doneAtMs: null,
            targetRpe,
            setType: 'working' as const,
            ...(r.max ? { amrapTarget: true } : {}),
          }
        }
        // Cardio: the target may be blank — a time set with no target is
        // the stopwatch case, filled live. The explicit unit hint keeps
        // a target-less set rendering in its unit.
        const timeS = r.workUnit === 'time' && r.cardioTarget ? parseMmss(r.cardioTarget) : null
        const num = r.cardioTarget ? Number(r.cardioTarget) : NaN
        const amount = Number.isFinite(num) && num > 0 ? num : null
        return {
          reps: null,
          calories: r.workUnit === 'calories' && amount != null ? Math.round(amount) : null,
          distanceM: r.workUnit === 'distance' ? amount : null,
          timeS: timeS != null && timeS > 0 ? Math.min(4 * 60 * 60, timeS) : null,
          inclinePct: null,
          loadKg: null,
          done: false,
          doneAtMs: null,
          targetRpe,
          setType: 'working' as const,
          unit:
            r.workUnit === 'calories'
              ? ('calories' as const)
              : r.workUnit === 'distance'
                ? ('distanceM' as const)
                : ('timeS' as const),
        }
      }
      const block: Omit<StrengthBlock, 'currentSetIdx'> = {
        exerciseId: r.exerciseId ?? `fx_seed_${slugify(r.name)}`,
        name: r.name,
        suggestedKg: rec?.kg ?? null,
        suggestedBasis: rec?.basis ?? null,
        suggestedLastKg: rec?.lastKg ?? null,
        suggestedBumpKg: rec?.bumpKg ?? null,
        sets: Array.from({ length: Math.max(1, r.sets) }, mkSet),
      }
      const restS = r.restS ? parseMmss(r.restS) : null
      if (restS != null) block.restS = Math.min(600, restS)
      if (superset) {
        // Intra-superset handoff rest rides on every member except the
        // overall last; rest-after-bracket on the last.
        if (!isLast && intraRestS != null) block.intraRestS = Math.min(600, intraRestS)
        if (isLast && restAfterS != null) block.restAfterS = Math.min(600, restAfterS)
      }
      return block
    })
    const attachIdx = attachTo === '' ? undefined : Number(attachTo)
    onAdd({
      blocks: built,
      ...(attachIdx !== undefined ? { attachTo: attachIdx } : {}),
      ...(superset ? { asSuperset: true } : {}),
    })
    onClose()
  }

  return (
    <Drawer open mobileSheet mobileFull title="Add exercise" onClose={onClose}>
      {/* Flex column filling the full-height sheet so the actions pin to
          the bottom edge instead of stranding mid-screen above a void
          (the top-heavy look flagged in the session review). */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: '100%' }}>
        {error && <Banner tone="error">{error}</Banner>}

        {rows.map((r, i) => (
          <div
            key={i}
            className={isSuperset ? 'fit-card cmp-ss-card' : undefined}
            style={{ display: 'grid', gap: 10, ...(isSuperset ? { padding: 12 } : {}) }}
          >
            {/* Remove-exercise lives in the row's swipe/hover tray (Soft
                Ink); the only row passes empty actions. Superset rows sit
                inside the tinted card (inherit); plain rows sit on the
                drawer chassis (var(--bg)). */}
            <SwipeActions
              className={isSuperset ? 'swipe-inline' : 'swipe-page'}
              actions={
                rows.length > 1
                  ? [
                      {
                        key: 'delete',
                        label: `Remove ${r.name || 'exercise'}`,
                        text: 'Remove',
                        icon: <Icon name="trash" size={14} />,
                        onAction: () => setRows((rs) => rs.filter((_, idx) => idx !== i)),
                      },
                    ]
                  : []
              }
              contentStyle={{ display: 'flex', gap: 8, alignItems: 'center' }}
            >
              {isSuperset && (
                <span className="live-ss-chip" style={{ flex: 'none' }}>
                  {i + 1}
                </span>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <ExercisePicker
                  exercises={catalog}
                  value={r.name}
                  placeholder="back squat"
                  onChange={(next) => {
                    // Picking a catalog exercise resets the row's
                    // prescription unit to its natural shape (Ski Erg →
                    // distance/cal/time, not reps × load) — same rule as
                    // the composer builders — and its set count to what
                    // the exercise's category implies.
                    const picked = next.exerciseId
                      ? catalog.find((e) => e.id === next.exerciseId)
                      : undefined
                    updateRow(i, (row) => ({
                      ...next,
                      ...(picked ? prescriptionForPicked(row, picked) : {}),
                    }))
                  }}
                  onCreate={(query) => setCreateFor({ index: i, query })}
                />
              </div>
            </SwipeActions>

            {unitSwitchable(r, catalog) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span className="cmp-label" style={{ margin: 0 }}>
                  MEASURED IN
                </span>
                <div className="fit-seg" role="tablist" style={{ width: 'auto' }}>
                  {WORK_UNITS.map((u) => (
                    <button
                      key={u}
                      type="button"
                      role="tab"
                      aria-selected={r.workUnit === u}
                      className={r.workUnit === u ? 'on' : ''}
                      onClick={() => updateRow(i, { workUnit: u, cardioTarget: '' })}
                    >
                      {u}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <NumericField
                value={r.sets}
                min={1}
                max={20}
                onCommit={(v) => updateRow(i, { sets: v ?? 1, setsTouched: true })}
                aria-label="Target sets"
                style={{ width: 64, textAlign: 'center' }}
              />
              <span style={{ color: 'var(--ink-mute)' }}>sets ×</span>
              {r.workUnit === 'time' ? (
                <>
                  <MmssInput
                    value={r.cardioTarget}
                    onCommit={(v) => updateRow(i, { cardioTarget: v })}
                    maxS={4 * 60 * 60}
                    placeholder="0:00"
                    // Wider than the sibling rest fields (which cap at
                    // 10:00): this one accepts up to 4h, so it has to fit
                    // a 6-character "240:00" in the mono input font.
                    style={{ width: 104 }}
                    aria-label="Target time (mm:ss), optional"
                  />
                  <span style={{ color: 'var(--ink-mute)' }}>
                    time — blank to just run the stopwatch
                  </span>
                </>
              ) : r.workUnit === 'calories' || r.workUnit === 'distance' ? (
                <>
                  <input
                    className="pl-input"
                    type="number"
                    value={r.cardioTarget}
                    onChange={(e) => updateRow(i, { cardioTarget: e.target.value })}
                    placeholder={r.workUnit === 'calories' ? 'cal' : 'm'}
                    aria-label={
                      r.workUnit === 'calories' ? 'Target calories' : 'Target distance (m)'
                    }
                    style={{ width: 80, fontSize: 16 }}
                  />
                  <span style={{ color: 'var(--ink-mute)' }}>
                    {r.workUnit === 'calories' ? 'cal' : 'm'}
                  </span>
                </>
              ) : r.max ? (
                <span style={{ color: 'var(--ink-mute)' }}>max reps</span>
              ) : (
                <>
                  <NumericField
                    value={r.reps}
                    min={1}
                    max={999}
                    onCommit={(v) => updateRow(i, { reps: v ?? 1 })}
                    aria-label="Target reps"
                    style={{ width: 64, textAlign: 'center' }}
                  />
                  <span style={{ color: 'var(--ink-mute)' }}>reps</span>
                </>
              )}
              {r.workUnit === 'reps' && (
                <button
                  type="button"
                  className={`pl-chip${r.max ? ' pl-chip-active' : ''}`}
                  style={{ cursor: 'pointer', flex: 'none' }}
                  aria-pressed={r.max}
                  title="Max-effort sets — as many reps as possible"
                  onClick={() => updateRow(i, { max: !r.max })}
                >
                  MAX
                </button>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {r.workUnit === 'reps' && (
                <input
                  className="pl-input"
                  type="number"
                  value={r.load}
                  onChange={(e) => updateRow(i, { load: e.target.value })}
                  placeholder={unit}
                  aria-label={`Load in ${unit}`}
                  style={{ width: 80, fontSize: 16 }}
                />
              )}
              <input
                className="pl-input"
                type="number"
                step={0.5}
                min={1}
                max={10}
                value={r.rpe}
                onChange={(e) => updateRow(i, { rpe: e.target.value })}
                placeholder="RPE"
                aria-label="Target RPE"
                style={{ width: 64, fontSize: 16 }}
              />
              <span className="cmp-label" style={{ margin: 0 }}>
                REST
              </span>
              <MmssInput
                value={r.restS}
                onCommit={(v) => updateRow(i, { restS: v })}
                maxS={600}
                placeholder={formatMmss(90)}
                style={{ width: 80 }}
                aria-label="Rest between sets (mm:ss)"
              />
            </div>
          </div>
        ))}

        <button
          type="button"
          className="fit-startbtn ghost"
          onClick={() => setRows((rs) => [...rs, emptyRow()])}
          style={{ padding: 10 }}
        >
          + Add another exercise (superset)
        </button>

        {targets.length > 0 && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="cmp-label">SUPERSET WITH</span>
            <select
              className="pl-input"
              value={attachTo}
              onChange={(e) => setAttachTo(e.target.value)}
              style={{ fontSize: 16 }}
            >
              <option value="">
                {rows.length > 1 ? 'Nothing — new superset at the end' : 'Nothing — add at the end'}
              </option>
              {targets.map((t) => (
                <option key={t.idx} value={String(t.idx)}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        )}

        {isSuperset && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="cmp-label" style={{ margin: 0 }}>
              REST TO NEXT EXERCISE
            </span>
            <MmssInput
              value={intraRest}
              onCommit={setIntraRest}
              maxS={600}
              placeholder="none"
              style={{ width: 80 }}
              aria-label="Rest between superset exercises (mm:ss)"
            />
            <span className="cmp-label" style={{ margin: 0 }}>
              REST AFTER SUPERSET
            </span>
            <MmssInput
              value={restAfter}
              onCommit={setRestAfter}
              maxS={600}
              placeholder={formatMmss(90)}
              style={{ width: 80 }}
              aria-label="Rest after the superset (mm:ss)"
            />
          </div>
        )}

        <div className="btn-row" style={{ marginTop: 'auto' }}>
          <button type="button" className="fit-startbtn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="fit-startbtn" onClick={confirm} disabled={confirming}>
            {confirming ? 'Adding…' : 'Add to session'}
          </button>
        </div>
      </div>

      {createFor != null && (
        <AddExerciseSheet
          initialName={createFor.query}
          onClose={() => setCreateFor(null)}
          onCreated={(ex) => {
            updateRow(createFor.index, (row) => ({
              name: ex.name,
              exerciseId: ex.id,
              // A just-created exercise carries a category too, so this
              // path derives the same prescription the typeahead pick
              // does — it previously derived neither unit nor sets, so a
              // custom "Duration only" exercise landed as reps × 3.
              ...prescriptionForPicked(row, ex),
            }))
          }}
        />
      )}
    </Drawer>
  )
}
