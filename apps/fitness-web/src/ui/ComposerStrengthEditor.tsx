// Standard/strength-mode editor JSX for ComposerPage — extracted as a
// move-only split. All state, effects, and save handlers stay in
// ComposerPage; this component only renders the block/set editor for a
// non-null `strengthState` and reports edits back through the handlers
// passed in as props.

import type { Dispatch, SetStateAction } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import { Banner, Icon, SwipeActions } from '@rallypoint/ui'
import { formatMmss } from '@rallypoint/fitness-shared'
import type { ExerciseDto } from '@rallypoint/fitness-shared'
import {
  applyFirstSetToAll,
  applyRestToAllBlocks,
  defaultWorkUnitForShape,
  moveStrengthBlock,
  showRestForBlock,
  switchDistanceUnit,
  toggleSupersetWithPrevious,
  unitSwitchable,
  WORK_UNITS,
  type ComposerStrengthSetRow,
  type ComposerStrengthState,
} from '../lib/composer-state.js'
import {
  composerBracket,
  showLoadForUnit,
  WORK_UNIT_LABELS,
  WORK_UNIT_PLACEHOLDER,
  type ScheduleChoice,
} from '../lib/composer-template.js'
import { ExercisePicker } from './ExercisePicker.js'
import { MmssInput } from './MmssInput.js'
import { ScheduleChips } from './ScheduleChips.js'
import type { WeightUnit } from '../lib/units.js'

export function ComposerStrengthEditor({
  strengthState,
  catalog,
  unit,
  defaultRestS,
  schedule,
  chooseSchedule,
  saving,
  editId,
  fieldError,
  nav,
  setStrengthState,
  setCreateFor,
  updateStrengthBlock,
  updateStrengthSet,
  addStrengthSet,
  removeStrengthSet,
  addStrengthBlock,
  removeStrengthBlock,
  handleStrengthSave,
  handleStartNow,
}: {
  strengthState: ComposerStrengthState
  catalog: ExerciseDto[]
  unit: WeightUnit
  defaultRestS: number
  schedule: ScheduleChoice
  chooseSchedule: (next: ScheduleChoice) => void
  saving: boolean
  editId: string | null
  fieldError: string | null
  nav: NavigateFunction
  setStrengthState: Dispatch<SetStateAction<ComposerStrengthState | null>>
  setCreateFor: Dispatch<
    SetStateAction<{ index: number; query: string; mode: 'wod' | 'strength' | 'buyin' } | null>
  >
  updateStrengthBlock: (
    i: number,
    patch: Partial<
      Pick<
        NonNullable<ComposerStrengthState['blocks'][number]>,
        'name' | 'exerciseId' | 'restS' | 'restAfterS' | 'intraRestS' | 'workUnit' | 'distanceUnit'
      >
    >,
  ) => void
  updateStrengthSet: (
    blockIdx: number,
    setIdx: number,
    patch: Partial<Pick<ComposerStrengthSetRow, 'reps' | 'loadKg' | 'timeS' | 'inclinePct' | 'amrap' | 'rpe'>>,
  ) => void
  addStrengthSet: (blockIdx: number) => void
  removeStrengthSet: (blockIdx: number, setIdx: number) => void
  addStrengthBlock: () => void
  removeStrengthBlock: (blockIdx: number) => void
  handleStrengthSave: (args: { andStart: boolean }) => void | Promise<void>
  handleStartNow: (args: { force: boolean }) => void | Promise<void>
}) {
  return (
    <>
      {fieldError && <Banner tone="error">{fieldError}</Banner>}

      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="cmp-label">NAME</span>
        <input
          className="pl-input"
          value={strengthState.name}
          onChange={(e) => setStrengthState((s) => (s ? { ...s, name: e.target.value } : s))}
          placeholder="e.g. Lower body A"
          style={{ fontSize: 16 }}
        />
      </label>

      <section style={{ display: 'grid', gap: 10 }}>
        <span className="cmp-label">EXERCISES</span>
        {strengthState.blocks.map((b, bi) => {
          // Superset geometry for this card: bracket membership drives
          // the A1/A2 chip, the accent rail, and which rest inputs show.
          const bracket = composerBracket(strengthState.blocks, bi)
          const inBracket = b.group != null && bracket.end > bracket.start
          const lastInBracket = inBracket && bi === bracket.end
          const linkedWithPrev =
            b.group != null && (strengthState.blocks[bi - 1]?.group ?? null) === b.group
          return (
            <div
              key={bi}
              className={`fit-card${inBracket ? ' cmp-ss-card' : ''}`}
              style={{ padding: 12, display: 'grid', gap: 8 }}
            >
              {/* Remove-exercise lives in the header's swipe/hover tray
                  (Soft Ink); ↑/↓ stay inline. The last block passes
                  empty actions — a workout needs at least one. */}
              <SwipeActions
                className="swipe-inline"
                actions={
                  strengthState.blocks.length > 1
                    ? [
                        {
                          key: 'delete',
                          label: `Remove ${b.name || 'exercise'}`,
                          text: 'Remove',
                          icon: <Icon name="trash" size={14} />,
                          onAction: () => removeStrengthBlock(bi),
                        },
                      ]
                    : []
                }
                contentStyle={{ display: 'flex', gap: 8, alignItems: 'center' }}
              >
                {inBracket && (
                  <span className="live-ss-chip" style={{ flex: 'none' }}>
                    {b.group}
                    {bi - bracket.start + 1}
                  </span>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <ExercisePicker
                    exercises={catalog}
                    value={b.name}
                    placeholder="back squat"
                    onChange={(next) => {
                      // Picking a catalog exercise resets the block's
                      // prescription unit to its natural shape (Assault
                      // Bike → distance/cal/time, not reps × load) —
                      // same rule as the WOD builder.
                      const picked = next.exerciseId
                        ? catalog.find((e) => e.id === next.exerciseId)
                        : undefined
                      updateStrengthBlock(bi, {
                        ...next,
                        ...(picked ? { workUnit: defaultWorkUnitForShape(picked.metricShape) } : {}),
                      })
                    }}
                    onCreate={(query) => setCreateFor({ index: bi, query, mode: 'strength' })}
                  />
                </div>
                <button
                  type="button"
                  className="mv-rm"
                  onClick={() => setStrengthState((s) => (s ? moveStrengthBlock(s, bi, -1) : s))}
                  disabled={bi === 0}
                  aria-label={`Move ${b.name || 'exercise'} up`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="mv-rm"
                  onClick={() => setStrengthState((s) => (s ? moveStrengthBlock(s, bi, 1) : s))}
                  disabled={bi === strengthState.blocks.length - 1}
                  aria-label={`Move ${b.name || 'exercise'} down`}
                >
                  ↓
                </button>
              </SwipeActions>
              {unitSwitchable(b, catalog) && (
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
                        aria-selected={b.workUnit === u}
                        className={b.workUnit === u ? 'on' : ''}
                        onClick={() => updateStrengthBlock(bi, { workUnit: u })}
                      >
                        {WORK_UNIT_LABELS[u]}
                      </button>
                    ))}
                  </div>
                  {b.workUnit === 'distance' && (
                    <div className="fit-seg" role="tablist" style={{ width: 'auto' }}>
                      {(['m', 'mi'] as const).map((du) => (
                        <button
                          key={du}
                          type="button"
                          role="tab"
                          aria-selected={(b.distanceUnit ?? 'm') === du}
                          className={(b.distanceUnit ?? 'm') === du ? 'on' : ''}
                          onClick={() =>
                            // Converts the typed amounts too — a unit
                            // flip must never reinterpret "5000" m as
                            // 5000 mi at save (review P1).
                            setStrengthState((s) =>
                              s
                                ? {
                                    ...s,
                                    blocks: s.blocks.map((blk, idx) =>
                                      idx === bi ? switchDistanceUnit(blk, du) : blk,
                                    ),
                                  }
                                : s,
                            )
                          }
                        >
                          {du === 'm' ? 'meters' : 'miles'}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {b.sets.map((st, si) => {
                // Distance (running) sets carry four inputs — distance,
                // time, incline, load — plus RPE. Cramming all of them
                // onto one line squeezed each into an unusable sliver, so
                // distance rows wrap: line 1 = distance + time (remove
                // lives in the swipe/hover tray), line 2 = incline /
                // load / RPE at a readable width.
                const isDistance = b.workUnit === 'distance'
                return (
                  // Remove-set lives in the swipe/hover tray (Soft Ink);
                  // the last set passes empty actions — a block needs one.
                  <SwipeActions
                    key={si}
                    className="swipe-inline"
                    actions={
                      b.sets.length > 1
                        ? [
                            {
                              key: 'delete',
                              label: `Remove set ${si + 1}`,
                              text: 'Remove',
                              icon: <Icon name="trash" size={14} />,
                              onAction: () => removeStrengthSet(bi, si),
                            },
                          ]
                        : []
                    }
                    contentStyle={{
                      display: 'flex',
                      gap: 6,
                      alignItems: 'center',
                      flexWrap: isDistance ? 'wrap' : 'nowrap',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        color: 'var(--ink-mute)',
                        width: 22,
                        flex: 'none',
                      }}
                    >
                      {si + 1}
                    </span>
                    <input
                      className="pl-input"
                      type="number"
                      value={st.reps}
                      onChange={(e) => updateStrengthSet(bi, si, { reps: e.target.value })}
                      placeholder={
                        b.workUnit === 'reps' && st.amrap
                          ? 'max'
                          : b.workUnit === 'distance' && b.distanceUnit === 'mi'
                            ? 'miles'
                            : WORK_UNIT_PLACEHOLDER[b.workUnit]
                      }
                      aria-label={`Set ${si + 1} amount in ${
                        b.workUnit === 'distance' && b.distanceUnit === 'mi' ? 'mi' : WORK_UNIT_LABELS[b.workUnit]
                      }`}
                      style={{ flex: 1, minWidth: 0 }}
                    />
                    {isDistance && (
                      <MmssInput
                        value={st.timeS ?? ''}
                        onCommit={(v) => updateStrengthSet(bi, si, { timeS: v })}
                        maxS={4 * 60 * 60}
                        placeholder="time"
                        aria-label={`Set ${si + 1} total time (mm:ss)`}
                        style={{ flex: 1, minWidth: 0 }}
                      />
                    )}
                    {b.workUnit === 'reps' && (
                      <button
                        type="button"
                        className={`pl-chip${st.amrap ? ' pl-chip-active' : ''}`}
                        style={{ cursor: 'pointer', flex: 'none' }}
                        aria-pressed={st.amrap}
                        title="Max-effort set — as many reps as possible"
                        onClick={() => updateStrengthSet(bi, si, { amrap: !st.amrap })}
                      >
                        MAX
                      </button>
                    )}
                    {!isDistance && showLoadForUnit(b.workUnit) && (
                      <input
                        className="pl-input"
                        type="number"
                        value={st.loadKg}
                        onChange={(e) => updateStrengthSet(bi, si, { loadKg: e.target.value })}
                        placeholder={unit}
                        aria-label={`Set ${si + 1} load in ${unit}`}
                        style={{ flex: 1, minWidth: 0 }}
                      />
                    )}
                    {!isDistance && (
                      <input
                        className="pl-input"
                        type="number"
                        step={0.5}
                        min={1}
                        max={10}
                        value={st.rpe}
                        onChange={(e) => updateStrengthSet(bi, si, { rpe: e.target.value })}
                        placeholder="RPE"
                        aria-label={`Set ${si + 1} target RPE`}
                        style={{ width: 64, flex: 'none' }}
                      />
                    )}
                    {isDistance && (
                      <div
                        style={{
                          flexBasis: '100%',
                          display: 'flex',
                          gap: 6,
                          alignItems: 'center',
                          paddingLeft: 28,
                        }}
                      >
                        <input
                          className="pl-input"
                          type="number"
                          step={0.5}
                          min={0}
                          max={100}
                          value={st.inclinePct ?? ''}
                          onChange={(e) => updateStrengthSet(bi, si, { inclinePct: e.target.value })}
                          placeholder="incl %"
                          aria-label={`Set ${si + 1} incline percent`}
                          style={{ flex: 1, minWidth: 72 }}
                        />
                        <input
                          className="pl-input"
                          type="number"
                          value={st.loadKg}
                          onChange={(e) => updateStrengthSet(bi, si, { loadKg: e.target.value })}
                          placeholder={`load ${unit}`}
                          aria-label={`Set ${si + 1} load in ${unit}`}
                          style={{ flex: 1, minWidth: 72 }}
                        />
                        <input
                          className="pl-input"
                          type="number"
                          step={0.5}
                          min={1}
                          max={10}
                          value={st.rpe}
                          onChange={(e) => updateStrengthSet(bi, si, { rpe: e.target.value })}
                          placeholder="RPE"
                          aria-label={`Set ${si + 1} target RPE`}
                          style={{ flex: 1, minWidth: 72 }}
                        />
                      </div>
                    )}
                  </SwipeActions>
                )
              })}
              <div className="btn-row">
                <button
                  type="button"
                  className="fit-startbtn ghost"
                  onClick={() => addStrengthSet(bi)}
                  style={{ padding: 8 }}
                >
                  + Add set
                </button>
                {b.sets.length > 1 && (
                  <button
                    type="button"
                    className="fit-startbtn ghost"
                    onClick={() =>
                      setStrengthState((s) =>
                        s
                          ? {
                              ...s,
                              blocks: s.blocks.map((blk, idx) => (idx === bi ? applyFirstSetToAll(blk) : blk)),
                            }
                          : s,
                      )
                    }
                    style={{ padding: 8 }}
                  >
                    Apply set 1 to all
                  </button>
                )}
              </div>
              {/* Rest between sets is meaningless for a continuous
                  running effort — hidden for distance blocks. */}
              {showRestForBlock(b.workUnit) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span className="cmp-label" style={{ margin: 0 }}>
                    {/* Inside a bracket, restS fires between interleaved
                        passes (A2 → rest → A1), not between back-to-back
                        sets — the label follows the semantics. */}
                    {inBracket ? 'REST BETWEEN ROUNDS' : 'REST BETWEEN SETS'}
                  </span>
                  <MmssInput
                    value={b.restS}
                    onCommit={(v) => updateStrengthBlock(bi, { restS: v })}
                    maxS={600}
                    placeholder={formatMmss(defaultRestS)}
                    style={{ width: 90 }}
                    aria-label={inBracket ? 'Rest between rounds (mm:ss)' : 'Rest between sets (mm:ss)'}
                  />
                  {strengthState.blocks.length > 1 && b.restS && (
                    <button
                      type="button"
                      className="pl-chip"
                      style={{ cursor: 'pointer' }}
                      onClick={() => setStrengthState((s) => (s ? applyRestToAllBlocks(s, b.restS) : s))}
                    >
                      Apply to all exercises
                    </button>
                  )}
                </div>
              )}
              {(bi > 0 || inBracket) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {bi > 0 && (
                    <button
                      type="button"
                      className={`pl-chip${linkedWithPrev ? ' pl-chip-active' : ''}`}
                      style={{ cursor: 'pointer' }}
                      aria-pressed={linkedWithPrev}
                      title="Superset: interleave this exercise's sets with the one above (A1 → A2)"
                      onClick={() => setStrengthState((s) => (s ? toggleSupersetWithPrevious(s, bi) : s))}
                    >
                      ⛓ Superset with previous
                    </button>
                  )}
                  {/* Rest inputs follow the same distance-block hiding
                      convention as REST BETWEEN SETS above. */}
                  {inBracket && !lastInBracket && showRestForBlock(b.workUnit) && (
                    <>
                      <span className="cmp-label" style={{ margin: 0 }}>
                        REST TO NEXT EXERCISE
                      </span>
                      <MmssInput
                        value={b.intraRestS ?? ''}
                        onCommit={(v) => updateStrengthBlock(bi, { intraRestS: v })}
                        maxS={600}
                        placeholder="none"
                        style={{ width: 90 }}
                        aria-label="Rest before the next superset exercise (mm:ss)"
                      />
                    </>
                  )}
                  {lastInBracket && showRestForBlock(b.workUnit) && (
                    <>
                      <span className="cmp-label" style={{ margin: 0 }}>
                        REST AFTER SUPERSET
                      </span>
                      <MmssInput
                        value={b.restAfterS ?? ''}
                        onCommit={(v) => updateStrengthBlock(bi, { restAfterS: v })}
                        maxS={600}
                        placeholder={formatMmss(defaultRestS)}
                        style={{ width: 90 }}
                        aria-label="Rest after the superset (mm:ss)"
                      />
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}
        <button type="button" className="fit-startbtn ghost" onClick={addStrengthBlock} style={{ padding: 10 }}>
          + Add exercise
        </button>
      </section>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="cmp-label">NOTES</span>
        <textarea
          className="pl-input"
          value={strengthState.notes}
          onChange={(e) => setStrengthState((s) => (s ? { ...s, notes: e.target.value } : s))}
          placeholder="Optional coach note."
          rows={3}
          style={{ fontSize: 14, resize: 'vertical' }}
        />
      </label>

      <ScheduleChips value={schedule} onChange={chooseSchedule} />

      <div className="btn-row" style={{ marginTop: 6 }}>
        <button type="button" className="fit-startbtn ghost" onClick={() => nav(-1)} disabled={saving}>
          Cancel
        </button>
        {editId ? (
          <button
            type="button"
            className="fit-startbtn"
            onClick={() => handleStrengthSave({ andStart: false })}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="fit-startbtn ghost"
              onClick={() => handleStrengthSave({ andStart: false })}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save to library'}
            </button>
            <button
              type="button"
              className="fit-startbtn ghost"
              onClick={() => handleStrengthSave({ andStart: true })}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save & start'}
            </button>
            <button
              type="button"
              className="fit-startbtn"
              onClick={() => handleStartNow({ force: false })}
              disabled={saving}
            >
              Start now
            </button>
          </>
        )}
      </div>
    </>
  )
}
