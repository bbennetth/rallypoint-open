import type { ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  ConfirmDialog,
  Drawer,
  EmptyState,
  Table,
  useToast,
  type SortState,
  type TableColumn,
  type TableRow,
} from '@rallypoint/ui'
import {
  ApiError,
  bulkCreateInvites,
  createInvite,
  eventAttendeesCsvUrl,
  listEventAttendees,
  listEventInvites,
  removeEventAttendee,
  revokeEventInvite,
  type AttendeeDto,
  type AssignableRole,
  type MemberRole,
  type PendingInviteDto,
} from '../../lib/api.js'
import { useEventOutlet } from './_event-outlet.js'

// Phase 2 + Phase 3 owner-side Attendees tab. Uses the Phase 5 <Table>
// primitive with sortable name / email / joined / role columns. Remove
// triggers a <ConfirmDialog>; success/failure feedback flows through
// <Toaster>. Owners can filter by role.
//
// Phase 3 (platform/v-1.1, #16) layered on:
//  - Share link control (generates a viewer-role general invite code)
//  - Send invite by email Drawer (single + bulk-paste)
//  - Pending invites table with revoke
//  - Export CSV download (anchor → server CSV endpoint)

type RoleFilter = 'all' | MemberRole
type SortKey = 'name' | 'email' | 'role' | 'joined'
const INVITE_BULK_MAX = 200

export function AttendeesPage() {
  const { event, userId } = useEventOutlet()
  const toast = useToast()
  const [attendees, setAttendees] = useState<AttendeeDto[]>([])
  const [pending, setPending] = useState<PendingInviteDto[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all')
  const [sort, setSort] = useState<SortState<SortKey> | null>({
    column: 'joined',
    dir: 'desc',
  })
  const [confirmTarget, setConfirmTarget] = useState<AttendeeDto | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [shareLink, setShareLink] = useState<{ code: string; url: string } | null>(null)
  const [creatingLink, setCreatingLink] = useState(false)
  const isEditor =
    event.viewer_role === 'owner' || event.viewer_role === 'editor'
  const [removing, setRemoving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [page, pendingPage] = await Promise.all([
        listEventAttendees(event.id),
        isEditor
          ? listEventInvites(event.id)
          : Promise.resolve({ items: [] as PendingInviteDto[] }),
      ])
      setAttendees(page.items)
      setPending(pendingPage.items)
      setLoadError(null)
    } catch (err) {
      setLoadError(
        err instanceof ApiError ? err.message : 'Failed to load attendees.',
      )
    } finally {
      setLoading(false)
    }
  }, [event.id, isEditor])

  useEffect(() => {
    void load()
  }, [load])

  async function handleShareLink() {
    setCreatingLink(true)
    try {
      const inv = await createInvite(event.id, { role: 'viewer' })
      const url = `${window.location.origin}/events/join?code=${encodeURIComponent(inv.code)}`
      setShareLink({ code: inv.code, url })
      toast({ tone: 'success', body: 'Share link generated. Copy it below.' })
      // The new code is also a pending invite — reflect it in the list.
      setPending((prev) => [
        {
          id: inv.id,
          invited_email: null,
          role: inv.role,
          created_at: new Date().toISOString(),
          expires_at: inv.expires_at,
        },
        ...prev,
      ])
    } catch (err) {
      toast({
        tone: 'error',
        body: err instanceof ApiError ? err.message : 'Failed to create link.',
      })
    } finally {
      setCreatingLink(false)
    }
  }

  async function handleRevokeInvite(invite: PendingInviteDto) {
    try {
      await revokeEventInvite(event.id, invite.id)
      setPending((prev) => prev.filter((p) => p.id !== invite.id))
      if (shareLink && shareLink.code) {
        // If the user revokes the just-created share invite, drop the
        // local copy too so the displayed URL doesn't 404 silently.
        const codeMatchesId = pending.find((p) => p.id === invite.id)
        if (codeMatchesId) setShareLink(null)
      }
      toast({ tone: 'success', body: 'Invite revoked.' })
    } catch (err) {
      toast({
        tone: 'error',
        body: err instanceof ApiError ? err.message : 'Failed to revoke invite.',
      })
    }
  }

  const filtered = attendees.filter((a) => {
    if (roleFilter === 'all') return true
    return a.role === roleFilter
  })

  const columns: TableColumn<SortKey | 'actions'>[] = [
    {
      key: 'name',
      header: 'Name',
      sortable: true,
      accessor: (row) => (row.name as string) ?? '',
    },
    {
      key: 'email',
      header: 'Email',
      sortable: true,
      accessor: (row) => (row.email as string) ?? '',
    },
    {
      key: 'role',
      header: 'Role',
      sortable: true,
      accessor: (row) => (row.role as string) ?? '',
      width: 100,
    },
    {
      key: 'joined',
      header: 'Joined',
      sortable: true,
      align: 'right',
      // Accessor pulls the raw ISO string so it sorts chronologically.
      accessor: (row) => (row.joinedRaw as string) ?? '',
      width: 140,
    },
    { key: 'actions', header: '', align: 'right', width: 96 },
  ]

  const rows: TableRow<SortKey | 'actions'>[] = filtered.map((a) => {
    const isSelf = a.user_id === userId
    const isOwner = a.role === 'owner'
    const canRemove = !isSelf && !isOwner
    const label = a.display_name ?? a.email ?? a.user_id
    return {
      id: a.user_id,
      name: (
        <div className="min-w-0">
          <div className="truncate">{label}</div>
          {isSelf && (
            <div className="text-xs text-white/40">you</div>
          )}
        </div>
      ),
      email: a.email ?? <span className="text-white/40">—</span>,
      role: a.role ? (
        <span className="text-xs text-[color:var(--ink-mute)] capitalize">{a.role}</span>
      ) : (
        <span className="text-white/40">—</span>
      ),
      joined: new Date(a.joined_at).toLocaleDateString(),
      joinedRaw: a.joined_at,
      actions: canRemove ? (
        <Button
          variant="ghost"
          onClick={() => setConfirmTarget(a)}
          aria-label={`Remove ${label}`}
        >
          Remove
        </Button>
      ) : null,
    }
  })

  return (
    <main className="page-pad">
      <div className="max-w-5xl mx-auto space-y-5">
        <header className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p
              className="text-xs font-medium"
              style={{ color: 'var(--acid)' }}
            >
              Attendees
            </p>
            <h1 className="display text-2xl">{event.name}</h1>
            <p className="text-white/60 text-sm mt-1">
              People attending or invited to this event.
            </p>
          </div>
          <RoleFilterChips value={roleFilter} onChange={setRoleFilter} counts={countByRole(attendees)} />
        </header>

        {isEditor && (
          <InviteControls
            shareLink={shareLink}
            creatingLink={creatingLink}
            onShareLink={handleShareLink}
            onOpenInviteDrawer={() => setInviteOpen(true)}
            csvHref={eventAttendeesCsvUrl(event.id)}
            csvFilename={`${event.slug}-attendees-${new Date().toISOString().slice(0, 10)}.csv`}
            onCopyShareLink={() => {
              if (!shareLink) return
              void navigator.clipboard.writeText(shareLink.url).then(
                () => toast({ tone: 'success', body: 'Copied to clipboard.' }),
                () => toast({ tone: 'error', body: 'Clipboard copy failed.' }),
              )
            }}
            onDismissShareLink={() => setShareLink(null)}
          />
        )}

        {isEditor && pending.length > 0 && (
          <PendingInvitesSection pending={pending} onRevoke={handleRevokeInvite} />
        )}

        {loadError && (
          <div
            className="p-3"
            style={{
              border: '1.5px solid var(--hot)',
              background: 'color-mix(in srgb, var(--hot) 12%, transparent)',
            }}
          >
            <p className="text-sm text-white/80">{loadError}</p>
          </div>
        )}

        {loading && attendees.length === 0 && !loadError ? (
          <p className="text-sm text-white/60">Loading…</p>
        ) : attendees.length === 0 && !loadError ? (
          <EmptyState
            title="No attendees yet"
            body="Share the invite link or send invites to start filling out the list."
          />
        ) : (
          <div
            style={{
              border: '1.5px solid var(--line)',
              background: 'var(--surface)',
              padding: 4,
            }}
          >
            <Table<SortKey | 'actions'>
              columns={columns}
              rows={rows}
              sort={sort as SortState<SortKey | 'actions'> | null}
              onSortChange={(next) => setSort(next as SortState<SortKey>)}
              zebra
              emptyState={
                <EmptyState
                  compact
                  title={`No ${roleFilter === 'all' ? 'attendees' : roleFilter + 's'} match the filter`}
                />
              }
            />
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmTarget !== null}
        title="Remove from event?"
        body={
          confirmTarget && (
            <>
              <strong>{confirmTarget.display_name ?? confirmTarget.email ?? confirmTarget.user_id}</strong>{' '}
              will lose access immediately. Their group memberships stay
              intact.
            </>
          )
        }
        confirmLabel="Remove"
        confirmVariant="hot"
        busy={removing}
        onCancel={() => {
          if (!removing) setConfirmTarget(null)
        }}
        onConfirm={async () => {
          if (!confirmTarget) return
          setRemoving(true)
          try {
            await removeEventAttendee(event.id, confirmTarget.user_id)
            setAttendees((prev) =>
              prev.filter((a) => a.user_id !== confirmTarget.user_id),
            )
            toast({
              tone: 'success',
              body: 'Attendee removed.',
            })
            setConfirmTarget(null)
          } catch (err) {
            toast({
              tone: 'error',
              body: err instanceof ApiError ? err.message : 'Failed to remove attendee.',
            })
          } finally {
            setRemoving(false)
          }
        }}
      />

      <Drawer
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="Invite by email"
      >
        <BulkInviteForm
          onCancel={() => setInviteOpen(false)}
          onSubmit={async ({ emails, role }) => {
            try {
              const result = await bulkCreateInvites(event.id, { emails, role })
              toast({
                tone: 'success',
                body:
                  result.created.length === 1
                    ? '1 invite sent.'
                    : `${result.created.length} invites sent.`,
              })
              setPending((prev) => [
                ...result.created.map((c) => ({
                  id: c.id,
                  invited_email: c.email,
                  role,
                  created_at: new Date().toISOString(),
                  expires_at: c.expires_at,
                })),
                ...prev,
              ])
              setInviteOpen(false)
            } catch (err) {
              toast({
                tone: 'error',
                body: err instanceof ApiError ? err.message : 'Failed to send invites.',
              })
            }
          }}
        />
      </Drawer>
    </main>
  )
}

// ── invite controls header ───────────────────────────────────────────

function InviteControls({
  shareLink,
  creatingLink,
  onShareLink,
  onOpenInviteDrawer,
  csvHref,
  csvFilename,
  onCopyShareLink,
  onDismissShareLink,
}: {
  shareLink: { code: string; url: string } | null
  creatingLink: boolean
  onShareLink: () => void
  onOpenInviteDrawer: () => void
  csvHref: string
  csvFilename: string
  onCopyShareLink: () => void
  onDismissShareLink: () => void
}) {
  return (
    <section
      className="p-4 space-y-3"
      style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="brutal" onClick={onOpenInviteDrawer}>
          Invite by email
        </Button>
        <Button variant="ghost" onClick={onShareLink} loading={creatingLink} disabled={creatingLink}>
          {creatingLink ? 'Generating…' : 'Generate share link'}
        </Button>
        <a
          href={csvHref}
          download={csvFilename}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '6px 12px',
            border: '1.5px solid var(--line)',
            color: 'var(--ink-dim)',
            textDecoration: 'none',
            fontSize: 11,
          }}
        >
          Export CSV
        </a>
      </div>
      {shareLink && (
        <div
          className="p-3 space-y-2"
          style={{
            border: '1.5px solid var(--line)',
            background: 'var(--surface-2, color-mix(in srgb, var(--line) 30%, transparent))',
          }}
        >
          <div
            style={{ fontSize: 10, color: 'var(--ink-mute)' }}
          >
            Share this link — viewer role, 14-day expiry
          </div>
          <div className="flex items-center gap-2">
            <code className="font-mono text-xs flex-1 truncate">{shareLink.url}</code>
            <Button variant="ghost" onClick={onCopyShareLink}>
              Copy
            </Button>
            <Button variant="ghost" onClick={onDismissShareLink}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}

// ── pending invites section ───────────────────────────────────────────

function PendingInvitesSection({
  pending,
  onRevoke,
}: {
  pending: PendingInviteDto[]
  onRevoke: (invite: PendingInviteDto) => void
}) {
  return (
    <section className="space-y-2">
      <h2
        style={{ fontSize: 12, fontWeight: 500, color: 'var(--ink-dim)' }}
      >
        Pending invites ({pending.length})
      </h2>
      <ul className="divide-y divide-white/10" style={{ border: '1.5px solid var(--line)' }}>
        {pending.map((inv) => (
          <li
            key={inv.id}
            className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate">
                {inv.invited_email ?? <span className="text-white/40">Share link</span>}
              </div>
              <div className="text-xs text-white/40">
                {inv.role} · expires {new Date(inv.expires_at).toLocaleDateString()}
              </div>
            </div>
            <Button variant="ghost" onClick={() => onRevoke(inv)} aria-label="Revoke invite">
              Revoke
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ── bulk-invite form inside the Drawer ────────────────────────────────

function BulkInviteForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (input: { emails: string[]; role: AssignableRole }) => Promise<void>
  onCancel: () => void
}) {
  const [raw, setRaw] = useState('')
  const [role, setRole] = useState<AssignableRole>('viewer')
  const [submitting, setSubmitting] = useState(false)

  const parsedEmails = parseEmails(raw)
  const tooMany = parsedEmails.length > INVITE_BULK_MAX
  const empty = parsedEmails.length === 0

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault()
        if (empty || tooMany) return
        setSubmitting(true)
        try {
          await onSubmit({ emails: parsedEmails, role })
        } finally {
          setSubmitting(false)
        }
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <FormBlock label="Emails (comma-, space- or newline-separated)">
        <textarea
          required
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={6}
          className="cyber-input"
          placeholder="alice@example.com&#10;bob@example.com,carol@example.com"
        />
        <div
          style={{
            fontSize: 10,
            color: tooMany ? 'var(--hot)' : 'var(--ink-mute)',
          }}
        >
          {parsedEmails.length} recipient{parsedEmails.length === 1 ? '' : 's'}
          {tooMany ? ` — max ${INVITE_BULK_MAX} per send` : ''}
        </div>
      </FormBlock>
      <FormBlock label="Role">
        <div role="radiogroup" style={{ display: 'inline-flex', border: '1.5px solid var(--line)' }}>
          {(['viewer', 'editor'] as const).map((r, i) => {
            const active = role === r
            return (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setRole(r)}
                style={{
                  all: 'unset',
                  cursor: 'pointer',
                  padding: '6px 14px',
                  fontSize: 11,
                  borderLeft: i === 0 ? 'none' : '1.5px solid var(--line)',
                  background: active ? 'var(--acid)' : 'transparent',
                  color: active ? 'var(--bg)' : 'var(--ink-dim)',
                }}
              >
                {r}
              </button>
            )
          })}
        </div>
      </FormBlock>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
        <Button variant="ghost" type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="brutal"
          type="submit"
          disabled={submitting || empty || tooMany}
          loading={submitting}
        >
          Send invites
        </Button>
      </div>
    </form>
  )
}

function FormBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span
        style={{
          fontSize: 12,
          fontWeight: 500,
          color: 'var(--ink-dim)',
        }}
      >
        {label}
      </span>
      {children}
    </div>
  )
}

// Split a free-text paste into individual emails. Accepts comma,
// semicolon, whitespace, or newline as separators; strips empty
// entries; lower-cases for de-dup at submit-time.
function parseEmails(raw: string): string[] {
  const out = new Set<string>()
  for (const part of raw.split(/[,;\s]+/g)) {
    const trimmed = part.trim().toLowerCase()
    if (trimmed.length === 0) continue
    if (!trimmed.includes('@')) continue
    out.add(trimmed)
  }
  return Array.from(out)
}

function RoleFilterChips({
  value,
  onChange,
  counts,
}: {
  value: RoleFilter
  onChange: (v: RoleFilter) => void
  counts: Record<RoleFilter, number>
}) {
  const chips: Array<{ value: RoleFilter; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'owner', label: 'Owner' },
    { value: 'editor', label: 'Editors' },
    { value: 'viewer', label: 'Viewers' },
  ]
  return (
    <div
      role="radiogroup"
      aria-label="Filter by role"
      style={{ display: 'inline-flex', border: '1.5px solid var(--line)' }}
    >
      {chips.map((chip, i) => {
        const active = value === chip.value
        return (
          <button
            key={chip.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(chip.value)}
            style={{
              all: 'unset',
              cursor: 'pointer',
              padding: '6px 12px',
              fontSize: 11,
              borderLeft: i === 0 ? 'none' : '1.5px solid var(--line)',
              background: active ? 'var(--acid)' : 'transparent',
              color: active ? 'var(--bg)' : 'var(--ink-dim)',
            }}
          >
            {chip.label}{' '}
            <span style={{ opacity: 0.7, marginLeft: 4, fontSize: 9 }}>
              {counts[chip.value]}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function countByRole(items: AttendeeDto[]): Record<RoleFilter, number> {
  const counts: Record<RoleFilter, number> = {
    all: items.length,
    owner: 0,
    editor: 0,
    viewer: 0,
  }
  for (const a of items) {
    if (a.role === 'owner' || a.role === 'editor' || a.role === 'viewer') {
      counts[a.role] += 1
    }
  }
  return counts
}
