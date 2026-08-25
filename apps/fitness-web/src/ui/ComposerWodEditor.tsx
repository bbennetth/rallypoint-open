// WOD-mode editor JSX for ComposerPage — extracted as a move-only split.
// All state, effects, and save handlers stay in ComposerPage; this
// component (and its local, unexported subcomponents) only render the
// WOD form for the current `state` and report edits back through the
// handlers passed in as props.

import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import { Banner, Icon, SwipeActions } from '@rallypoint/ui'
import { WOD_TYPES } from '@rallypoint/fitness-shared'
import type { ExerciseDto, WodType } from '@rallypoint/fitness-shared'
import {
  defaultWorkUnitForShape,
  switchType,
  unitSwitchable,
  WORK_UNITS,
  type ComposerMovementRow,
  type ComposerState,
} from '../lib/composer-state.js'
import {
  TYPE_LABELS,
  WORK_UNIT_LABELS,
  WORK_UNIT_PLACEHOLDER,
  type ScheduleChoice,
} from '../lib/composer-template.js'
import type { ScanWodResponse } from '../lib/api.js'
import { ExercisePicker } from './ExercisePicker.js'
import { MmssInput } from './MmssInput.js'
import { PhotoImport } from './PhotoImport.js'
import { ScheduleChips } from './ScheduleChips.js'
import type { WeightUnit } from '../lib/units.js'

// Type selector — the top row of WOD-type tabs.
function TypeSelector({
  wodType,
  setState,
}: {
  wodType: WodType
  setState: Dispatch<SetStateAction<ComposerState>>
}) {
  return (
    <section style={{ display: 'grid', gap: 6 }}>
      <span className="cmp-label">TYPE</span>
      <div className="fit-seg" role="tablist">
        {WOD_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={wodType === t}
            className={wodType === t ? 'on' : ''}
            onClick={() => setState((s) => switchType(s, t))}
          >
            {TYPE_LABELS[t]}
          </button>
        ))}
      </div>
    </section>
  )
}

// Type-dependent config — the fields specific to the selected WOD type
// (rep scheme, time cap, rounds, interval timing, etc).
function TypeConfig({
  state,
  setState,
}: {
  state: ComposerState
  setState: Dispatch<SetStateAction<ComposerState>>
}) {
  return (
    <section className="cmp-grid">
      {state.wodType === 'for_time' && (
        <>
          {!state.ladderCumulative && (
            <label className="cmp-field">
              <span className="cmp-label">REP SCHEME</span>
              <input
                className="pl-input"
                value={state.scheme}
                onChange={(e) => setState((s) => ({ ...s, scheme: e.target.value }))}
                placeholder="21-15-9"
                style={{ fontSize: 16 }}
              />
            </label>
          )}
          <label className="cmp-field">
            <span className="cmp-label">TIME CAP (MIN)</span>
            <input
              className="pl-input"
              type="number"
              value={state.capMin}
              onChange={(e) => setState((s) => ({ ...s, capMin: e.target.value }))}
              placeholder="8"
              style={{ fontSize: 16 }}
            />
          </label>
          <label
            className="cmp-field"
            style={{
              gridColumn: '1 / -1',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <input
              type="checkbox"
              checked={state.ladderCumulative}
              onChange={(e) => setState((s) => ({ ...s, ladderCumulative: e.target.checked }))}
            />
            <span className="cmp-label" style={{ margin: 0 }}>
              CUMULATIVE LADDER — round n adds movement n (12-Days style)
            </span>
          </label>
        </>
      )}
      {state.wodType === 'rounds_for_time' && (
        <>
          <label className="cmp-field">
            <span className="cmp-label">ROUNDS</span>
            <input
              className="pl-input"
              type="number"
              value={state.rounds}
              onChange={(e) => setState((s) => ({ ...s, rounds: e.target.value }))}
              placeholder="3"
              style={{ fontSize: 16 }}
            />
          </label>
          <label className="cmp-field">
            <span className="cmp-label">TIME CAP (MIN)</span>
            <input
              className="pl-input"
              type="number"
              value={state.capMin}
              onChange={(e) => setState((s) => ({ ...s, capMin: e.target.value }))}
              placeholder="optional"
              style={{ fontSize: 16 }}
            />
          </label>
          <label className="cmp-field">
            <span className="cmp-label">REST BETWEEN ROUNDS</span>
            <MmssInput
              value={state.restS}
              onCommit={(v) => setState((s) => ({ ...s, restS: v }))}
              maxS={1800}
              placeholder="optional — Barbara is 3:00"
              style={{ fontSize: 16 }}
            />
          </label>
        </>
      )}
      {state.wodType === 'amrap' && (
        <label className="cmp-field" style={{ gridColumn: '1 / -1' }}>
          <span className="cmp-label">WINDOW (MIN)</span>
          <input
            className="pl-input"
            type="number"
            value={state.durationMin}
            onChange={(e) => setState((s) => ({ ...s, durationMin: e.target.value }))}
            placeholder="20"
            style={{ fontSize: 16 }}
          />
        </label>
      )}
      {state.wodType === 'emom' && (
        <>
          <label className="cmp-field">
            <span className="cmp-label">INTERVAL (MM:SS)</span>
            <MmssInput
              valueAsSeconds
              value={state.intervalS}
              onCommit={(v) => setState((s) => ({ ...s, intervalS: v }))}
              maxS={1800}
              placeholder="1:00"
              style={{ fontSize: 16 }}
            />
          </label>
          <label className="cmp-field">
            <span className="cmp-label">INTERVALS</span>
            <input
              className="pl-input"
              type="number"
              value={state.totalIntervals}
              onChange={(e) => setState((s) => ({ ...s, totalIntervals: e.target.value }))}
              placeholder="10"
              style={{ fontSize: 16 }}
            />
          </label>
        </>
      )}
      {state.wodType === 'interval' && (
        <>
          <label className="cmp-field">
            <span className="cmp-label">ROUNDS</span>
            <input
              className="pl-input"
              type="number"
              value={state.rounds}
              onChange={(e) => setState((s) => ({ ...s, rounds: e.target.value }))}
              placeholder="3"
              style={{ fontSize: 16 }}
            />
          </label>
          <label className="cmp-field">
            <span className="cmp-label">WORK / STATION (MM:SS)</span>
            <MmssInput
              valueAsSeconds
              value={state.workS}
              onCommit={(v) => setState((s) => ({ ...s, workS: v }))}
              maxS={1800}
              placeholder="1:00"
              style={{ fontSize: 16 }}
            />
          </label>
          <label className="cmp-field">
            <span className="cmp-label">REST BETWEEN ROUNDS</span>
            <MmssInput
              value={state.restS}
              onCommit={(v) => setState((s) => ({ ...s, restS: v }))}
              maxS={1800}
              placeholder="optional — FGB is 1:00"
              style={{ fontSize: 16 }}
            />
          </label>
        </>
      )}
      {state.wodType === 'max_reps_rounds' && (
        <>
          <label className="cmp-field">
            <span className="cmp-label">ROUNDS</span>
            <input
              className="pl-input"
              type="number"
              value={state.rounds}
              onChange={(e) => setState((s) => ({ ...s, rounds: e.target.value }))}
              placeholder="5"
              style={{ fontSize: 16 }}
            />
          </label>
          <label className="cmp-field">
            <span className="cmp-label">TIME CAP (MIN)</span>
            <input
              className="pl-input"
              type="number"
              value={state.durationMin}
              onChange={(e) => setState((s) => ({ ...s, durationMin: e.target.value }))}
              placeholder="optional — untimed if blank"
              style={{ fontSize: 16 }}
            />
          </label>
        </>
      )}
    </section>
  )
}

// Per-minute buy-in (for_time only, Kalsu-style).
function BuyInSection({
  state,
  setState,
  catalog,
  setCreateFor,
}: {
  state: ComposerState
  setState: Dispatch<SetStateAction<ComposerState>>
  catalog: ExerciseDto[]
  setCreateFor: Dispatch<
    SetStateAction<{ index: number; query: string; mode: 'wod' | 'strength' | 'buyin' } | null>
  >
}) {
  if (state.wodType !== 'for_time') return null
  return (
    <section style={{ display: 'grid', gap: 6 }}>
      <span className="cmp-label">
        PER-MINUTE BUY-IN <span style={{ color: 'var(--ink-mute)' }}>(optional)</span>
      </span>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 6 }}>
        <ExercisePicker
          exercises={catalog}
          value={state.buyInName}
          placeholder="burpee"
          onChange={(next) =>
            setState((s) => ({
              ...s,
              buyInName: next.name,
              buyInExerciseId: next.exerciseId,
            }))
          }
          onCreate={(query) => setCreateFor({ index: -1, query, mode: 'buyin' })}
        />
        <input
          className="pl-input"
          type="number"
          value={state.buyInReps}
          onChange={(e) => setState((s) => ({ ...s, buyInReps: e.target.value }))}
          placeholder="reps / min"
        />
      </div>
    </section>
  )
}

// Movements editor — the per-movement rows (exercise, amount, unit,
// load, and type-specific scoring controls).
function MovementsEditor({
  state,
  catalog,
  unit,
  updateMovement,
  removeMovement,
  addMovement,
  setCreateFor,
}: {
  state: ComposerState
  catalog: ExerciseDto[]
  unit: WeightUnit
  updateMovement: (i: number, patch: Partial<ComposerMovementRow>) => void
  removeMovement: (i: number) => void
  addMovement: () => void
  setCreateFor: Dispatch<
    SetStateAction<{ index: number; query: string; mode: 'wod' | 'strength' | 'buyin' } | null>
  >
}) {
  return (
    <section style={{ display: 'grid', gap: 6 }}>
      <span className="cmp-label">MOVEMENTS</span>
      {state.movements.map((m, i) => (
        // Remove lives in the swipe/hover tray (Soft Ink); the last
        // movement passes empty actions — a WOD needs at least one.
        <SwipeActions
          key={i}
          className="swipe-page"
          actions={
            state.movements.length > 1
              ? [
                  {
                    key: 'delete',
                    label: `Remove movement ${i + 1}`,
                    text: 'Remove',
                    icon: <Icon name="trash" size={14} />,
                    onAction: () => removeMovement(i),
                  },
                ]
              : []
          }
          contentClassName="mv-edit"
        >
          <span className="mv-ix">{i + 1}</span>
          <div className="mv-inputs">
            <ExercisePicker
              exercises={catalog}
              value={m.name}
              placeholder="thruster"
              onChange={(next) => {
                // Picking a catalog exercise resets the prescription unit
                // to that exercise's natural shape (Assault Bike →
                // distance/cal/time, not reps × load). Interval bodies
                // score stations instead of prescribing work, so there the
                // pick defaults the SCORED IN unit (FGB rows for calories)
                // and the amount keeps its target-reps semantics.
                const picked = next.exerciseId
                  ? catalog.find((e) => e.id === next.exerciseId)
                  : undefined
                // Only machine work (distance_time: bikes, ergs) scores
                // in calories — a timed hold (duration: plank) does not.
                const machine = picked?.metricShape === 'distance_time'
                updateMovement(i, {
                  ...next,
                  ...(state.wodType === 'interval'
                    ? { scoreUnit: machine ? ('calories' as const) : ('reps' as const) }
                    : picked
                      ? { workUnit: defaultWorkUnitForShape(picked.metricShape) }
                      : {}),
                })
              }}
              onCreate={(query) => setCreateFor({ index: i, query, mode: 'wod' })}
            />
            {unitSwitchable(m, catalog) ? (
              // Cardio / timed movement: amount + a unit segment; load
              // makes no sense here so the lbs/×BW inputs stay hidden.
              // Interval mode drops the segment too — SCORED IN (below)
              // is the one scoring control there.
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  className="pl-input"
                  type="number"
                  value={m.reps}
                  onChange={(e) => updateMovement(i, { reps: e.target.value })}
                  placeholder={WORK_UNIT_PLACEHOLDER[m.workUnit]}
                  aria-label={`Amount in ${WORK_UNIT_LABELS[m.workUnit]}`}
                  style={{ flex: 1, minWidth: 0 }}
                />
                {state.wodType !== 'interval' && (
                  <div className="fit-seg" role="tablist" style={{ width: 'auto', flex: 'none' }}>
                    {WORK_UNITS.map((u) => (
                      <button
                        key={u}
                        type="button"
                        role="tab"
                        aria-selected={m.workUnit === u}
                        className={m.workUnit === u ? 'on' : ''}
                        onClick={() => updateMovement(i, { workUnit: u })}
                      >
                        {WORK_UNIT_LABELS[u]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              // Strength movement: the classic reps × load row.
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 6 }}>
                <input
                  className="pl-input"
                  type="number"
                  value={m.reps}
                  onChange={(e) => updateMovement(i, { reps: e.target.value })}
                  placeholder="reps"
                />
                {m.loadMode === 'bw' ? (
                  <input
                    className="pl-input"
                    type="number"
                    step="0.05"
                    value={m.loadBwMultiple}
                    onChange={(e) => updateMovement(i, { loadBwMultiple: e.target.value })}
                    placeholder="1.5"
                    aria-label="Load as bodyweight multiple"
                  />
                ) : (
                  <input
                    className="pl-input"
                    type="number"
                    value={m.loadKg}
                    onChange={(e) => updateMovement(i, { loadKg: e.target.value })}
                    placeholder={unit}
                    aria-label={`Load in ${unit}`}
                  />
                )}
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ padding: '0 10px', fontSize: 11 }}
                  onClick={() => updateMovement(i, { loadMode: m.loadMode === 'bw' ? 'kg' : 'bw' })}
                  title="Toggle between an absolute load and a bodyweight multiple"
                >
                  {m.loadMode === 'bw' ? '×BW' : unit}
                </button>
              </div>
            )}
            {state.wodType === 'interval' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="cmp-label" style={{ margin: 0 }}>
                  SCORED IN
                </span>
                <div className="fit-seg" role="tablist" style={{ width: 'auto' }}>
                  {(['reps', 'calories'] as const).map((u) => (
                    <button
                      key={u}
                      type="button"
                      role="tab"
                      aria-selected={m.scoreUnit === u}
                      className={m.scoreUnit === u ? 'on' : ''}
                      onClick={() => updateMovement(i, { scoreUnit: u })}
                    >
                      {u === 'calories' ? 'cal' : 'reps'}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {state.wodType === 'max_reps_rounds' && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={m.scored}
                  onChange={(e) => updateMovement(i, { scored: e.target.checked })}
                />
                <span className="cmp-label" style={{ margin: 0 }}>
                  SCORED — athlete enters max reps
                </span>
              </label>
            )}
          </div>
        </SwipeActions>
      ))}
      <button type="button" className="fit-startbtn ghost" onClick={addMovement} style={{ padding: 10 }}>
        + Add movement
      </button>
    </section>
  )
}

// Notes, schedule chips, and the Cancel/Save/Save & start row.
function Footer({
  state,
  setState,
  schedule,
  chooseSchedule,
  saving,
  nav,
  handleSave,
}: {
  state: ComposerState
  setState: Dispatch<SetStateAction<ComposerState>>
  schedule: ScheduleChoice
  chooseSchedule: (next: ScheduleChoice) => void
  saving: boolean
  nav: NavigateFunction
  handleSave: (args: { andStart: boolean }) => void | Promise<void>
}) {
  return (
    <>
      {/* Notes */}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="cmp-label">NOTES</span>
        <textarea
          className="pl-input"
          value={state.notes}
          onChange={(e) => setState((s) => ({ ...s, notes: e.target.value }))}
          placeholder="Optional coach note or scaling guidance."
          rows={3}
          style={{ fontSize: 14, resize: 'vertical' }}
        />
      </label>

      {/* Schedule */}
      <ScheduleChips value={schedule} onChange={chooseSchedule} />

      <div className="btn-row" style={{ marginTop: 6 }}>
        <button type="button" className="fit-startbtn ghost" onClick={() => nav(-1)} disabled={saving}>
          Cancel
        </button>
        <button
          type="button"
          className="fit-startbtn ghost"
          onClick={() => handleSave({ andStart: false })}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save to library'}
        </button>
        <button
          type="button"
          className="fit-startbtn"
          onClick={() => handleSave({ andStart: true })}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save & start'}
        </button>
      </div>
    </>
  )
}

export function ComposerWodEditor({
  state,
  setState,
  catalog,
  unit,
  schedule,
  chooseSchedule,
  saving,
  fieldError,
  nav,
  pendingBoard,
  applyScan,
  setCreateFor,
  updateMovement,
  removeMovement,
  addMovement,
  handleSave,
}: {
  state: ComposerState
  setState: Dispatch<SetStateAction<ComposerState>>
  catalog: ExerciseDto[]
  unit: WeightUnit
  schedule: ScheduleChoice
  chooseSchedule: (next: ScheduleChoice) => void
  saving: boolean
  fieldError: string | null
  nav: NavigateFunction
  pendingBoard: RefObject<File | null | undefined>
  applyScan: (parsed: ScanWodResponse['parsed'], responseId: string | null) => void
  setCreateFor: Dispatch<
    SetStateAction<{ index: number; query: string; mode: 'wod' | 'strength' | 'buyin' } | null>
  >
  updateMovement: (i: number, patch: Partial<ComposerMovementRow>) => void
  removeMovement: (i: number) => void
  addMovement: () => void
  handleSave: (args: { andStart: boolean }) => void | Promise<void>
}) {
  return (
    <>
      {fieldError && <Banner tone="error">{fieldError}</Banner>}

      {/* Reads once on mount when the global FAB's "Scan a whiteboard"
          sent us here with a photo already picked. */}
      <PhotoImport onParsed={applyScan} initialFile={pendingBoard.current ?? null} />

      <TypeSelector wodType={state.wodType} setState={setState} />

      {/* Name */}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="cmp-label">NAME</span>
        <input
          className="pl-input"
          value={state.name}
          onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
          placeholder="e.g. Hero Murph variant"
          style={{ fontSize: 16 }}
        />
      </label>

      <TypeConfig state={state} setState={setState} />

      <BuyInSection state={state} setState={setState} catalog={catalog} setCreateFor={setCreateFor} />

      <MovementsEditor
        state={state}
        catalog={catalog}
        unit={unit}
        updateMovement={updateMovement}
        removeMovement={removeMovement}
        addMovement={addMovement}
        setCreateFor={setCreateFor}
      />

      <Footer
        state={state}
        setState={setState}
        schedule={schedule}
        chooseSchedule={chooseSchedule}
        saving={saving}
        nav={nav}
        handleSave={handleSave}
      />
    </>
  )
}
