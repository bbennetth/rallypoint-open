import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Drawer } from '@rallypoint/ui'
import { TICKET_PLATFORMS } from '@rallypoint/events-shared'
import {
  ApiError,
  choresListQuery,
  createChoreSeries,
  createDiaryEntry,
  createNote,
  createPersonalEvent,
  createTaskItem,
  diaryListQuery,
  fieldDefsQuery,
  taskListsQuery,
} from '../lib/api.js'
import { useCachedQuery } from '../lib/offline/use-cached-query.js'
import {
  combineDueDateTime,
  dateInputToInstant,
  instantToDateInput,
  instantToLocalInput,
  instantToTimeInput,
  splitQuickNote,
  toInstant,
} from '../lib/planner-helpers.js'
import { buildChoreSeriesInput } from '../lib/chores-helpers.js'
import { findMoodField, formatEntryDate } from '../lib/diary-helpers.js'
import { LAST_TASK_LIST_KEY, pickDefaultList } from '../lib/task-edit.js'
import { notifyCreated, type CreatedKind } from '../lib/refresh-bus.js'
import {
  MAX_BULK_SHOPPING_ITEMS,
  addShoppingItemsByTitles,
  parseShoppingLines,
} from '../lib/shopping-helpers.js'
import { PriorityPicker } from './PriorityPicker.js'
import { MoodPicker } from './MoodPicker.js'
import { RecurrenceForm, defaultRecurrenceState, type RecurrenceState } from './RecurrenceForm.js'
import { AssistDrawer } from './AssistDrawer.js'
import { Icon, type IconName } from './icons.js'

// Floating quick-add pill (bottom-right, every authed screen). Tapping it opens
// a small menu (task / chore / event / note / shopping / diary); each action
// slides out an Ink Drawer with a compact form that reuses the same planner-api
// calls the full pages use. On success it nudges any live page to refetch
// (refresh-bus) and shows a toast.

type Action = 'assist' | 'task' | 'event' | 'note' | 'shopping' | 'chore' | 'diary'

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

export function QuickAdd({
  anchor = 'float',
  onToast,
}: {
  /**
   * Where the FAB sits:
   *   - `'float'` (default): a fixed-position button at the shared
   *     bottom-right anchor (`.pl-fab-wrap` provides the positioning).
   *     Use on pages with no sub-bar (Notes, Diary, Settings, …).
   *   - `'subbar'`: a bare flex-child button intended to be dropped in
   *     as the trailing child of an `<SubBar>`. The sub-bar's own
   *     positioning + glass chrome anchor the FAB; we skip the
   *     standalone `.pl-fab-wrap` wrapper so positioning doesn't
   *     double up. The popover menu still anchors above the FAB.
   */
  anchor?: 'float' | 'subbar'
  /** Toast callback; pages get this from their parent chrome or via the
   *  shared @rallypoint/ui `useToast` store. Optional so a bare
   *  `<QuickAdd />` can be dropped into a page without ceremony. */
  onToast?: (msg: string) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [action, setAction] = useState<Action | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Outside-click + Escape close the menu (mirrors AppSwitcher).
  useEffect(() => {
    if (!menuOpen) return
    const off = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', off)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', off)
      document.removeEventListener('keydown', esc)
    }
  }, [menuOpen])

  function open(a: Action) {
    setMenuOpen(false)
    setAction(a)
  }
  const close = () => setAction(null)

  function done(kind: CreatedKind, toast: string) {
    notifyCreated(kind)
    onToast?.(toast)
    close()
  }

  const MENU: { key: Action; label: string; icon?: IconName }[] = [
    { key: 'assist', label: 'AI Assist', icon: 'bolt' },
    { key: 'task', label: 'Task' },
    { key: 'chore', label: 'Chore' },
    { key: 'event', label: 'Event' },
    { key: 'note', label: 'Note' },
    { key: 'shopping', label: 'Shopping' },
    { key: 'diary', label: 'Diary' },
  ]

  // The popover menu + button + drawers are shared between both
  // anchors. Only the outer positioning wrapper varies — `'float'`
  // gets `.pl-fab-wrap` (position: fixed, bottom-right), `'subbar'`
  // gets a bare `position: relative` shell so the absolute-positioned
  // `.pl-fab-menu` still anchors above the button.
  const inner = (
    <>
      {menuOpen && (
        <div className="pl-fab-menu" role="menu">
          {MENU.map((m) => (
            <button
              key={m.key}
              type="button"
              className="pl-fab-item"
              role="menuitem"
              onClick={() => open(m.key)}
            >
              <Icon name={m.icon ?? 'plus'} size={15} stroke={2} />
              {m.label}
            </button>
          ))}
        </div>
      )}
      {/* Kit's 40×40 squared `.rp-fab` (from PR #603) replaces the
          previous 56×56 round `.pl-fab`. Plus glyph shrinks
          proportionally from 22 → 18 to keep the visual weight. */}
      <button
        type="button"
        className={'rp-fab' + (menuOpen ? ' is-open' : '')}
        aria-label="Quick add"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((o) => !o)}
      >
        <Icon name="plus" size={18} stroke={2.4} />
      </button>

      {/* AI Assist manages its own save + Undo/Change lifecycle (it can save
          any of the five kinds and fires refresh-bus per save), so it takes
          onClose + onToast directly rather than the single-shot done(). */}
      <Drawer open={action === 'assist'} onClose={close} title="AI Assist" mobileSheet>
        <AssistDrawer onClose={close} {...(onToast ? { onToast } : {})} />
      </Drawer>
      <Drawer open={action === 'task'} onClose={close} title="Add task" mobileSheet>
        <AddTaskForm onDone={() => done('task', 'Task added')} onClose={close} />
      </Drawer>
      <Drawer open={action === 'chore'} onClose={close} title="Add chore" mobileSheet>
        <AddChoreForm onDone={() => done('chore', 'Chore added')} />
      </Drawer>
      <Drawer open={action === 'event'} onClose={close} title="Add event" mobileSheet>
        <AddEventForm onDone={() => done('event', 'Event added')} />
      </Drawer>
      <Drawer open={action === 'note'} onClose={close} title="Add note" mobileSheet>
        <AddNoteForm onDone={() => done('note', 'Note added')} />
      </Drawer>
      <Drawer open={action === 'shopping'} onClose={close} title="Add to shopping list" mobileSheet>
        <AddShoppingItemForm
          onDone={(count) =>
            done(
              'shopping',
              count > 1
                ? `${count} items added to shopping list`
                : 'Item added to shopping list',
            )
          }
        />
      </Drawer>
      <Drawer open={action === 'diary'} onClose={close} title="Add diary entry" mobileSheet>
        <AddDiaryForm onDone={() => done('diary', 'Diary entry added')} />
      </Drawer>
    </>
  )

  if (anchor === 'subbar') {
    // Bare flex-child shell: no fixed positioning, no z-index — the
    // parent `<SubBar>` handles all of that. `position: relative` so
    // the absolutely-positioned `.pl-fab-menu` anchors above this
    // button rather than the document.
    return (
      <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex', flex: '0 0 auto' }}>
        {inner}
      </div>
    )
  }

  // `.rp-fab-float` is normally a button modifier per the kit's Fab
  // component, but QuickAdd needs a wrapper element to (a) anchor the
  // absolute-positioned `.pl-fab-menu` popover and (b) catch
  // outside-click for menu dismissal via `wrapRef.contains`. Applying
  // it to the wrapper here gives us a positioned ancestor at the
  // correct kit coordinates (matching the in-subbar trailing FAB's
  // screen position) so navigation between sub-bar and no-sub-bar
  // pages doesn't visibly shift the FAB. The button inside stays
  // `.rp-fab` only — no `.rp-fab-float` doubling.
  return (
    <div className="rp-fab-float" ref={wrapRef}>
      {inner}
    </div>
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

function AddTaskForm({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  // Render-from-cache (same pattern as the pages): the last-known lists paint
  // instantly — online or offline — while a background refresh runs. The
  // 'loading' hint only shows on a true cold cache miss.
  const listsQ = useCachedQuery(useMemo(() => taskListsQuery(), []))
  const lists = listsQ.data ?? null
  const [listId, setListId] = useState('')
  const [title, setTitle] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [dueTime, setDueTime] = useState('')
  const [priority, setPriority] = useState<'low' | 'medium' | 'high' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Preselect the list this user last filed a quick-add task to, so the
  // common "same list again" case is a single keystroke. Runs whenever the
  // cached lists (re)arrive but never stomps a selection the user already
  // made — unless a refresh dropped that list entirely.
  useEffect(() => {
    if (!lists || lists.length === 0) return
    setListId((cur) => {
      if (cur && lists.some((l) => l.id === cur)) return cur
      const remembered = (() => {
        try {
          return localStorage.getItem(LAST_TASK_LIST_KEY)
        } catch {
          return null
        }
      })()
      return pickDefaultList(lists, remembered)
    })
  }, [lists])

  async function submit(e: FormEvent) {
    e.preventDefault()
    const t = title.trim()
    if (!t || !listId || busy) return
    setBusy(true)
    setError(null)
    try {
      const dueDateInstant = combineDueDateTime(dueDate, dueTime)
      // Always send priority explicitly (including null = no-priority) so the
      // created task matches the picker. Omitting it lets the server default to
      // 'medium' even when the user saw "None" — that mismatch is the bug fixed
      // in #430. dueDate continues to be omitted when empty (server null default).
      await createTaskItem(listId, t, {
        ...(dueDateInstant !== null ? { dueDate: dueDateInstant } : {}),
        priority,
      })
      // Remember this list for the next quick-add.
      try {
        localStorage.setItem(LAST_TASK_LIST_KEY, listId)
      } catch {
        // ignore storage failures (private mode, quota) — non-essential
      }
      onDone()
    } catch (err) {
      setError(errMessage(err))
      setBusy(false)
    }
  }

  if (lists === null) {
    // status 'error' only ever fires on a cold miss (a cached value renders
    // as 'stale' even when the refresh fails), so this is a real dead end.
    if (listsQ.status === 'error') return <FormError message={errMessage(listsQ.error)} />
    return <p className="pl-fab-hint">Loading your lists…</p>
  }
  if (lists.length === 0) {
    return (
      <div className="pl-fab-empty">
        <p className="pl-fab-hint">You don't have any task lists yet.</p>
        <Link className="pl-btn ghost" to="/tasks" onClick={onClose}>
          Go to Tasks
        </Link>
      </div>
    )
  }

  return (
    <form className="pl-fab-form" onSubmit={submit}>
      <label className="pl-fab-label">
        List
        <select className="pl-input" value={listId} onChange={(e) => setListId(e.target.value)}>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      <label className="pl-fab-label">
        Task
        <input
          className="pl-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs doing?"
          aria-label="Task title"
        />
      </label>
      <label className="pl-fab-label">
        Due date
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="pl-input"
            type="date"
            value={dueDate}
            onChange={(e) => {
              setDueDate(e.target.value)
              // A time with no date is meaningless — clear it when the date is cleared.
              if (!e.target.value) setDueTime('')
            }}
            aria-label="Task due date"
            disabled={busy}
          />
          <input
            className="pl-input"
            type="time"
            value={dueTime}
            onChange={(e) => setDueTime(e.target.value)}
            aria-label="Task due time"
            disabled={busy || !dueDate}
          />
        </div>
      </label>
      <div className="pl-fab-label">
        Priority
        <PriorityPicker value={priority} onChange={setPriority} allowClear disabled={busy} />
      </div>
      <FormError message={error} />
      <button className="pl-btn" type="submit" disabled={busy || !title.trim()}>
        <Icon name="plus" size={13} />
        Add task
      </button>
    </form>
  )
}

function AddEventForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [isAllDay, setIsAllDay] = useState(false)
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [location, setLocation] = useState('')
  const [platform, setPlatform] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handleAllDayChange(checked: boolean) {
    setIsAllDay(checked)
    // Convert the current start/end values between datetime-local and date
    // formats, same as PersonalEventEdit's toggle (#675).
    if (checked) {
      // switching to all-day: strip the time portion
      if (start) {
        const instant = toInstant(start)
        setStart(instant ? instantToDateInput(instant) : '')
      }
      if (end) {
        const instant = toInstant(end)
        setEnd(instant ? instantToDateInput(instant) : '')
      }
    } else {
      // switching to timed: reparse as local midnight instant then back to datetime-local
      if (start) {
        const instant = dateInputToInstant(start)
        setStart(instant ? instantToLocalInput(instant) : '')
      }
      if (end) {
        const instant = dateInputToInstant(end)
        setEnd(instant ? instantToLocalInput(instant) : '')
      }
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const nm = name.trim()
    if (!nm || busy) return
    setBusy(true)
    setError(null)
    const startAt = isAllDay ? (dateInputToInstant(start) ?? undefined) : toInstant(start)
    const endAt = isAllDay ? (dateInputToInstant(end) ?? undefined) : toInstant(end)
    const loc = location.trim()
    const emailTrimmed = email.trim()
    try {
      await createPersonalEvent({
        name: nm,
        allDay: isAllDay,
        ...(startAt ? { startAt } : {}),
        ...(endAt ? { endAt } : {}),
        ...(loc ? { locationLabel: loc } : {}),
        ...(platform ? { ticketPlatform: platform } : {}),
        ...(emailTrimmed ? { ticketAccountEmail: emailTrimmed } : {}),
      })
      onDone()
    } catch (err) {
      setError(errMessage(err))
      setBusy(false)
    }
  }

  return (
    <form className="pl-fab-form" onSubmit={submit}>
      <label className="pl-fab-label">
        Name
        <input
          className="pl-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Event name"
          aria-label="Event name"
        />
      </label>
      <label className="pl-fab-label" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={isAllDay}
          onChange={(e) => handleAllDayChange(e.target.checked)}
          aria-label="All day event"
        />
        All day
      </label>
      <label className="pl-fab-label">
        Starts
        <input
          className="pl-input"
          type={isAllDay ? 'date' : 'datetime-local'}
          value={start}
          onChange={(e) => setStart(e.target.value)}
          aria-label="Event start"
        />
      </label>
      <label className="pl-fab-label">
        Ends
        <input
          className="pl-input"
          type={isAllDay ? 'date' : 'datetime-local'}
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          aria-label="Event end"
        />
      </label>
      <label className="pl-fab-label">
        Location
        <input
          className="pl-input"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="Optional"
          aria-label="Event location"
        />
      </label>
      <label className="pl-fab-label">
        Platform
        <select
          className="pl-input"
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          aria-label="Ticket platform"
        >
          <option value="">— None —</option>
          {TICKET_PLATFORMS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className="pl-fab-label">
        Account email
        <input
          className="pl-input"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Optional"
          aria-label="Ticket account email"
        />
      </label>
      <FormError message={error} />
      <button className="pl-btn" type="submit" disabled={busy || !name.trim()}>
        <Icon name="plus" size={13} />
        Add event
      </button>
    </form>
  )
}

function AddNoteForm({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const note = splitQuickNote(text)
    if (!note || busy) return
    setBusy(true)
    setError(null)
    try {
      await createNote(note)
      onDone()
    } catch (err) {
      setError(errMessage(err))
      setBusy(false)
    }
  }

  return (
    <form className="pl-fab-form" onSubmit={submit}>
      <label className="pl-fab-label">
        Note
        <textarea
          className="pl-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Jot something down… the first line becomes the title."
          aria-label="Note text"
          rows={7}
        />
      </label>
      <FormError message={error} />
      <button className="pl-btn" type="submit" disabled={busy || splitQuickNote(text) === null}>
        <Icon name="plus" size={13} />
        Save note
      </button>
    </form>
  )
}

// Bulk-add form for the shopping quick-add: one item per non-empty line.
// No list picker — the server auto-provisions the user's single
// system-managed shopping list on first use (getShoppingList). Server also
// auto-categorizes each item by title.
function AddShoppingItemForm({ onDone }: { onDone: (count: number) => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titles = parseShoppingLines(text)
  const overMax = titles.length > MAX_BULK_SHOPPING_ITEMS

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (titles.length === 0 || overMax || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await addShoppingItemsByTitles(titles)
      if (result.error) {
        // Partial failure: keep only the un-added lines so a retry can't
        // duplicate the items that already landed.
        setText(result.remaining.join('\n'))
        setError(
          result.created.length > 0
            ? `Added ${result.created.length} of ${titles.length} — the rest are still below. ${errMessage(result.error)}`
            : errMessage(result.error),
        )
        setBusy(false)
        return
      }
      onDone(result.created.length)
    } catch (err) {
      setError(errMessage(err))
      setBusy(false)
    }
  }

  return (
    <form className="pl-fab-form" onSubmit={submit}>
      <label className="pl-fab-label">
        Items
        <textarea
          className="pl-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What do you need? One item per line."
          aria-label="Shopping items, one per line"
          rows={5}
          disabled={busy}
        />
      </label>
      <FormError
        message={
          overMax ? `Too many items — max ${MAX_BULK_SHOPPING_ITEMS} per add.` : error
        }
      />
      <button className="pl-btn" type="submit" disabled={busy || titles.length === 0 || overMax}>
        <Icon name="plus" size={13} />
        {titles.length > 1 ? `Add ${titles.length} to list` : 'Add to list'}
      </button>
    </form>
  )
}

// Quick-add a recurring chore. Resolves (auto-provisions) the user's single
// system-managed chores list, then creates a series from the shared recurrence
// form via the same buildChoreSeriesInput the Chores page uses.
function AddChoreForm({ onDone }: { onDone: () => void }) {
  // Render-from-cache: the warmed choresList row paints the form instantly
  // (online or offline); only a true cold miss shows the loading hint.
  const listQ = useCachedQuery(useMemo(() => choresListQuery(), []))
  const list = listQ.data ?? null
  const [title, setTitle] = useState('')
  // Lazy initializer — React calls defaultRecurrenceState() once for the
  // initial value (the function is passed, not its result).
  const [rec, setRec] = useState<RecurrenceState>(defaultRecurrenceState)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!list || busy) return
    const built = buildChoreSeriesInput({
      title,
      freq: rec.freq,
      interval: rec.interval,
      byDay: rec.byDay,
      dtstart: rec.dtstart,
      bound: rec.boundType,
      count: rec.count,
      until: rec.until,
      timeOfDay: rec.timeOfDay,
    })
    if (!built.ok) {
      setError(built.error)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await createChoreSeries(list.id, built.input)
      onDone()
    } catch (err) {
      setError(errMessage(err))
      setBusy(false)
    }
  }

  if (list === null) {
    if (listQ.status === 'error') return <FormError message={errMessage(listQ.error)} />
    return <p className="pl-fab-hint">Loading…</p>
  }

  return (
    <form className="pl-fab-form" onSubmit={submit}>
      <label className="pl-fab-label">
        Chore
        <input
          className="pl-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs doing regularly?"
          aria-label="Chore name"
          disabled={busy}
        />
      </label>
      <RecurrenceForm value={rec} onChange={setRec} disabled={busy} />
      <FormError message={error} />
      <button className="pl-btn" type="submit" disabled={busy || !title.trim()}>
        <Icon name="plus" size={13} />
        Add chore
      </button>
    </form>
  )
}

// Quick-add a diary entry: date + mood + body, mirroring the Diary page
// composer. Resolves (auto-provisions + seeds the Mood field) the diary list,
// then loads the field defs to render the Mood picker.
function AddDiaryForm({ onDone }: { onDone: () => void }) {
  // Render-from-cache: the diary list + its field defs paint from the warmed
  // cache instantly (the old effect was a 2-request network waterfall on
  // every open, and a dead end offline). Mood stays optional — a defs miss
  // still lets the user write a body.
  const listQ = useCachedQuery(useMemo(() => diaryListQuery(), []))
  const list = listQ.data ?? null
  const listId = list?.id ?? null
  const defsQ = useCachedQuery(useMemo(() => (listId ? fieldDefsQuery(listId) : null), [listId]))
  const moodField = useMemo(() => findMoodField(defsQ.data ?? []), [defsQ.data])
  const [date, setDate] = useState(() => new Date().toLocaleDateString('en-CA'))
  // Capture the time of entry: defaults to "now", editable, and clearable —
  // an empty time keeps the entry day-only (raw date string, as before).
  const [time, setTime] = useState(() => instantToTimeInput(new Date().toISOString()))
  const [body, setBody] = useState('')
  const [mood, setMood] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!list || busy) return
    const text = body.trim()
    if (!text && !mood) {
      setError('Write something or pick a mood first.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await createDiaryEntry(list.id, {
        title: formatEntryDate(date),
        notes: text ? text : null,
        // Timed entries store a true local instant; a cleared time falls back
        // to the raw day string (midnight-UTC, the legacy day-only shape the
        // diary helpers key off).
        dueDate: date && time ? combineDueDateTime(date, time) : date,
        ...(moodField && mood ? { customFields: { [moodField.id]: mood } } : {}),
      })
      onDone()
    } catch (err) {
      setError(errMessage(err))
      setBusy(false)
    }
  }

  if (list === null) {
    if (listQ.status === 'error') return <FormError message={errMessage(listQ.error)} />
    return <p className="pl-fab-hint">Loading…</p>
  }

  return (
    <form className="pl-fab-form" onSubmit={submit}>
      <label className="pl-fab-label">
        Date
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="pl-input"
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value)
              // A time with no date is meaningless — clear it with the date.
              if (!e.target.value) setTime('')
            }}
            aria-label="Entry date"
            disabled={busy}
          />
          <input
            className="pl-input"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            aria-label="Entry time"
            disabled={busy || !date}
          />
        </div>
      </label>
      {moodField && (
        <div className="pl-fab-label">
          {moodField.label}
          <MoodPicker field={moodField} value={mood} onChange={setMood} disabled={busy} />
        </div>
      )}
      <label className="pl-fab-label">
        Entry
        <textarea
          className="pl-input"
          rows={5}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="What happened today?"
          aria-label="Diary entry"
          disabled={busy}
          style={{ resize: 'vertical' }}
        />
      </label>
      <FormError message={error} />
      <button className="pl-btn" type="submit" disabled={busy || (!body.trim() && !mood)}>
        <Icon name="plus" size={13} />
        Add entry
      </button>
    </form>
  )
}
