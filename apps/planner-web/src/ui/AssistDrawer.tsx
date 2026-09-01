import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ApiError,
  createDiaryEntry,
  createFitnessFoodLog,
  createNote,
  createPersonalEvent,
  createTaskItem,
  deleteDiaryEntry,
  deleteFitnessFoodLog,
  deleteNote,
  deletePersonalEvent,
  deleteShoppingItem,
  deleteTaskItem,
  getDiaryList,
  listFieldDefs,
  listTaskLists,
  parseAssist,
  sendAssistFeedback,
  type AssistCategory,
  type AssistFoodItem,
  type AssistSuggestion,
} from '../lib/api.js'
import { addShoppingItemByTitle } from '../lib/shopping-helpers.js'
import { findMoodField } from '../lib/diary-helpers.js'
import { instantToLocalInput, localToday, toInstant } from '../lib/planner-helpers.js'
import {
  ASSIST_CATEGORIES,
  ASSIST_CATEGORY_LABELS,
  diaryDueDate,
  editVerdict,
  eventCreateFields,
  foodEditAllowed,
  foodLogEntries,
  foodToastLabel,
  lowConfidenceHint,
  moodChoiceId,
  rescaleFoodItem,
  taskCreateOpts,
  type EditedFields,
} from '../lib/assist-helpers.js'
import { notifyCreated, type CreatedKind } from '../lib/refresh-bus.js'
import { useSpeechInput } from '../lib/use-speech-input.js'
import { Icon } from './icons.js'

// AI Assist quick-capture. The user types or dictates one line ("Dental
// cleaning 3/5/2027 at 9am", "Buy strawberries", "I'm upset because…"); the
// backend categorizes it and returns a structured suggestion; we AUTO-SAVE it
// through the same create helpers the manual forms use, then offer Undo /
// Change for ~6s. Low-confidence suggestions skip the auto-save and open the
// edit card directly; an unparseable reply (422) does the same, seeded with
// the raw text, so the capture is never lost.

const UNDO_WINDOW_MS = 6000
const MOOD_EMOJI = ['😞', '😕', '😐', '🙂', '😄']

type Phase = 'input' | 'saving' | 'saved' | 'edit'

// A committed save + how to reverse it (undo / re-categorize). 'food' saves
// land in the FITNESS diary (cross-app), so they have no planner refresh-bus
// kind — notifyCreated is skipped for them.
interface SavedHandle {
  kind: CreatedKind | 'food'
  undo: () => Promise<void>
}

function notifySaved(handle: SavedHandle): void {
  if (handle.kind !== 'food') notifyCreated(handle.kind)
}

// The saved/undo confirmation line for a suggestion.
function savedLabel(s: AssistSuggestion): string {
  if (s.category === 'food' && s.items?.length) {
    return `Saved to Food diary — ${foodToastLabel(s.items)}`
  }
  return `Saved as ${ASSIST_CATEGORY_LABELS[s.category]}`
}

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

// Dispatch a suggestion to the matching create helper. Returns a handle whose
// undo() reverses exactly that write. Reuses the existing local-first helpers,
// so the save rides the offline outbox and fires notification sync like any
// manual add.
async function saveSuggestion(s: AssistSuggestion): Promise<SavedHandle> {
  switch (s.category) {
    case 'task': {
      const lists = await listTaskLists()
      const listId = lists[0]?.id
      if (!listId) throw new Error('No task list is available yet.')
      const dto = await createTaskItem(listId, s.title, taskCreateOpts(s))
      return { kind: 'task', undo: () => deleteTaskItem(listId, dto.id) }
    }
    case 'shopping': {
      const dto = await addShoppingItemByTitle(s.title)
      return { kind: 'shopping', undo: () => deleteShoppingItem(dto.listId, dto.id) }
    }
    case 'event': {
      const dto = await createPersonalEvent(eventCreateFields(s))
      return { kind: 'event', undo: () => deletePersonalEvent(dto.id) }
    }
    case 'note': {
      const dto = await createNote({ title: s.title, ...(s.notes ? { notes: s.notes } : {}) })
      return { kind: 'note', undo: () => deleteNote(dto.id) }
    }
    case 'food': {
      // One fitness diary row per item, all stamped with the save instant +
      // the assist responseId. On a mid-batch failure, roll back what
      // landed (best-effort) so a retry can't double-log the early items.
      const bodies = foodLogEntries(s.items ?? [], new Date().toISOString(), s.responseId)
      if (bodies.length === 0) throw new Error('Nothing to log from that.')
      const createdIds: string[] = []
      try {
        for (const body of bodies) {
          const dto = await createFitnessFoodLog(body)
          createdIds.push(dto.id)
        }
      } catch (err) {
        await Promise.allSettled(createdIds.map((id) => deleteFitnessFoodLog(id)))
        throw err
      }
      return {
        kind: 'food',
        undo: async () => {
          const results = await Promise.allSettled(
            createdIds.map((id) => deleteFitnessFoodLog(id)),
          )
          const failed = results.find((r) => r.status === 'rejected')
          if (failed) throw failed.reason
        },
      }
    }
    case 'diary': {
      const list = await getDiaryList()
      const defs = await listFieldDefs(list.id)
      const moodField = findMoodField(defs)
      const choiceId = moodChoiceId(moodField, s.mood)
      const dto = await createDiaryEntry(list.id, {
        title: s.title,
        notes: s.notes,
        dueDate: diaryDueDate(s),
        ...(moodField && choiceId ? { customFields: { [moodField.id]: choiceId } } : {}),
      })
      return { kind: 'diary', undo: () => deleteDiaryEntry(list.id, dto.id) }
    }
  }
}

export function AssistDrawer({
  onClose,
  onToast,
}: {
  onClose: () => void
  onToast?: (msg: string) => void
}) {
  const [phase, setPhase] = useState<Phase>('input')
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)

  // The current suggestion + (once auto-saved) its handle.
  const [suggestion, setSuggestion] = useState<AssistSuggestion | null>(null)
  const savedRef = useRef<SavedHandle | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Edit-card state.
  const [cat, setCat] = useState<AssistCategory>('note')
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [when, setWhen] = useState('')
  const [whenTouched, setWhenTouched] = useState(false)
  const [mood, setMood] = useState<number | null>(null)
  const [items, setItems] = useState<AssistFoodItem[]>([])
  // Pristine per-item baseline (index-aligned with `items`), the fixed
  // density every grams edit rescales FROM. Rescaling from the current
  // already-rounded item would compound rounding across keystrokes and can
  // lock a small macro at 0 (0 × factor = 0) — a silent corruption of saved
  // health data. A direct kcal edit resets that item's baseline.
  const [itemBase, setItemBase] = useState<AssistFoodItem[]>([])

  const speech = useSpeechInput((chunk) => setText((t) => (t ? `${t} ${chunk}` : chunk).trim()))

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }
  useEffect(() => () => clearTimer(), [])

  function seedEdit(s: AssistSuggestion) {
    setCat(s.category)
    setTitle(s.title)
    setNotes(s.notes ?? '')
    setMood(s.mood)
    setItems(s.items ?? [])
    setItemBase(s.items ?? [])
    setWhenTouched(false)
    const src = s.category === 'event' ? s.startAt : s.dueDate
    setWhen(src && src.includes('T') ? instantToLocalInput(src) : '')
  }

  // --- food edit-card item handlers ----------------------------------
  // Grams edits rescale macros from the stable per-item baseline, never from
  // the current (already-rounded) item, so multi-keystroke corrections don't
  // compound rounding or lock a small macro at 0.
  function setItemGrams(i: number, grams: number) {
    // Rescale macros from the frozen baseline, but keep the LIVE name (the
    // baseline's name isn't resynced on a plain name edit, so inheriting it
    // would silently revert a just-typed name).
    setItems((prev) =>
      prev.map((p, j) => (j === i ? { ...rescaleFoodItem(itemBase[j] ?? p, grams), name: p.name } : p)),
    )
  }
  // A direct kcal edit establishes a NEW baseline for that item at its
  // current grams, so a later grams edit scales the corrected value. Reads
  // the current grams/macros from `items[j]` — safe because grams and kcal
  // are edited via separate discrete input events, so any prior setItemGrams
  // has already committed to `items` before this fires.
  function setItemKcal(i: number, raw: number) {
    const kcal = Math.max(0, Math.min(20000, Number.isFinite(raw) ? raw : 0))
    setItems((prev) => prev.map((p, j) => (j === i ? { ...p, kcal } : p)))
    setItemBase((prev) => prev.map((b, j) => (j === i ? { ...(items[j] ?? b), kcal } : b)))
  }
  function removeItem(i: number) {
    setItems((prev) => prev.filter((_, j) => j !== i))
    setItemBase((prev) => prev.filter((_, j) => j !== i))
  }
  function addItem() {
    const blank: AssistFoodItem = { name: '', grams: 1, kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 }
    setItems((prev) => [...prev, blank])
    setItemBase((prev) => [...prev, blank])
  }

  async function autoSave(s: AssistSuggestion) {
    setPhase('saving')
    try {
      const handle = await saveSuggestion(s)
      savedRef.current = handle
      notifySaved(handle)
      setPhase('saved')
      clearTimer()
      timerRef.current = setTimeout(() => void finalizeAccepted(), UNDO_WINDOW_MS)
    } catch (err) {
      setError(errMessage(err))
      setPhase('input')
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    // Fold in any not-yet-finalized dictation (it lives only in
    // speech.transcript until the recognizer finalizes it) so tapping submit
    // mid-utterance doesn't drop the last words.
    const t = `${text}${speech.listening && speech.transcript ? ` ${speech.transcript}` : ''}`.trim()
    if (!t || phase === 'saving') return
    if (speech.listening) speech.stop()
    setError(null)
    setHint(null)
    setPhase('saving')
    let s: AssistSuggestion
    try {
      s = await parseAssist({ text: t, clientNow: new Date().toISOString(), tz: localToday().tz })
    } catch (err) {
      // 422 (unparseable) → still let the user save manually, seeded with the
      // raw text. Everything else surfaces as an error back on the input.
      if (err instanceof ApiError && err.status === 422) {
        const fallback: AssistSuggestion = {
          category: 'note',
          title: t.slice(0, 100),
          notes: null,
          startAt: null,
          endAt: null,
          allDay: false,
          dueDate: null,
          mood: null,
          items: null,
          confidence: 'low',
          // Unparseable output, so nothing was resolved — but the category is
          // what the user has to pick here, not a date we never attempted.
          dateUncertain: false,
          traceId: '',
          responseId: '',
        }
        setSuggestion(fallback)
        seedEdit(fallback)
        setHint("Couldn't sort that automatically — pick a category and save.")
        setPhase('edit')
        return
      }
      setError(errMessage(err))
      setPhase('input')
      return
    }
    setSuggestion(s)
    // Low confidence: don't commit blind — let the user confirm first.
    if (s.confidence === 'low') {
      seedEdit(s)
      setHint(lowConfidenceHint(s))
      setPhase('edit')
      return
    }
    await autoSave(s)
  }

  async function finalizeAccepted() {
    clearTimer()
    const s = suggestion
    if (s && s.responseId) void sendAssistFeedback(s.responseId, 'accepted')
    if (s) onToast?.(savedLabel(s))
    onClose()
  }

  async function undo() {
    clearTimer()
    const handle = savedRef.current
    const s = suggestion
    setPhase('saving')
    try {
      if (handle) {
        await handle.undo()
        notifySaved(handle)
      }
      if (s && s.responseId) void sendAssistFeedback(s.responseId, 'rejected')
      onToast?.('Removed')
      onClose()
    } catch (err) {
      setError(errMessage(err))
      setPhase('saved')
    }
  }

  function beginChange() {
    clearTimer()
    if (suggestion) seedEdit(suggestion)
    setPhase('edit')
  }

  async function saveEdits(e: FormEvent) {
    e.preventDefault()
    const base = suggestion
    if (!base || phase === 'saving') return
    const t = title.trim()
    if (!t) {
      setError('Give it a title first.')
      return
    }
    // Drop blank-named rows (e.g. an "Add food" the user left empty); a
    // food save needs at least one real item.
    const cleanItems = items
      .map((it) => ({ ...it, name: it.name.trim() }))
      .filter((it) => it.name !== '')
    if (cat === 'food' && cleanItems.length === 0) {
      setError('Add at least one food, or pick another category.')
      return
    }

    // Recompute the date fields only if the user touched the picker; otherwise
    // preserve the original (so day-only tasks stay day-only).
    let startAt = base.startAt
    let endAt = base.endAt
    let allDay = base.allDay
    let dueDate = base.dueDate
    if (whenTouched) {
      const inst = when ? (toInstant(when) ?? null) : null
      if (cat === 'event') {
        startAt = inst
        allDay = inst === null
        // Preserve the AI-suggested duration when the user only nudges the
        // start (the edit card has no end field) — shift endAt by the same
        // delta rather than dropping it to a zero-length event.
        const durationMs =
          base.startAt && base.endAt
            ? new Date(base.endAt).getTime() - new Date(base.startAt).getTime()
            : null
        endAt =
          inst && durationMs && durationMs > 0
            ? new Date(new Date(inst).getTime() + durationMs).toISOString()
            : null
      } else if (cat === 'task' || cat === 'diary') {
        dueDate = inst
      }
    }
    if (cat !== 'event') {
      startAt = null
      endAt = null
      allDay = false
    }
    if (cat !== 'task' && cat !== 'diary') dueDate = null
    const finalMood = cat === 'diary' ? mood : null
    const finalItems = cat === 'food' ? cleanItems : null

    const edited: AssistSuggestion = {
      ...base,
      category: cat,
      title: t,
      notes: notes.trim() ? notes.trim() : null,
      startAt,
      endAt,
      allDay,
      dueDate,
      mood: finalMood,
      items: finalItems,
    }
    const editedFields: EditedFields = {
      category: cat,
      title: t,
      notes: edited.notes,
      dueDate,
      startAt,
      mood: finalMood,
      items: finalItems,
    }
    const verdict = editVerdict(base, editedFields)

    setError(null)
    setPhase('saving')
    try {
      // Nothing changed AND the item is already saved → keep it as-is.
      if (!(savedRef.current && verdict === 'accepted')) {
        // Create-then-delete (never the reverse): if the recreate fails, the
        // user's original auto-saved item is still there — a failed edit must
        // not destroy the capture. Worst case is a transient duplicate if the
        // subsequent undo of the old item fails, which is recoverable.
        const prev = savedRef.current
        const handle = await saveSuggestion(edited)
        savedRef.current = handle
        notifySaved(handle)
        if (prev) {
          try {
            await prev.undo()
            notifySaved(prev)
          } catch {
            // Leftover duplicate of the pre-edit item — non-fatal; the user
            // can delete it. Better than losing the edited capture.
          }
        }
      }
      if (base.responseId) {
        void sendAssistFeedback(
          base.responseId,
          verdict,
          verdict === 'edited' ? editedFields : undefined,
        )
      }
      onToast?.(savedLabel(edited))
      onClose()
    } catch (err) {
      setError(errMessage(err))
      setPhase('edit')
    }
  }

  // --- render --------------------------------------------------------

  if (phase === 'saved' && suggestion) {
    return (
      <div className="pl-fab-form" aria-live="polite">
        <p className="pl-fab-hint">
          {suggestion.category === 'food' ? (
            <>{savedLabel(suggestion)}</>
          ) : (
            <>
              Saved as <strong>{ASSIST_CATEGORY_LABELS[suggestion.category]}</strong>
              {suggestion.title ? ` — ${suggestion.title}` : ''}
            </>
          )}
        </p>
        <FormError message={error} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="pl-btn ghost" onClick={() => void undo()}>
            <Icon name="trash" size={13} /> Undo
          </button>
          <button type="button" className="pl-btn ghost" onClick={beginChange}>
            <Icon name="pencil" size={13} /> Change
          </button>
          <button type="button" className="pl-btn" onClick={() => void finalizeAccepted()}>
            <Icon name="check" size={13} /> Done
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'edit') {
    // The Food chip appears only when the suggestion actually carries food
    // items — re-categorizing a task INTO food would need macro estimates
    // the client doesn't have.
    const chipCats: AssistCategory[] =
      suggestion && foodEditAllowed(suggestion)
        ? [...ASSIST_CATEGORIES.slice(0, 3), 'food', ...ASSIST_CATEGORIES.slice(3)]
        : ASSIST_CATEGORIES
    return (
      <form className="pl-fab-form" onSubmit={saveEdits}>
        {hint && <p className="pl-fab-hint">{hint}</p>}
        <div className="pl-fab-label">
          Category
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} role="group" aria-label="Category">
            {chipCats.map((c) => (
              <button
                key={c}
                type="button"
                className={'pl-btn ghost' + (cat === c ? ' is-active' : '')}
                aria-pressed={cat === c}
                onClick={() => setCat(c)}
                style={cat === c ? { borderColor: 'var(--ink)', fontWeight: 600 } : undefined}
              >
                {ASSIST_CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
        </div>
        <label className="pl-fab-label">
          Title
          <input
            className="pl-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Title"
          />
        </label>
        {(cat === 'note' || cat === 'diary' || cat === 'event' || cat === 'task') && (
          <label className="pl-fab-label">
            {cat === 'note' || cat === 'diary' ? 'Details' : 'Notes'}
            <textarea
              className="pl-input"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              aria-label="Notes"
              style={{ resize: 'vertical' }}
            />
          </label>
        )}
        {(cat === 'event' || cat === 'task' || cat === 'diary') && (
          <label className="pl-fab-label">
            {cat === 'event' ? 'When' : 'Due'}
            <input
              className="pl-input"
              type="datetime-local"
              value={when}
              onChange={(e) => {
                setWhen(e.target.value)
                setWhenTouched(true)
              }}
              aria-label={cat === 'event' ? 'Event time' : 'Due date'}
            />
          </label>
        )}
        {cat === 'food' && (
          <div className="pl-fab-label">
            Foods
            {items.map((item, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  className="pl-input"
                  value={item.name}
                  onChange={(e) =>
                    setItems((prev) =>
                      prev.map((p, j) => (j === i ? { ...p, name: e.target.value } : p)),
                    )
                  }
                  aria-label={`Food ${i + 1} name`}
                  style={{ flex: 2 }}
                />
                <input
                  className="pl-input"
                  type="number"
                  min={1}
                  max={5000}
                  value={item.grams}
                  onChange={(e) => setItemGrams(i, Number(e.target.value))}
                  aria-label={`Food ${i + 1} grams`}
                  style={{ flex: 1 }}
                />
                <span style={{ fontSize: 12, opacity: 0.7 }}>g</span>
                <input
                  className="pl-input"
                  type="number"
                  min={0}
                  max={20000}
                  value={item.kcal}
                  onChange={(e) => setItemKcal(i, Number(e.target.value))}
                  aria-label={`Food ${i + 1} kcal`}
                  style={{ flex: 1 }}
                />
                <span style={{ fontSize: 12, opacity: 0.7 }}>kcal</span>
                <button
                  type="button"
                  className="pl-btn ghost"
                  onClick={() => removeItem(i)}
                  aria-label={`Remove food ${i + 1}`}
                  title="Remove"
                  style={{ padding: 6 }}
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
            ))}
            {items.length === 0 && (
              <p className="pl-fab-hint">Add a food below, or pick another category.</p>
            )}
            <button
              type="button"
              className="pl-btn ghost"
              onClick={addItem}
              style={{ alignSelf: 'flex-start' }}
            >
              <Icon name="plus" size={13} /> Add food
            </button>
          </div>
        )}
        {cat === 'diary' && (
          <div className="pl-fab-label">
            Mood
            <div style={{ display: 'flex', gap: 6 }} role="group" aria-label="Mood">
              {MOOD_EMOJI.map((emoji, i) => {
                const value = i + 1
                return (
                  <button
                    key={value}
                    type="button"
                    className={'pl-btn ghost' + (mood === value ? ' is-active' : '')}
                    aria-pressed={mood === value}
                    aria-label={`Mood ${value} of 5`}
                    onClick={() => setMood((m) => (m === value ? null : value))}
                    style={mood === value ? { borderColor: 'var(--ink)' } : undefined}
                  >
                    {emoji}
                  </button>
                )
              })}
            </div>
          </div>
        )}
        <FormError message={error} />
        <button className="pl-btn" type="submit" disabled={!title.trim()}>
          <Icon name="check" size={13} /> Save
        </button>
      </form>
    )
  }

  // phase === 'input' | 'saving'
  return (
    <form className="pl-fab-form" onSubmit={submit}>
      <label className="pl-fab-label">
        Capture
        <div style={{ position: 'relative' }}>
          <textarea
            className="pl-input"
            rows={4}
            value={text + (speech.listening && speech.transcript ? ` ${speech.transcript}` : '')}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type or dictate — e.g. “Dental cleaning 3/5/2027 at 9am”, “Buy strawberries”, “I ate 5 cherries”, “I'm feeling great today”"
            aria-label="What do you want to capture?"
            disabled={phase === 'saving'}
            style={{ resize: 'vertical', paddingRight: speech.supported ? 40 : undefined }}
          />
          {speech.supported && (
            <button
              type="button"
              className={'pl-btn ghost' + (speech.listening ? ' is-active' : '')}
              onClick={() => (speech.listening ? speech.stop() : speech.start())}
              aria-label={speech.listening ? 'Stop dictation' : 'Start dictation'}
              aria-pressed={speech.listening}
              title={speech.listening ? 'Stop dictation' : 'Dictate'}
              style={{
                position: 'absolute',
                top: 6,
                right: 6,
                padding: 6,
                borderColor: speech.listening ? 'var(--ink)' : undefined,
              }}
            >
              <MicGlyph active={speech.listening} />
            </button>
          )}
        </div>
      </label>
      {speech.error && <p className="pl-fab-hint">{speech.error}</p>}
      <FormError message={error} />
      <button className="pl-btn" type="submit" disabled={phase === 'saving' || !text.trim()}>
        <Icon name="bolt" size={13} />
        {phase === 'saving' ? 'Sorting…' : 'Categorize & save'}
      </button>
    </form>
  )
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p role="alert" className="pl-fab-error">
      {message}
    </p>
  )
}

// Small inline mic glyph (the shared Icon set has no microphone). Fills when
// actively listening.
function MicGlyph({ active }: { active: boolean }) {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x={9} y={2} width={6} height={11} rx={3} fill={active ? 'currentColor' : 'none'} />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1={12} y1={19} x2={12} y2={22} />
    </svg>
  )
}
