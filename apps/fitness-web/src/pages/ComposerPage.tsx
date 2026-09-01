// /composer — workout builder per the Ink design handoff. Wired to
// the existing `wod_templates` API so the saved row immediately
// shows up in the Library and the Plan tab's saved-workouts shelf.
// Photo OCR import lives in S9 (lands as a sibling card above the
// form). Strength sessions are deferred until the wod_templates.kind
// expand makes templates polymorphic.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Banner, ConfirmDialog } from '@rallypoint/ui'
import { sessionFromStrengthBody, strengthSessionReducer } from '@rallypoint/fitness-shared'
import type { ExerciseDto } from '@rallypoint/fitness-shared'
import {
  ApiError,
  createWodTemplate,
  exercisesQuery,
  getWodTemplate,
  patchWodTemplate,
  sendAiFeedback,
} from '../lib/api.js'
import { useCachedQuery } from '../lib/offline/use-cached-query.js'
import {
  emptyComposerState,
  emptyMovementRow,
  emptyStrengthBlockRow,
  emptyStrengthComposerState,
  emptyStrengthSetRow,
  applyScanToState,
  renumberGroups,
  stateFromStrengthTemplate,
  validateForSave,
  validateStrengthForSave,
  validateStrengthForStart,
  type ComposerMovementRow,
  type ComposerState,
  type ComposerStrengthState,
} from '../lib/composer-state.js'
import { buildExerciseNameMap } from '../lib/exercise-label.js'
import { resolveExerciseIds, withResolvedId } from '../lib/exercise-resolve.js'
import { addToActivePlan } from '../lib/plan-add.js'
import {
  applyPlacementChange,
  loadPlacementForTemplate,
  planScheduleAction,
  type ScheduledPlacement,
} from '../lib/plan-schedule.js'
import { takePendingPhoto } from '../lib/pending-photo.js'
import { AddExerciseSheet } from '../ui/AddExerciseSheet.js'
import { ComposerStrengthEditor } from '../ui/ComposerStrengthEditor.js'
import { ComposerWodEditor } from '../ui/ComposerWodEditor.js'
import type { ScanWodResponse } from '../lib/api.js'
import { useWeightUnit } from '../lib/units.js'
import { useDefaultRestS } from '../lib/rest-settings.js'
import {
  newLiveSessionId,
  peekResumableStrengthSession,
  writeStrengthSession,
} from '../lib/live-session-keys.js'
import { scheduleToDayKey, stateFromTemplate, type ScheduleChoice } from '../lib/composer-template.js'

export function ComposerPage() {
  const nav = useNavigate()
  const params = useParams<{ id?: string }>()
  const editId = params.id ?? null
  const unit = useWeightUnit()
  const defaultRestS = useDefaultRestS()
  // The edit-mode hydration effect below only wants to read `unit` at the
  // moment the template fetch resolves, not re-run the fetch whenever the
  // user flips their display unit mid-edit (that would re-hydrate from the
  // server and clobber in-progress edits). A ref keeps the reader fresh
  // without adding `unit` to the effect's deps.
  const unitRef = useRef(unit)
  unitRef.current = unit

  const [state, setState] = useState<ComposerState>(emptyComposerState())
  // Which editor is showing: the WOD form or the standard/strength
  // block editor. Create mode exposes a toggle; edit mode pins the
  // mode to the loaded template's kind. Both drafts stay mounted in
  // state so flipping the toggle doesn't wipe half-typed work.
  // `?mode=strength` (the "free strength" entry point since the ad-hoc
  // picker merged into this builder) opens pinned to the block editor.
  const [searchParams] = useSearchParams()
  const initialStrength = searchParams.get('mode') === 'strength' && !editId
  const [mode, setMode] = useState<'wod' | 'strength'>(initialStrength ? 'strength' : 'wod')
  const [strengthState, setStrengthState] = useState<ComposerStrengthState | null>(
    initialStrength ? emptyStrengthComposerState() : null,
  )
  // "Start now" found a live strength session already in the slot —
  // confirm the overwrite before clobbering it.
  const [confirmStartOver, setConfirmStartOver] = useState(false)
  // A whiteboard photo picked on another tab's FAB, handed to PhotoImport
  // to read on mount. Claimed into a ref rather than a useState initializer:
  // StrictMode double-invokes the render body (initializers included), and
  // the slot is take-once, so the second call would come back empty. A ref
  // survives the double render on the same fiber.
  const pendingBoard = useRef<File | null | undefined>(undefined)
  if (pendingBoard.current === undefined) pendingBoard.current = takePendingPhoto('board')
  const [loadingTemplate, setLoadingTemplate] = useState<boolean>(editId !== null)
  // Exercise catalog shared by every movement row's picker. Render-from-
  // cache: paints the last-known catalog instantly and re-renders on
  // every cache write — including the local-first createExercise below
  // — so no manual catalog mirroring is needed. A cold-miss/failed fetch
  // degrades to an empty catalog; free-text movements still work via the
  // save-time slug fallback.
  const catalogQ = useCachedQuery(useMemo(() => exercisesQuery(), []))
  const catalog: ExerciseDto[] = catalogQ.data ?? []
  // When set, AddExerciseSheet is open to create a custom exercise for
  // this movement row (WOD mode) or block row (strength mode),
  // prefilled with the typed query.
  const [createFor, setCreateFor] = useState<{
    index: number
    query: string
    mode: 'wod' | 'strength' | 'buyin'
  } | null>(null)

  // Resolve display labels for edit-mode rows once the catalog is in:
  // stored bodies carry exerciseIds, and prettifying custom `fx_` ids
  // by string-munging loses the original name.
  useEffect(() => {
    if (catalog.length === 0) return
    const byId = buildExerciseNameMap(catalog)
    setState((s) => {
      let changed = false
      const movements = s.movements.map((m) => {
        if (!m.exerciseId) return m
        const catalogName = byId.get(m.exerciseId)
        if (!catalogName || catalogName === m.name) return m
        changed = true
        return { ...m, name: catalogName }
      })
      // The buy-in is a sibling field, not a movement row, so it needs
      // its own reconcile — without it an edited for_time WOD showed the
      // placeholder in the buy-in field permanently, not just on load.
      let buyInName = s.buyInName
      if (s.buyInExerciseId) {
        const catalogName = byId.get(s.buyInExerciseId)
        if (catalogName && catalogName !== buyInName) {
          buyInName = catalogName
          changed = true
        }
      }
      return changed ? { ...s, movements, buyInName } : s
    })
  }, [catalog, loadingTemplate])
  // `dead` covers the cases where the composer form should not render
  // even though loading is done: the loaded template has an unknown
  // kind (neither wod nor strength), or the template fetch 404ed.
  // Both render the error banner + a back link, nothing else.
  const [dead, setDead] = useState<boolean>(false)

  // Edit mode: hydrate state from the existing template on mount —
  // WOD kinds fill the WOD form, strength kinds the block editor.
  // Bail with a banner + back link for 404 / unknown kind.
  useEffect(() => {
    if (!editId) return
    let cancelled = false
    getWodTemplate(editId)
      .then((tpl) => {
        if (cancelled) return
        if (tpl.kind === 'strength') {
          // Strength templates get the block editor instead of the WOD
          // form — same page, different mode.
          setStrengthState(
            stateFromStrengthTemplate(
              {
                name: tpl.name,
                body: tpl.body,
                description: tpl.description,
              },
              unitRef.current,
            ),
          )
          setMode('strength')
          setLoadingTemplate(false)
          return
        }
        if (tpl.kind !== 'wod') {
          setError('That template kind is not editable here.')
          setLoadingTemplate(false)
          setDead(true)
          return
        }
        setState(
          stateFromTemplate(
            {
              name: tpl.name,
              body: tpl.body,
              description: tpl.description,
              timeCapS: tpl.timeCapS,
            },
            unitRef.current,
          ),
        )
        setLoadingTemplate(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setDead(true)
        setError(
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Could not load that workout.',
        )
        setLoadingTemplate(false)
      })
    return () => {
      cancelled = true
    }
  }, [editId])

  // AI-trace id of the whiteboard scan the composer state came from —
  // saving the composed WOD reports the final shape back as feedback.
  const scanResponseId = useRef<string | null>(null)

  function applyScan(parsed: ScanWodResponse['parsed'], responseId: string | null) {
    scanResponseId.current = responseId
    // The merge itself is pure and lives in composer-state.ts so it can be
    // unit-tested (applyScanToState) — this stays a thin setState wrapper.
    setState((s) => applyScanToState(s, parsed, unit))
  }
  const [schedule, setSchedule] = useState<ScheduleChoice>('none')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)

  // Where this template currently sits in the training plan, when
  // editing. Held in a ref (not state) because only the save path reads
  // it — nothing renders off it, and the chips render off `schedule`.
  const placement = useRef<ScheduledPlacement | null>(null)
  // Set once the user touches a chip, so the hydration below can't
  // overwrite a deliberate pick. The plan read is two sequential round
  // trips (plans, then items) — slower than the template fetch that
  // makes the form interactive — so "user picked a day before the plan
  // came back" is the ordinary case, not a rare race.
  const scheduleTouched = useRef(false)

  function chooseSchedule(next: ScheduleChoice) {
    scheduleTouched.current = true
    setSchedule(next)
  }

  // Edit mode: the SCHEDULE chips can't be hydrated from the template —
  // scheduling lives in a training-plan item pointing at it — so read
  // the plan separately. Without this the chips always opened on "Not
  // scheduled" for a workout that was in fact scheduled, and saving
  // appended a duplicate item instead of moving the existing one.
  // Hydrates to the explicit weekday chip rather than "Today" even when
  // they coincide: "Today" is a shortcut for picking a day, and showing
  // it would make a Monday-scheduled workout read as "Today" on Monday
  // and silently move itself if saved on Tuesday.
  useEffect(() => {
    if (!editId) return
    // Reset per-template: nothing routes composer-to-composer today, but
    // if it ever did, template A's placement and touched-flag would
    // otherwise leak into template B's save.
    placement.current = null
    scheduleTouched.current = false
    let cancelled = false
    loadPlacementForTemplate(editId)
      .then((found) => {
        if (cancelled || !found) return
        // The placement is still recorded even when the user has
        // already picked a day — the save path needs it to move the
        // existing item rather than append a second one.
        placement.current = found
        if (!scheduleTouched.current) setSchedule(found.dayKey)
      })
      .catch(() => {
        // A plan we can't read just means the chips stay on "Not
        // scheduled" — the workout itself still loads and saves.
      })
    return () => {
      cancelled = true
    }
  }, [editId])

  // Reconcile the saved template's place in the plan with the chips.
  // Create mode only ever adds; edit mode diffs against the placement
  // hydrated on load, so re-saving an already-scheduled workout moves
  // it (or unschedules it) instead of appending a second copy.
  // Returns 'skipped' (nothing to do), 'added' (now on the plan),
  // 'changed' (moved or removed), or 'failed' — on failure the save
  // itself still succeeded, so surface a soft error and stay put so the
  // banner is actually visible.
  async function scheduleSavedTemplate(
    templateId: string,
    sourceKind: 'wod_template' | 'strength_template',
  ): Promise<'skipped' | 'added' | 'changed' | 'failed'> {
    const dayKey = scheduleToDayKey(schedule)
    const current = placement.current
    const action = planScheduleAction(current, dayKey)
    if (action === 'skip') return 'skipped'
    try {
      if (action === 'add') {
        // dayKey is non-null whenever the action is 'add'.
        await addToActivePlan(dayKey!, { sourceKind, sourceId: templateId })
        return 'added'
      }
      await applyPlacementChange(current!, dayKey)
      placement.current = dayKey ? { ...current!, dayKey } : null
      return 'changed'
    } catch {
      setError(
        action === 'add'
          ? 'Saved to your library, but could not add it to your plan.'
          : 'Saved to your library, but could not update its place in your plan.',
      )
      return 'failed'
    }
  }

  function updateMovement(i: number, patch: Partial<ComposerMovementRow>) {
    setState((s) => ({
      ...s,
      movements: s.movements.map((m, idx) => (i === idx ? { ...m, ...patch } : m)),
    }))
  }

  const addMovement = useCallback(() => {
    setState((s) => ({ ...s, movements: [...s.movements, emptyMovementRow()] }))
  }, [])

  function removeMovement(i: number) {
    setState((s) => ({
      ...s,
      movements: s.movements.length > 1 ? s.movements.filter((_, idx) => idx !== i) : s.movements,
    }))
  }

  // ── Strength-mode handlers ──────────────────────────────────────────

  function updateStrengthBlock(
    i: number,
    patch: Partial<
      Pick<
        NonNullable<ComposerStrengthState['blocks'][number]>,
        'name' | 'exerciseId' | 'restS' | 'restAfterS' | 'intraRestS' | 'workUnit' | 'distanceUnit'
      >
    >,
  ) {
    setStrengthState((s) =>
      s
        ? { ...s, blocks: s.blocks.map((b, idx) => (i === idx ? { ...b, ...patch } : b)) }
        : s,
    )
  }

  function updateStrengthSet(
    blockIdx: number,
    setIdx: number,
    patch: Partial<{
      reps: string
      loadKg: string
      timeS: string
      inclinePct: string
      amrap: boolean
      rpe: string
    }>,
  ) {
    setStrengthState((s) =>
      s
        ? {
            ...s,
            blocks: s.blocks.map((b, bi) =>
              bi === blockIdx
                ? { ...b, sets: b.sets.map((st, si) => (si === setIdx ? { ...st, ...patch } : st)) }
                : b,
            ),
          }
        : s,
    )
  }

  function addStrengthSet(blockIdx: number) {
    setStrengthState((s) =>
      s
        ? {
            ...s,
            blocks: s.blocks.map((b, bi) =>
              bi === blockIdx ? { ...b, sets: [...b.sets, emptyStrengthSetRow()] } : b,
            ),
          }
        : s,
    )
  }

  function removeStrengthSet(blockIdx: number, setIdx: number) {
    setStrengthState((s) =>
      s
        ? {
            ...s,
            blocks: s.blocks.map((b, bi) =>
              bi === blockIdx && b.sets.length > 1
                ? { ...b, sets: b.sets.filter((_, si) => si !== setIdx) }
                : b,
            ),
          }
        : s,
    )
  }

  function addStrengthBlock() {
    setStrengthState((s) =>
      s ? { ...s, blocks: [...s.blocks, emptyStrengthBlockRow()] } : s,
    )
  }

  function removeStrengthBlock(blockIdx: number) {
    // renumberGroups keeps superset brackets consecutive (and dissolves
    // brackets reduced to one member) after the deletion.
    setStrengthState((s) =>
      s && s.blocks.length > 1
        ? { ...s, blocks: renumberGroups(s.blocks.filter((_, bi) => bi !== blockIdx)) }
        : s,
    )
  }

  async function handleStrengthSave({ andStart }: { andStart: boolean }) {
    if (!strengthState) return
    setError(null)
    setFieldError(null)
    setSaving(true)
    let v: ReturnType<typeof validateStrengthForSave>
    try {
      // Free-typed exercise names get REAL catalog ids (match or create)
      // before validation — never a synthesized fx_seed_ id that later
      // 404s on machine settings / workout saves.
      const resolved = await resolveExerciseIds(strengthState.blocks, catalog)
      v = validateStrengthForSave(
        {
          ...strengthState,
          blocks: strengthState.blocks.map((b) => withResolvedId(b, resolved)),
        },
        unit,
      )
    } catch (err: unknown) {
      setSaving(false)
      setError(err instanceof Error ? err.message : 'Could not save that workout.')
      return
    }
    if (!v.ok) {
      setSaving(false)
      setFieldError(v.message)
      return
    }
    try {
      // Edit mode PATCHes (strength bodies are replaceable, unlike WOD
      // bodies); create mode POSTs a new strength-kind template.
      const res = editId
        ? await patchWodTemplate(editId, {
            name: v.payload.name,
            ...(v.payload.description !== undefined
              ? { description: v.payload.description }
              : {}),
            body: v.payload.body,
          })
        : await createWodTemplate(v.payload)
      const scheduled = await scheduleSavedTemplate(res.id, 'strength_template')
      if (scheduled === 'failed') return
      if (andStart) {
        // fresh=1: the template body is what the athlete JUST typed,
        // not a stale snapshot — the live page must not arm the
        // history-prefill override for it (StrengthSessionPage). A
        // query param so the marker survives a reload mid-hydration.
        nav(`/live/strength/new?templateId=${encodeURIComponent(res.id)}&fresh=1`)
      } else {
        // Land wherever the workout now lives: the plan if it's on a
        // day, the library if it isn't.
        nav(scheduleToDayKey(schedule) ? '/plan' : '/library/wods')
      }
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not save that workout.',
      )
    } finally {
      setSaving(false)
    }
  }

  // "Start now": run the built workout as a live session WITHOUT saving
  // a template. The session state is seeded, STARTed, and written to
  // the live page's localStorage slot synchronously — the live page
  // restores from that slot on mount, which also makes the handoff
  // survive a refresh (and ResumeSessionPill work) for free.
  async function handleStartNow({ force }: { force: boolean }) {
    if (!strengthState) return
    setError(null)
    setFieldError(null)
    let v: ReturnType<typeof validateStrengthForStart>
    try {
      // Same real-id resolution as the save path — a session started from
      // free-typed names must not carry synthetic exercise ids into the
      // live page (machine settings / the final workout save 404 on them).
      const resolved = await resolveExerciseIds(strengthState.blocks, catalog)
      v = validateStrengthForStart(
        {
          ...strengthState,
          blocks: strengthState.blocks.map((b) => withResolvedId(b, resolved)),
        },
        unit,
      )
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not start the session.')
      return
    }
    if (!v.ok) {
      setFieldError(v.message)
      return
    }
    if (!force) {
      // Staleness-aware peek (shared with the live page's hydration):
      // a days-old abandoned session the live page would discard must
      // not trigger the overwrite confirm.
      const existing = peekResumableStrengthSession(Date.now())
      if (existing && existing.phase === 'running') {
        setConfirmStartOver(true)
        return
      }
    }
    const fresh = sessionFromStrengthBody({
      sessionId: newLiveSessionId(),
      templateName: v.name,
      body: v.body,
      defaultRestS,
    })
    const running = strengthSessionReducer(fresh, { kind: 'START', nowMs: Date.now() })
    if (!writeStrengthSession(running)) {
      setError('Could not start the session (storage unavailable).')
      return
    }
    nav('/live/strength/new')
  }

  async function handleSave({ andStart }: { andStart: boolean }) {
    setError(null)
    setFieldError(null)
    setSaving(true)
    let v: ReturnType<typeof validateForSave>
    try {
      // Resolve free-typed movement (and buy-in) names to real catalog
      // ids — match or create — so the saved template never carries a
      // synthesized fx_seed_ id (see exercise-resolve.ts).
      const resolved = await resolveExerciseIds(
        [
          ...state.movements,
          { name: state.buyInName, exerciseId: state.buyInExerciseId },
        ],
        catalog,
      )
      const buyInResolved = withResolvedId(
        { name: state.buyInName, exerciseId: state.buyInExerciseId },
        resolved,
      )
      v = validateForSave(
        {
          ...state,
          movements: state.movements.map((m) => withResolvedId(m, resolved)),
          buyInExerciseId: buyInResolved.exerciseId,
        },
        unit,
      )
    } catch (err: unknown) {
      setSaving(false)
      setError(err instanceof Error ? err.message : 'Could not save that workout.')
      return
    }
    if (!v.ok) {
      setSaving(false)
      setFieldError(v.message)
      return
    }
    try {
      // Edit mode PATCHes the existing template; create mode POSTs a
      // new one. PATCH only supports name / description / timeCapS
      // changes per the shared schema (body + wodType are effectively
      // immutable so existing logged results don't get out of sync).
      const res = editId
        ? await patchWodTemplate(editId, {
            name: v.payload.name,
            ...(v.payload.description !== undefined
              ? { description: v.payload.description }
              : {}),
            ...(v.payload.timeCapS !== undefined ? { timeCapS: v.payload.timeCapS } : {}),
          })
        : await createWodTemplate(v.payload)
      // Close the AI-trace loop: the saved payload IS the ground truth
      // for what the whiteboard scan should have produced.
      if (scanResponseId.current) {
        void sendAiFeedback(scanResponseId.current, 'edited', v.payload)
        scanResponseId.current = null
      }
      // If a day was picked, also insert a plan-item row so the workout
      // shows up in /plan (resolving/bootstrapping the active plan —
      // first-time users no longer silently skip scheduling).
      const scheduled = await scheduleSavedTemplate(res.id, 'wod_template')
      if (scheduled === 'failed') return
      if (andStart) {
        nav(`/live/wod/${encodeURIComponent(res.id)}/run`)
      } else {
        // Land wherever the workout now lives: the plan if it's on a
        // day, the library if it isn't.
        nav(scheduleToDayKey(schedule) ? '/plan' : '/library/wods')
      }
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not save that workout.',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page-pad">
      <header className="fit-head">
        <div className="top">
          <div>
            <div className="eyebrow">COMPOSE</div>
            <h1>{editId ? 'Edit workout' : 'New workout'}</h1>
          </div>
        </div>
        <p className="sub">
          {mode === 'strength' && strengthState
            ? editId
              ? 'Edit the exercises, set targets, and loads of this strength template.'
              : 'Build a standard workout — exercises, sets, loads, and rest — then save it or schedule it.'
            : editId
              ? 'Tweak the name, time cap, or notes. Movement structure is locked once a template has results.'
              : 'Build a WOD or scan a whiteboard, then save it to your library.'}
        </p>
      </header>

      {loadingTemplate && (
        <div style={{ color: 'var(--ink-dim)' }}>Loading workout…</div>
      )}

      {error && <Banner tone="error">{error}</Banner>}

      {/* Create-mode editor toggle: a classic WOD vs a standard
          sets×reps workout. Edit mode pins the editor to the loaded
          template's kind, so the toggle hides there. Both drafts stay
          in state — flipping back doesn't lose typed work. */}
      {!dead && !editId && !loadingTemplate && (
        <section style={{ display: 'grid', gap: 6 }}>
          <span className="cmp-label">WORKOUT STYLE</span>
          <div className="fit-seg" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'wod'}
              className={mode === 'wod' ? 'on' : ''}
              onClick={() => setMode('wod')}
            >
              WOD
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'strength'}
              className={mode === 'strength' ? 'on' : ''}
              onClick={() => {
                setStrengthState((s) => s ?? emptyStrengthComposerState())
                setMode('strength')
              }}
            >
              Standard
            </button>
          </div>
        </section>
      )}

      {/* When the page is dead (unknown template kind, or the
          template fetch failed) bail with just the back link — the
          composer form and Save buttons must not render because a
          Save click would PATCH the empty default state onto the
          target row (code-review F12). */}
      {dead ? (
        <button
          type="button"
          className="fit-startbtn ghost"
          onClick={() => nav('/library/wods')}
          style={{ width: 'fit-content' }}
        >
          ← Back to WOD library
        </button>
      ) : mode === 'strength' && strengthState ? (
        <ComposerStrengthEditor
          strengthState={strengthState}
          catalog={catalog}
          unit={unit}
          defaultRestS={defaultRestS}
          schedule={schedule}
          chooseSchedule={chooseSchedule}
          saving={saving}
          editId={editId}
          fieldError={fieldError}
          nav={nav}
          setStrengthState={setStrengthState}
          setCreateFor={setCreateFor}
          updateStrengthBlock={updateStrengthBlock}
          updateStrengthSet={updateStrengthSet}
          addStrengthSet={addStrengthSet}
          removeStrengthSet={removeStrengthSet}
          addStrengthBlock={addStrengthBlock}
          removeStrengthBlock={removeStrengthBlock}
          handleStrengthSave={handleStrengthSave}
          handleStartNow={handleStartNow}
        />
      ) : (
        <ComposerWodEditor
          state={state}
          setState={setState}
          catalog={catalog}
          unit={unit}
          schedule={schedule}
          chooseSchedule={chooseSchedule}
          saving={saving}
          fieldError={fieldError}
          nav={nav}
          pendingBoard={pendingBoard}
          applyScan={applyScan}
          setCreateFor={setCreateFor}
          updateMovement={updateMovement}
          removeMovement={removeMovement}
          addMovement={addMovement}
          handleSave={handleSave}
        />
      )}

      {confirmStartOver && (
        <ConfirmDialog
          open
          title="Replace your session in progress?"
          body="A live strength session is already running. Starting this workout will discard that session's progress."
          confirmLabel="Start new session"
          confirmVariant="hot"
          onCancel={() => setConfirmStartOver(false)}
          onConfirm={() => {
            setConfirmStartOver(false)
            handleStartNow({ force: true })
          }}
        />
      )}

      {createFor && (
        <AddExerciseSheet
          initialName={createFor.query}
          onClose={() => setCreateFor(null)}
          onCreated={(exercise) => {
            // createExercise is local-first — the exercises cache is
            // already patched and subscribers notified, so `catalog`
            // picks up the new row on its own; just wire the picked
            // exercise into the row being edited.
            if (createFor.mode === 'strength') {
              updateStrengthBlock(createFor.index, {
                name: exercise.name,
                exerciseId: exercise.id,
              })
            } else if (createFor.mode === 'buyin') {
              setState((s) => ({
                ...s,
                buyInName: exercise.name,
                buyInExerciseId: exercise.id,
              }))
            } else {
              updateMovement(createFor.index, {
                name: exercise.name,
                exerciseId: exercise.id,
              })
            }
          }}
        />
      )}
    </div>
  )
}
