import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  ApiError,
  createTaskItem,
  setChoreItemCompleted,
  type MyDayTask,
} from '../lib/api.js'
import { combineDueDateTime } from '../lib/planner-helpers.js'
import { commitCheckinInput, type CheckinDraftTask } from '../lib/chores-helpers.js'
import { Icon } from './icons.js'

// Morning Check-in modal. Shown once per calendar day when the user lands on
// My Day. The opening ritual captures intentions for the day (free-form task
// titles, Enter-to-add) and lets the user pre-tick chores already done.
// "Start my day" commits the typed tasks into `taskListId` (with a
// date-only due of today) and writes each toggled chore back via
// setChoreItemCompleted. The modal is gated by the planner-settings
// `lastCheckinDay` key — MyDayPage persists today's YYYY-MM-DD after dismiss
// so the modal won't reopen until tomorrow's local date.
//
// Square corners, font-mono labels, exact spacing — see the MORNING CHECK-IN
// block in apps/planner-web/src/index.css. Backdrop uses backdrop-filter
// blur + saturate; on browsers without support the scrim still has a 70%
// app-bg fallback.

export interface MorningCheckinProps {
  // Display only. Splits on first space; pass '' to render just the greeting.
  firstName: string
  // Pre-rendered "Sunday, June 28" — formatted by the caller so the modal
  // doesn't have its own locale concerns.
  dateLabel: string
  // Today's chores, copied here as a working draft. Toggles flip the local
  // copy; "Start my day" diffs against this baseline and writes only the
  // changed entries. Pass [] when the user has no chores list yet or it's
  // empty — the section is hidden.
  chores: MyDayTask[]
  // The list id new tasks land in. Null disables the input row (no list to
  // file to). Resolved by MyDayPage via listTaskLists + pickDefaultList.
  taskListId: string | null
  // Today's local YYYY-MM-DD — passed to createTaskItem as the due date so
  // the new task appears in today's All-day band (date-only, no notify).
  todayYmd: string
  // The chores list id, used for setChoreItemCompleted writes.
  choresListId: string | null
  // Called after the user commits or skips; the parent is responsible for
  // persisting `lastCheckinDay` and triggering a My Day refresh.
  onDone: () => void
}

const GREETING_BREAKPOINT_MORNING = 12
const GREETING_BREAKPOINT_AFTERNOON = 17

function greetingForHour(hour: number): string {
  if (hour < GREETING_BREAKPOINT_MORNING) return 'Good morning'
  if (hour < GREETING_BREAKPOINT_AFTERNOON) return 'Good afternoon'
  return 'Good evening'
}

export function MorningCheckin({
  firstName,
  dateLabel,
  chores,
  taskListId,
  todayYmd,
  choresListId,
  onDone,
}: MorningCheckinProps) {
  const [input, setInput] = useState('')
  const [pending, setPending] = useState<CheckinDraftTask[]>([])
  // The chore working copy — toggles are local until "Start my day" writes
  // them. Keyed by the chore's stable list-item id. The `chores` prop is
  // typically empty at first mount (MyDayPage's choresListId resolves a tick
  // after the modal opens); a sync effect below merges new chores in as they
  // arrive without dropping the user's in-flight toggles on already-known
  // chores.
  const [choreDraft, setChoreDraft] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(chores.map((c) => [c.id, c.completed])),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const greeting = greetingForHour(new Date().getHours())

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Merge late-arriving chores into the working draft without losing any
  // toggles the user has already made on chores that were present at mount.
  useEffect(() => {
    setChoreDraft((prev) => {
      const next: Record<string, boolean> = {}
      for (const c of chores) {
        next[c.id] = c.id in prev ? prev[c.id]! : c.completed
      }
      return next
    })
  }, [chores])

  // Escape closes the modal without committing. Per the handoff the modal
  // still records the check-in for the day on dismiss (the user already saw
  // it), so MyDayPage's onDone handler does both the close + the persist.
  useEffect(() => {
    function esc(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onDone()
    }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [busy, onDone])

  function commit() {
    setPending((prev) => commitCheckinInput(input, prev))
    setInput('')
  }

  function onKey(e: ReactKeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      commit()
    }
  }

  function removePending(id: string): void {
    setPending((prev) => prev.filter((t) => t.id !== id))
  }

  function toggleChore(id: string): void {
    setChoreDraft((d) => ({ ...d, [id]: !(d[id] ?? false) }))
  }

  async function startMyDay(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      // 1) New tasks → today's list, date-only due (no time → no notify).
      // Snapshot pending so prop refresh mid-loop can't shift the iteration,
      // and drop each task from `pending` as soon as it's created so a
      // mid-loop failure leaves only the unprocessed ones — retry doesn't
      // double-create the ones that already landed.
      if (taskListId) {
        const dueDate = combineDueDateTime(todayYmd, '')
        const snapshot = pending.slice()
        for (const t of snapshot) {
          await createTaskItem(taskListId, t.title, { dueDate })
          setPending((prev) => prev.filter((p) => p.id !== t.id))
        }
      }
      // 2) Chore diffs → write only the toggled entries. Track which writes
      // succeeded via a local set so a mid-loop failure cleans up the draft
      // for the already-written ones; retry only re-sends the remaining
      // diffs. (Without this, the retry's diff still re-includes any chore
      // already written, but the server is idempotent on completed=value so
      // duplicate writes are harmless — the tracking is here purely so the
      // draft visibly reflects what's persisted.)
      if (choresListId) {
        const toWrite = chores.filter((c) => choreDraft[c.id] !== c.completed)
        for (const c of toWrite) {
          const next = choreDraft[c.id] ?? false
          await setChoreItemCompleted(choresListId, c.id, next)
        }
      }
      onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.')
      setBusy(false)
    }
  }

  return (
    <div className="mc-scrim" role="dialog" aria-modal="true" aria-labelledby="mc-title">
      <div className="mc-card">
        <div className="mc-head">
          <div id="mc-title" className="mc-greeting">
            {firstName ? `${greeting}, ${firstName}` : greeting}
          </div>
          <div className="mc-date">{dateLabel}</div>
        </div>

        <div className="mc-body">
          <div className="mc-section">
            <div className="mc-sec-label" id="mc-input-label">
              What do you need to do today?
            </div>
            <div className="mc-input-row">
              <input
                ref={inputRef}
                className="mc-input"
                placeholder="Type a task, press Enter to add"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKey}
                disabled={busy || !taskListId}
                aria-labelledby="mc-input-label"
              />
              <button
                type="button"
                className="mc-addbtn"
                onClick={commit}
                disabled={busy || !input.trim() || !taskListId}
                aria-label="Add task"
              >
                <Icon name="plus" size={15} stroke={2} />
              </button>
            </div>
            {pending.length > 0 && (
              <div className="mc-addedlist">
                {pending.map((t) => (
                  <div key={t.id} className="mc-addeditem">
                    <span className="mc-addeddot" />
                    <span className="mc-addedtitle">{t.title}</span>
                    <button
                      type="button"
                      className="mc-rmv"
                      onClick={() => removePending(t.id)}
                      aria-label={`Remove ${t.title}`}
                      disabled={busy}
                    >
                      <span
                        style={{ transform: 'rotate(45deg)', display: 'block', lineHeight: 0 }}
                        aria-hidden="true"
                      >
                        <Icon name="plus" size={10} />
                      </span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {chores.length > 0 && (
            <div className="mc-section">
              <div className="mc-sec-label">Chores — check off anything already done</div>
              <div className="mc-chorelist">
                {chores.map((c) => {
                  const done = choreDraft[c.id] ?? false
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={'mc-chore' + (done ? ' done' : '')}
                      onClick={() => toggleChore(c.id)}
                      aria-pressed={done}
                      disabled={busy}
                    >
                      <span
                        className={'pl-check' + (done ? ' done' : '')}
                        style={{ flex: '0 0 auto', pointerEvents: 'none' }}
                        aria-hidden="true"
                      >
                        {done && <Icon name="check" size={12} stroke={2} />}
                      </span>
                      <span className="mc-choretitle">{c.title}</span>
                      {done ? (
                        <span className="mc-choremark">Done</span>
                      ) : (
                        <span className="mc-choredue">Today</span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {error && (
            <p role="alert" style={{ color: 'var(--hot)', fontSize: 13, padding: '0 28px 18px' }}>
              {error}
            </p>
          )}
        </div>

        <div className="mc-foot">
          <button
            type="button"
            className="mc-startbtn"
            onClick={() => void startMyDay()}
            disabled={busy}
          >
            Start my day
            <Icon name="chevron" size={13} />
          </button>
        </div>
      </div>
    </div>
  )
}
