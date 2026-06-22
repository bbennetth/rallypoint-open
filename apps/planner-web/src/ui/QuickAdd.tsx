import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Drawer } from '@rallypoint/ui'
import { TICKET_PLATFORMS } from '@rallypoint/events-shared'
import {
  ApiError,
  createChoreSeries,
  createDiaryEntry,
  createNote,
  createPersonalEvent,
  createTaskItem,
  getChoresList,
  getDiaryList,
  listFieldDefs,
  listTaskLists,
  type ChoreListDto,
  type DiaryListDto,
  type FieldDefDto,
  type TaskListDto,
} from '../lib/api.js'
import { combineDueDateTime, splitQuickNote, toInstant } from '../lib/planner-helpers.js'
import { buildChoreSeriesInput } from '../lib/chores-helpers.js'
import { findMoodField, formatEntryDate } from '../lib/diary-helpers.js'
import { LAST_TASK_LIST_KEY, pickDefaultList } from '../lib/task-edit.js'
import { notifyCreated } from '../lib/refresh-bus.js'
import { addShoppingItemByTitle } from '../lib/shopping-helpers.js'
import { PriorityPicker } from './PriorityPicker.js'
import { MoodPicker } from './MoodPicker.js'
import { RecurrenceForm, defaultRecurrenceState, type RecurrenceState } from './RecurrenceForm.js'
import { Icon } from './icons.js'

// Floating quick-add pill (bottom-right, every authed screen). Tapping it opens
// a small menu (task / chore / event / note / shopping / diary); each action
// slides out an Ink Drawer with a compact form that reuses the same planner-api
// calls the full pages use. On success it nudges any live page to refetch
// (refresh-bus) and shows a toast.

type Action = 'task' | 'event' | 'note' | 'shopping' | 'chore' | 'diary'

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

export function QuickAdd({ onToast }: { onToast: (msg: string) => void }) {
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

  function done(kind: Action, toast: string) {
    notifyCreated(kind)
    onToast(toast)
    close()
  }

  const MENU: { key: Action; label: string }[] = [
    { key: 'task', label: 'Task' },
    { key: 'chore', label: 'Chore' },
    { key: 'event', label: 'Event' },
    { key: 'note', label: 'Note' },
    { key: 'shopping', label: 'Shopping' },
    { key: 'diary', label: 'Diary' },
  ]

  return (
    <div className="pl-fab-wrap" ref={wrapRef}>
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
              <Icon name="plus" size={15} stroke={2} />
              {m.label}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className={'pl-fab' + (menuOpen ? ' is-open' : '')}
        aria-label="Quick add"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((o) => !o)}
      >
        <Icon name="plus" size={22} stroke={2} />
      </button>

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
        <AddShoppingItemForm onDone={() => done('shopping', 'Item added to shopping list')} />
      </Drawer>
      <Drawer open={action === 'diary'} onClose={close} title="Add diary entry" mobileSheet>
        <AddDiaryForm onDone={() => done('diary', 'Diary entry added')} />
      </Drawer>
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
  const [lists, setLists] = useState<TaskListDto[] | null>(null)
  const [listId, setListId] = useState('')
  const [title, setTitle] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [dueTime, setDueTime] = useState('')
  const [priority, setPriority] = useState<'low' | 'medium' | 'high' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    listTaskLists()
      .then((rows) => {
        if (!alive) return
        setLists(rows)
        // Preselect the list this user last filed a quick-add task to, so the
        // common "same list again" case is a single keystroke.
        const remembered = (() => {
          try {
            return localStorage.getItem(LAST_TASK_LIST_KEY)
          } catch {
            return null
          }
        })()
        setListId(pickDefaultList(rows, remembered))
      })
      .catch((e) => alive && setError(errMessage(e)))
    return () => {
      alive = false
    }
  }, [])

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

  if (lists === null) return <p className="pl-fab-hint">Loading your lists…</p>
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
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [location, setLocation] = useState('')
  const [platform, setPlatform] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const nm = name.trim()
    if (!nm || busy) return
    setBusy(true)
    setError(null)
    const startAt = toInstant(start)
    const endAt = toInstant(end)
    const loc = location.trim()
    const emailTrimmed = email.trim()
    try {
      await createPersonalEvent({
        name: nm,
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
      <label className="pl-fab-label">
        Starts
        <input
          className="pl-input"
          type="datetime-local"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          aria-label="Event start"
        />
      </label>
      <label className="pl-fab-label">
        Ends
        <input
          className="pl-input"
          type="datetime-local"
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

// Single-field form for the shopping quick-add. No list picker — the server
// auto-provisions the user's single system-managed shopping list on first use
// (getShoppingList). Server also auto-categorizes the item by title.
function AddShoppingItemForm({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const t = title.trim()
    if (!t || busy) return
    setBusy(true)
    setError(null)
    try {
      await addShoppingItemByTitle(t)
      onDone()
    } catch (err) {
      setError(errMessage(err))
      setBusy(false)
    }
  }

  return (
    <form className="pl-fab-form" onSubmit={submit}>
      <label className="pl-fab-label">
        Item
        <input
          className="pl-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What do you need?"
          aria-label="Shopping item name"
          disabled={busy}
        />
      </label>
      <FormError message={error} />
      <button className="pl-btn" type="submit" disabled={busy || !title.trim()}>
        <Icon name="plus" size={13} />
        Add to list
      </button>
    </form>
  )
}

// Quick-add a recurring chore. Resolves (auto-provisions) the user's single
// system-managed chores list, then creates a series from the shared recurrence
// form via the same buildChoreSeriesInput the Chores page uses.
function AddChoreForm({ onDone }: { onDone: () => void }) {
  const [list, setList] = useState<ChoreListDto | null>(null)
  const [title, setTitle] = useState('')
  // Lazy initializer — React calls defaultRecurrenceState() once for the
  // initial value (the function is passed, not its result).
  const [rec, setRec] = useState<RecurrenceState>(defaultRecurrenceState)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    getChoresList()
      .then((l) => alive && setList(l))
      .catch((e) => alive && setError(errMessage(e)))
    return () => {
      alive = false
    }
  }, [])

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

  if (list === null && !error) return <p className="pl-fab-hint">Loading…</p>

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
  const [list, setList] = useState<DiaryListDto | null>(null)
  const [moodField, setMoodField] = useState<FieldDefDto | null>(null)
  const [date, setDate] = useState(() => new Date().toLocaleDateString('en-CA'))
  const [body, setBody] = useState('')
  const [mood, setMood] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    getDiaryList()
      .then(async (l) => {
        if (!alive) return
        setList(l)
        try {
          const defs = await listFieldDefs(l.id)
          if (alive) setMoodField(findMoodField(defs))
        } catch {
          // Mood is optional — a fields hiccup still lets the user write a body.
        }
      })
      .catch((e) => alive && setError(errMessage(e)))
    return () => {
      alive = false
    }
  }, [])

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
        dueDate: date,
        ...(moodField && mood ? { customFields: { [moodField.id]: mood } } : {}),
      })
      onDone()
    } catch (err) {
      setError(errMessage(err))
      setBusy(false)
    }
  }

  if (list === null && !error) return <p className="pl-fab-hint">Loading…</p>

  return (
    <form className="pl-fab-form" onSubmit={submit}>
      <label className="pl-fab-label">
        Date
        <input
          className="pl-input"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-label="Entry date"
          disabled={busy}
        />
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
