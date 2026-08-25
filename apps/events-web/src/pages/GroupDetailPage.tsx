import { useCallback, useEffect, useState } from 'react'
import { useAsyncTask } from '@rallypoint/web-kit'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ApiError,
  getGroup,
  getGroupLedger,
  getGroupLedgerBalances,
  listGroupLedgerExpenses,
  listGroupLists,
  listGroupListItems,
  type GroupDetailDto,
  type GroupLedgerBalancesDto,
  type GroupLedgerDto,
  type GroupLedgerExpenseDto,
  type GroupListDto,
  type ListItemDto,
} from '../lib/api.js'
import { GroupMembersEditor } from '../ui/GroupMembersEditor.js'
import { WhoIsGoingCard } from '../ui/WhoIsGoingCard.js'
import { GroupInviteCard } from '../ui/GroupInviteCard.js'
import { GroupLinkList } from '../ui/GroupLinkCard.js'
import { useRefreshBus } from '../lib/refresh-bus.js'
import { useMyEventGroups } from '../lib/useMyEventGroups.js'
import { eventGroupsHref, otherGroups } from '../lib/attendee-route.js'
import { useAttendeeOutlet } from '../ui/AttendeeChrome.js'

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; group: GroupDetailDto }
  | { status: 'error'; code: string; message: string }

export function GroupDetailPage() {
  const { userId } = useAttendeeOutlet()
  const { groupId } = useParams<{ groupId: string }>()
  const navigate = useNavigate()
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  const run = useAsyncTask()
  const load = useCallback(() => {
    if (!groupId) return
    // Generation gate: this page stays mounted while the :groupId param
    // changes (the "your other groups" links it renders), so an older
    // getGroup resolving last must not show group A's detail.
    void run(async (ctx) => {
      try {
        const group = await getGroup(groupId)
        if (ctx.stale()) return
        setState({ status: 'ready', group })
      } catch (err: unknown) {
        if (ctx.stale()) return
        if (err instanceof ApiError && err.status === 404) {
          setState({ status: 'error', code: 'not_found', message: 'Group not found.' })
        } else {
          setState({
            status: 'error',
            code: err instanceof ApiError ? err.code : 'unexpected_error',
            message: err instanceof Error ? err.message : 'Unknown error.',
          })
        }
      }
    })
  }, [groupId, run])

  useEffect(() => {
    load()
  }, [load])

  // Pull-to-refresh re-loads the group detail (members, role).
  useRefreshBus(load)

  if (state.status === 'loading') {
    return (
      <main className="page-pad flex items-center justify-center">
        <p className="text-[color:var(--ink-dim)] text-sm">Loading…</p>
      </main>
    )
  }

  if (state.status === 'error') {
    return (
      <main className="page-pad flex items-center justify-center">
        <div
          className="max-w-md w-full p-4"
          style={{
            background: 'var(--hot-soft)',
            color: 'var(--hot-text)',
            borderRadius: 'var(--radius-lg)',
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
            to="/me/events"
            className="text-sm text-[color:var(--ink-mute)] hover:text-[color:var(--ink)] underline"
          >
            ← My events
          </Link>
        </nav>

        <GroupHero group={group} viewerUserId={userId} />

        <GroupInviteCard groupName={group.name} shortCode={group.short_code} />

        <GroupMembersEditor
          group={group}
          currentUserId={userId}
          onReload={load}
          onDeleted={() => void navigate('/me/events')}
        />

        {/* Mounted unconditionally: the group payload has no event
            features, so the card relies on the endpoint 404ing (and
            rendering nothing) when the attendees toggle is off. */}
        <WhoIsGoingCard groupId={group.id} />

        <OtherGroupsCard group={group} />

        <GroupLists groupId={group.id} />

        <GroupLedger groupId={group.id} viewerUserId={userId} />
      </div>
    </main>
  )
}

// Your OTHER groups at the same event. Without this the group shell is
// a dead end: entry points route you into your first-joined group and
// nothing links onward, so a second group is reachable only by pasting
// its URL. Renders nothing when this is your only group here, and stays
// silent on load/error rather than showing a broken shell.
function OtherGroupsCard({ group }: { group: GroupDetailDto }) {
  const { state } = useMyEventGroups(group.event_id)
  if (state.status !== 'ready') return null
  const others = otherGroups(state.groups, group.id)
  if (others.length === 0) return null

  return (
    <section className="space-y-3">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <h3 className="text-xs font-medium text-[color:var(--ink-mute)]">
          {group.event_name
            ? `Your other groups at ${group.event_name}`
            : 'Your other groups at this event'}
        </h3>
        {group.event_slug && (
          <Link
            to={eventGroupsHref(group.event_slug)}
            className="text-xs text-[color:var(--ink-mute)] hover:text-[color:var(--ink)] underline"
          >
            See all
          </Link>
        )}
      </div>
      <GroupLinkList groups={others} />
    </section>
  )
}

// Festival-planner-style hero: small group/role kicker, display-font
// name, optional description, and a horizontal member-avatar rail
// underneath. The rail is read-only (taps are no-op for now); full
// edits live in `<GroupMembersEditor>` below.
function GroupHero({
  group,
  viewerUserId,
}: {
  group: GroupDetailDto
  viewerUserId: string
}) {
  // Ink kit's Group screen: `.pg-head` shell + vertical `.grp-row`
  // member list. Replaces the prior horizontal avatar-chip rail; the
  // vertical list reads as the kit's "members + status" pattern even
  // with the per-user status field unwired (status is placeholder).
  const visibleMembers = group.members.slice(0, 8)
  const overflow = group.members.length - visibleMembers.length
  return (
    <header style={{ display: 'grid', gap: 14 }}>
      <div className="pg-head" style={{ marginBottom: 0 }}>
        <div>
          <span className="eyebrow" style={{ color: 'var(--acid)' }}>
            Group
          </span>
          <h1 style={{ marginTop: 6 }}>{group.name}</h1>
          <p className="sub" style={{ marginTop: 8 }}>
            {group.members.length} {group.members.length === 1 ? 'member' : 'members'} ·
            {' '}
            {group.viewer_role}
          </p>
          {group.description && (
            <p className="sub" style={{ marginTop: 6, maxWidth: '62ch' }}>
              {group.description}
            </p>
          )}
        </div>
      </div>
      <ul
        style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}
        aria-label="Group members"
      >
        {visibleMembers.map((m) => {
          const label = m.display_name ?? m.user_id
          return (
          <li key={m.id} className="grp-row">
            <span
              aria-hidden
              style={{
                width: 36,
                height: 36,
                borderRadius: '50%',
                background: 'var(--surface-2)',
                color: 'var(--ink-dim)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 14,
                fontWeight: 700,
                flex: '0 0 auto',
              }}
            >
              {label.slice(0, 1).toUpperCase()}
            </span>
            <div className="grp-main">
              <div className="grp-top">
                <span className="grp-name">
                  {m.user_id === viewerUserId ? `You · ${label}` : label}
                </span>
              </div>
              {/* Per-member free-text status — kit shows this as the
                  primary member-row content. No backend yet → render a
                  muted placeholder so the layout reads correctly. */}
              <div className="grp-status is-empty">No status set</div>
            </div>
            <span className="grp-role">{m.role}</span>
          </li>
          )
        })}
        {overflow > 0 && (
          <li
            className="meta"
            style={{ textAlign: 'center', color: 'var(--ink-mute)', padding: '6px 0' }}
          >
            +{overflow} more member{overflow === 1 ? '' : 's'}
          </li>
        )}
      </ul>
    </header>
  )
}

// Minimal section header.
function SectionHeader({
  title,
  right,
}: {
  title: string
  right?: React.ReactNode
}) {
  return (
    <div
      className="flex items-baseline justify-between gap-2"
      style={{ borderBottom: '1px solid var(--hairline-soft)', paddingBottom: 4 }}
    >
      <h2
        style={{
          fontSize: 12,
          fontWeight: 500,
          color: 'var(--ink)',
        }}
      >
        {title}
      </h2>
      {right}
    </div>
  )
}

type ListsState =
  | { status: 'loading' }
  | { status: 'ready'; lists: GroupListDto[] }
  | { status: 'error' }

// Read-only window into the group's lists from the Lists app (#84). Loads
// on its own so a lists-api outage degrades to an inline error instead of
// breaking the whole group page.
function GroupLists({ groupId }: { groupId: string }) {
  const [state, setState] = useState<ListsState>({ status: 'loading' })

  useEffect(() => {
    let active = true
    setState({ status: 'loading' })
    listGroupLists(groupId)
      .then((lists) => {
        if (active) setState({ status: 'ready', lists })
      })
      .catch(() => {
        if (active) setState({ status: 'error' })
      })
    return () => {
      active = false
    }
  }, [groupId])

  return (
    <section
      className="p-4 space-y-3 pl-card"
    >
      <SectionHeader title="Lists" />

      {state.status === 'loading' && <p className="text-sm text-[color:var(--ink-dim)]">Loading lists…</p>}

      {state.status === 'error' && (
        <p className="text-sm text-[color:var(--ink-dim)]">Lists are unavailable right now.</p>
      )}

      {state.status === 'ready' && state.lists.length === 0 && (
        <p className="text-sm text-[color:var(--ink-dim)]">No lists for this group yet.</p>
      )}

      {state.status === 'ready' && state.lists.length > 0 && (
        <ul className="divide-y divide-white/10">
          {state.lists.map((list) => (
            <GroupListRow key={list.id} groupId={groupId} list={list} />
          ))}
        </ul>
      )}
    </section>
  )
}

type ItemsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; items: ListItemDto[] }
  | { status: 'error' }

// One list row that lazily expands to show its items. Items load on first
// expand only; a per-list error degrades inline so one bad list doesn't
// break the section.
function GroupListRow({ groupId, list }: { groupId: string; list: GroupListDto }) {
  const [expanded, setExpanded] = useState(false)
  const [items, setItems] = useState<ItemsState>({ status: 'idle' })

  const toggle = () => {
    const next = !expanded
    setExpanded(next)
    if (next && items.status === 'idle') {
      setItems({ status: 'loading' })
      listGroupListItems(groupId, list.id)
        .then((rows) => setItems({ status: 'ready', items: rows }))
        .catch(() => setItems({ status: 'error' }))
    }
  }

  return (
    <li className="py-2">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="flex items-center gap-2 text-sm">
          <span className="text-[color:var(--ink-mute)]">{expanded ? '▾' : '▸'}</span>
          {list.name}
        </span>
        <span className="text-xs font-medium text-[color:var(--ink-mute)]">{list.listType}</span>
      </button>

      {expanded && (
        <div className="mt-2 pl-5">
          {items.status === 'loading' && <p className="text-xs text-[color:var(--ink-dim)]">Loading items…</p>}
          {items.status === 'error' && (
            <p className="text-xs text-[color:var(--ink-dim)]">Items are unavailable right now.</p>
          )}
          {items.status === 'ready' && items.items.length === 0 && (
            <p className="text-xs text-[color:var(--ink-dim)]">No items in this list.</p>
          )}
          {items.status === 'ready' && items.items.length > 0 && (
            <ul className="space-y-1">
              {items.items.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-2">
                  <span
                    className={
                      item.completed
                        ? 'text-xs text-[color:var(--ink-mute)] line-through'
                        : 'text-xs text-[color:var(--ink)]'
                    }
                  >
                    {item.title}
                  </span>
                  {item.dueDate && (
                    <span className="text-[10px] font-medium text-[color:var(--ink-mute)]">
                      {new Date(item.dueDate).toLocaleDateString()}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  )
}

// --- group ledger window (slice 11) ----------------------------------
// Read-only inline view of the group's default Money ledger. Isolated
// load so a money-api outage degrades to a one-line message instead
// of breaking the whole group page. Three slots:
//   - header     ledger name + currency
//   - balance    "You're owed …", "You owe …", or "Settled up"
//   - recent     last 5 expenses (description, total, paid by, date)
// Links out to the Money app for full CRUD — events-web is read-only
// per design §8.

interface GroupLedgerState {
  status: 'loading' | 'error' | 'ready'
  ledger?: GroupLedgerDto
  expenses?: GroupLedgerExpenseDto[]
  balances?: GroupLedgerBalancesDto
}

// Sum of net_cents from the viewer's POV: positive => everyone else
// nets to "owes the viewer"; negative => viewer is in the hole.
function summariseBalance(balances: GroupLedgerBalancesDto | undefined): number {
  if (!balances) return 0
  let sum = 0
  for (const row of balances.items) sum += row.net_cents
  return sum
}

function formatCents(cents: number, currency: string | null): string {
  const code = (currency ?? 'USD').toUpperCase()
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cents / 100)
  } catch {
    // Unknown currency code → fall back to "<code> 12.34".
    return `${code} ${(cents / 100).toFixed(2)}`
  }
}

function GroupLedger({
  groupId,
  viewerUserId,
}: {
  groupId: string
  viewerUserId: string
}) {
  const [state, setState] = useState<GroupLedgerState>({ status: 'loading' })
  const run = useAsyncTask()

  useEffect(() => {
    setState({ status: 'loading' })
    // Three independent fetches; we render as soon as the ledger
    // resolves so a slow expenses query doesn't block the header.
    void run(async (ctx) => {
      const [ledger, expenses, balances] = await Promise.all([
        getGroupLedger(groupId).catch(() => null),
        listGroupLedgerExpenses(groupId).catch(() => null),
        getGroupLedgerBalances(groupId).catch(() => null),
      ])
      if (ctx.stale()) return
      if (!ledger) {
        setState({ status: 'error' })
        return
      }
      setState({
        status: 'ready',
        ledger,
        expenses: expenses ?? [],
        ...(balances ? { balances } : {}),
      })
    })
  }, [run, groupId, viewerUserId])

  return (
    <section
      className="p-4 space-y-3 pl-card"
    >
      <SectionHeader
        title="Ledger"
        right={
          state.status === 'ready' && state.ledger ? (
            <span className="text-[10px] font-medium text-[color:var(--ink-mute)]">
              {state.ledger.currency}
            </span>
          ) : null
        }
      />

      {state.status === 'loading' && <p className="text-sm text-[color:var(--ink-dim)]">Loading ledger…</p>}

      {state.status === 'error' && (
        <p className="text-sm text-[color:var(--ink-dim)]">Money is unavailable right now.</p>
      )}

      {state.status === 'ready' && state.ledger && (
        <>
          <p className="text-sm text-[color:var(--ink)]">{state.ledger.name}</p>

          <GroupLedgerBalanceSummary
            balances={state.balances}
            currency={state.ledger.currency}
            hasExpenses={(state.expenses ?? []).length > 0}
          />

          {state.expenses && state.expenses.length > 0 && (() => {
            const currency = state.ledger.currency
            return (
              <ul className="divide-y divide-white/10 pt-1">
                {state.expenses.slice(0, 5).map((exp) => (
                  <li
                    key={exp.id}
                    className="flex items-center justify-between gap-3 py-2 text-sm"
                  >
                    <span className="flex flex-col min-w-0">
                      <span className="truncate text-[color:var(--ink)]">{exp.description}</span>
                      <span className="text-[10px] font-medium text-[color:var(--ink-mute)]">
                        {exp.paidByUserId === viewerUserId ? 'you paid' : 'paid by other'} ·{' '}
                        {new Date(exp.spentAt).toLocaleDateString()}
                      </span>
                    </span>
                    <span className="mono whitespace-nowrap text-[color:var(--ink)]">
                      {formatCents(exp.totalCents, currency)}
                    </span>
                  </li>
                ))}
              </ul>
            )
          })()}

          {state.expenses && state.expenses.length > 5 && (
            <p className="text-[10px] font-medium text-[color:var(--ink-mute)]">
              {state.expenses.length - 5} older · open in Money for the full feed
            </p>
          )}
        </>
      )}
    </section>
  )
}

function GroupLedgerBalanceSummary({
  balances,
  currency,
  hasExpenses,
}: {
  balances: GroupLedgerBalancesDto | undefined
  currency: string | null
  hasExpenses: boolean
}) {
  if (!balances) {
    // Balances request failed but the ledger loaded. Silent in the UI;
    // expense list is still useful by itself.
    return null
  }
  if (!hasExpenses) {
    return (
      <p className="text-sm text-[color:var(--ink-dim)]">No expenses yet. Open in Money to add one.</p>
    )
  }
  const net = summariseBalance(balances)
  if (net === 0) {
    return <p className="text-sm text-[color:var(--ink)]">Settled up across the group.</p>
  }
  const positive = net > 0
  const amount = formatCents(Math.abs(net), currency)
  return (
    <p
      className="text-sm"
      style={{ color: positive ? 'var(--acid)' : 'var(--hot)' }}
    >
      {positive ? `Group owes you ${amount}.` : `You owe the group ${amount}.`}
    </p>
  )
}
