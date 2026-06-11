import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useConnectionView } from '@rallypoint/ui'
import {
  ApiError,
  getGroup,
  listChatMessages,
  sendChatMessage,
  type ChatMessageDto,
  type GroupDetailDto,
} from '../lib/api.js'
import { shouldRefetch, subscribeGroupStream } from '../lib/realtime.js'
import { useRefreshBus } from '../lib/refresh-bus.js'
import { useAttendeeOutlet } from '../ui/AttendeeChrome.js'

// Group chat (slice 10). Messages are kept oldest→newest in state (the API
// returns newest-first, cursor-paged backwards via `before`). A live SSE
// subscription refetches the newest page whenever another member posts (or
// on reconnect); the client's own sends refetch directly, so `shouldRefetch`
// skips the echo of our own envelope.

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; group: GroupDetailDto }
  | { status: 'error'; code: string; message: string }

export function ChatPage() {
  const { userId } = useAttendeeOutlet()
  const { groupId } = useParams<{ groupId: string }>()
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [messages, setMessages] = useState<ChatMessageDto[]>([])
  const [nextBefore, setNextBefore] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)

  // Merge a newest-first page into the oldest→newest list, appending only
  // messages we haven't seen (new ones are always newer than what we hold).
  const mergeTail = useCallback((page: ChatMessageDto[]) => {
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.id))
      const fresh = [...page].reverse().filter((m) => !seen.has(m.id))
      return fresh.length ? [...prev, ...fresh] : prev
    })
  }, [])

  const refetchTail = useCallback(() => {
    if (!groupId) return
    listChatMessages(groupId)
      .then((page) => mergeTail(page.items))
      .catch(() => {})
  }, [groupId, mergeTail])

  // Keep the latest refetchTail reachable from the long-lived stream handler
  // without re-subscribing on every render.
  const refetchTailRef = useRef(refetchTail)
  refetchTailRef.current = refetchTail

  const load = useCallback(() => {
    if (!groupId) return
    setState({ status: 'loading' })
    getGroup(groupId)
      .then(async (group) => {
        const page = await listChatMessages(group.id)
        setMessages([...page.items].reverse())
        setNextBefore(page.next_before)
        setState({ status: 'ready', group })
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) {
          setState({ status: 'error', code: 'not_found', message: 'Group not found.' })
        } else {
          setState({
            status: 'error',
            code: err instanceof ApiError ? err.code : 'unexpected_error',
            message: err instanceof Error ? err.message : 'Unknown error.',
          })
        }
      })
  }, [groupId])

  useEffect(() => {
    load()
  }, [load])

  // Pull-to-refresh refetches the latest page (same path SSE takes
  // for live updates from other members).
  useRefreshBus(refetchTail)

  // Live updates: subscribe once per group. A chat envelope from another
  // member refetches the tail; a reconnect refetches to catch anything
  // missed while the connection was down.
  useEffect(() => {
    if (!groupId || state.status !== 'ready') return
    const unsubscribe = subscribeGroupStream(groupId, {
      onEvent: (env) => {
        if (env.resource === 'chat_messages' && shouldRefetch(env, userId)) {
          refetchTailRef.current()
        }
      },
      onReconnect: () => refetchTailRef.current(),
    })
    return unsubscribe
  }, [groupId, state.status, userId])

  const loadOlder = useCallback(() => {
    if (!groupId || !nextBefore) return
    setLoadingOlder(true)
    listChatMessages(groupId, { before: nextBefore })
      .then((page) => {
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.id))
          const older = [...page.items].reverse().filter((m) => !seen.has(m.id))
          return [...older, ...prev]
        })
        setNextBefore(page.next_before)
      })
      .catch(() => {})
      .finally(() => setLoadingOlder(false))
  }, [groupId, nextBefore])

  if (state.status === 'loading') {
    return (
      <main className="flex items-center justify-center p-8">
        <p className="text-[color:var(--ink-dim)] text-sm">Loading…</p>
      </main>
    )
  }

  if (state.status === 'error') {
    return (
      <main className="flex items-center justify-center p-8">
        <div
          className="max-w-md w-full p-4"
          style={{
            border: '1.5px solid var(--hot)',
            background: 'color-mix(in srgb, var(--hot) 12%, transparent)',
          }}
        >
          <h1 className="text-lg font-semibold text-[color:var(--ink)]">
            {state.code === 'not_found' ? 'Group not found' : 'Error'}
          </h1>
          <p className="mt-2 text-sm text-[color:var(--ink)]">{state.message}</p>
          <a href="/me/events" className="mt-4 inline-block text-sm text-[color:var(--ink-mute)] underline">
            Back to my events
          </a>
        </div>
      </main>
    )
  }

  const { group } = state

  return (
    <main className="page-pad">
      <div className="max-w-2xl mx-auto space-y-5">
        <nav>
          <Link
            to={`/groups/${group.id}`}
            className="text-sm text-[color:var(--ink-mute)] hover:text-[color:var(--ink)] underline"
          >
            ← {group.name}
          </Link>
        </nav>

        <header className="space-y-1">
          <p className="text-xs font-medium" style={{ color: 'var(--ink-mute)' }}>
            Chat
          </p>
          <h1 className="display text-2xl">{group.name}</h1>
        </header>

        <ConnectionHint />

        <section
          className="p-4 space-y-3"
          style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
        >
          {nextBefore && (
            <button
              onClick={loadOlder}
              disabled={loadingOlder}
              className="text-xs text-[color:var(--ink-mute)] hover:text-[color:var(--ink)] underline disabled:opacity-50"
            >
              {loadingOlder ? 'Loading…' : 'Load older messages'}
            </button>
          )}

          {messages.length === 0 ? (
            <p className="text-sm text-[color:var(--ink-dim)]">No messages yet. Say hello.</p>
          ) : (
            <MessageStream messages={messages} viewerUserId={userId} />
          )}
        </section>

        <Composer groupId={group.id} onSent={(msg) => mergeTail([msg])} />
      </div>
    </main>
  )
}

// Render the message list with day-separator chips between dates.
function MessageStream({
  messages,
  viewerUserId,
}: {
  messages: ChatMessageDto[]
  viewerUserId: string
}) {
  // Sort defensively — the page already keeps oldest→newest, but a
  // refetch race could surface out-of-order rows briefly.
  const sorted = [...messages].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  )
  const items: React.ReactNode[] = []
  let lastDay: string | null = null
  for (const m of sorted) {
    // Group by *local-tz* calendar date, not the UTC ISO date slice.
    // A message sent at 23:30 local on Tuesday would be Wednesday's
    // date in UTC and would group under the wrong day (with the
    // separator label also coming out wrong).
    const day = localDateKey(m.created_at)
    if (day !== lastDay) {
      items.push(<DaySeparator key={`d-${day}`} dateKey={day} />)
      lastDay = day
    }
    items.push(
      <MessageBubble key={m.id} message={m} mine={m.user_id === viewerUserId} />,
    )
  }
  return <ul className="space-y-2">{items}</ul>
}

// `YYYY-MM-DD` in the viewer's local timezone, derived from a Date.
// Used as the bucket key for chat day separators so a message at
// 23:30 local Tuesday groups with Tuesday's siblings — not the UTC
// roll-over to Wednesday.
function localDateKey(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function DaySeparator({ dateKey }: { dateKey: string }) {
  // dateKey is local YYYY-MM-DD (from `localDateKey` above), so a
  // local-tz Date constructor below stays consistent with the
  // bucketing math.
  const [y, m, d] = dateKey.split('-').map((s) => Number(s))
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
  let label: string
  if (date.getTime() === today.getTime()) {
    label = 'TODAY'
  } else if (date.getTime() === yesterday.getTime()) {
    label = 'YESTERDAY'
  } else {
    label = date
      .toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      })
      .toUpperCase()
  }
  return (
    <li
      className="flex items-center gap-2 py-2"
      aria-hidden
      style={{ listStyle: 'none' }}
    >
      <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
      <span
        className="mono"
        style={{
          fontSize: 9,
          letterSpacing: '0.14em',
          color: 'var(--ink-mute)',
        }}
      >
        {label}
      </span>
      <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
    </li>
  )
}

function MessageBubble({
  message,
  mine,
}: {
  message: ChatMessageDto
  mine: boolean
}) {
  return (
    <li
      style={{
        display: 'flex',
        justifyContent: mine ? 'flex-end' : 'flex-start',
        listStyle: 'none',
      }}
    >
      <div
        style={{
          maxWidth: '78%',
          padding: '8px 12px',
          border: '1.5px solid var(--line)',
          background: mine
            ? 'color-mix(in srgb, var(--acid) 14%, var(--surface))'
            : 'var(--surface)',
          borderColor: mine ? 'var(--acid)' : 'var(--line)',
        }}
      >
        <div
          className="mono"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 8,
            fontSize: 9,
            letterSpacing: '0.08em',
            color: 'var(--ink-mute)',
            marginBottom: 2,
          }}
        >
          <span>{mine ? 'YOU' : message.user_id.slice(0, 8).toUpperCase()}</span>
          <span>
            {new Date(message.created_at).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </div>
        <p
          className="text-sm leading-relaxed whitespace-pre-wrap break-words"
          style={{ color: 'var(--ink)' }}
        >
          {message.body}
        </p>
      </div>
    </li>
  )
}

// Small status row above the message list — flips amber/red when the
// SSE stream is reconnecting / offline, hidden when connected.
function ConnectionHint() {
  const view = useConnectionView()
  if (view.phase === 'connected') return null
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 10px',
        border: `1px solid ${view.color}`,
        color: view.color,
        fontSize: 11,
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: view.color,
        }}
      />
      {view.title}
    </div>
  )
}

function Composer({
  groupId,
  onSent,
}: {
  groupId: string
  onSent: (msg: ChatMessageDto) => void
}) {
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = body.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    sendChatMessage(groupId, trimmed)
      .then((msg) => {
        setBody('')
        onSent(msg)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not send message.')
      })
      .finally(() => setBusy(false))
  }

  return (
    <form
      onSubmit={submit}
      className="p-4 space-y-3"
      style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
    >
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Message your group…"
        maxLength={2000}
        rows={2}
        className="cyber-input"
      />
      {error && <p className="text-sm text-[color:var(--ink)]" style={{ color: 'var(--hot)' }}>{error}</p>}
      <button
        type="submit"
        disabled={busy || !body.trim()}
        className="btn-brutal disabled:opacity-50"
        style={{ width: 'auto' }}
      >
        {busy ? 'Sending…' : 'Send'}
      </button>
    </form>
  )
}
