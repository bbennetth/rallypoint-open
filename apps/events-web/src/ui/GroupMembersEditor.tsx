import { useState } from 'react'
import {
  ApiError,
  createGroupInvite,
  deleteGroup,
  patchGroup,
  removeGroupMember,
  setGroupRole,
  transferGroup,
  type AssignableGroupRole,
  type GroupDetailDto,
  type GroupInviteResult,
  type PatchGroupInput,
} from '../lib/api.js'

function formatDate(d: string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString(undefined, { dateStyle: 'long' })
}

interface Props {
  group: GroupDetailDto
  currentUserId: string
  onReload: () => void
  onDeleted: () => void
}

export function GroupMembersEditor({ group, currentUserId, onReload, onDeleted }: Props) {
  const canManage = group.viewer_role === 'owner'
  const canEdit = group.viewer_role === 'owner' || group.viewer_role === 'sidekick'

  return (
    <div className="space-y-6">
      {canEdit && <EditForm group={group} onSaved={onReload} />}

      <MembersList
        group={group}
        currentUserId={currentUserId}
        canManage={canManage}
        onReload={onReload}
      />

      {canEdit && <InviteSection groupId={group.id} />}

      {canManage && (
        <>
          <TransferSection groupId={group.id} onTransferred={onReload} />
          <DangerZone groupId={group.id} onDeleted={onDeleted} />
        </>
      )}
    </div>
  )
}

// --- Edit form -------------------------------------------------------

function EditForm({ group, onSaved }: { group: GroupDetailDto; onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(group.name)
  const [description, setDescription] = useState(group.description ?? '')
  const [startDate, setStartDate] = useState(group.start_date ?? '')
  const [endDate, setEndDate] = useState(group.end_date ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const fields: PatchGroupInput = {
      ...(name.trim() !== group.name ? { name: name.trim() } : {}),
      ...(description.trim() !== (group.description ?? '')
        ? { description: description.trim() }
        : {}),
      ...(startDate !== (group.start_date ?? '') ? { startDate } : {}),
      ...(endDate !== (group.end_date ?? '') ? { endDate } : {}),
    }
    if (Object.keys(fields).length === 0) {
      setOpen(false)
      return
    }
    setSaving(true)
    try {
      await patchGroup(group.id, fields)
      setOpen(false)
      onSaved()
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.code === 'group_name_taken'
            ? 'Another group in this event already uses that name.'
            : err.message
          : 'Save failed.',
      )
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-ghost" style={{ width: 'auto' }}>
        Edit group
      </button>
    )
  }

  return (
    <form onSubmit={(e) => void handleSave(e)} className="space-y-3">
      {error && (
        <div
          className="p-3 text-sm text-[color:var(--ink)]"
          style={{
            border: '1.5px solid var(--hot)',
            background: 'color-mix(in srgb, var(--hot) 12%, transparent)',
          }}
        >
          {error}
        </div>
      )}
      <div className="space-y-1">
        <label htmlFor="group-name" className="block text-xs font-medium text-[color:var(--ink-mute)]">
          Name
        </label>
        <input
          id="group-name"
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full cyber-input"
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="group-description" className="block text-xs font-medium text-[color:var(--ink-mute)]">
          Description
        </label>
        <textarea
          id="group-description"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full resize-y cyber-input"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label htmlFor="group-start" className="block text-xs font-medium text-[color:var(--ink-mute)]">
            Start date
          </label>
          <input
            id="group-start"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-full cyber-input"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="group-end" className="block text-xs font-medium text-[color:var(--ink-mute)]">
            End date
          </label>
          <input
            id="group-end"
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-full cyber-input"
          />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={saving} className="btn-brutal" style={{ width: 'auto' }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-sm text-[color:var(--ink-dim)] hover:text-[color:var(--ink)] transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

// --- Members list ----------------------------------------------------

function MembersList({
  group,
  currentUserId,
  canManage,
  onReload,
}: {
  group: GroupDetailDto
  currentUserId: string
  canManage: boolean
  onReload: () => void
}) {
  const [busyUserId, setBusyUserId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function changeRole(userId: string, role: AssignableGroupRole) {
    setError(null)
    setBusyUserId(userId)
    try {
      await setGroupRole(group.id, userId, role)
      onReload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Role change failed.')
    } finally {
      setBusyUserId(null)
    }
  }

  async function remove(userId: string, isSelf: boolean) {
    const prompt = isSelf
      ? 'Leave this group?'
      : 'Remove this member from the group?'
    if (!confirm(prompt)) return
    setError(null)
    setBusyUserId(userId)
    try {
      await removeGroupMember(group.id, userId)
      onReload()
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.code === 'group_owner_must_transfer'
            ? 'Transfer ownership before leaving the group.'
            : err.message
          : 'Failed.',
      )
    } finally {
      setBusyUserId(null)
    }
  }

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium text-[color:var(--ink-mute)]">
        Members ({group.members.length})
      </h3>
      {error && (
        <div
          className="p-3 text-sm text-[color:var(--ink)]"
          style={{
            border: '1.5px solid var(--hot)',
            background: 'color-mix(in srgb, var(--hot) 12%, transparent)',
          }}
        >
          {error}
        </div>
      )}
      <ul className="divide-y divide-[color:var(--line)]" style={{ border: '1px solid var(--line)' }}>
        {group.members.map((m) => {
          const isSelf = m.user_id === currentUserId
          const isOwner = m.role === 'owner'
          const busy = busyUserId === m.user_id
          return (
            <li
              key={m.id}
              className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
            >
              <div className="min-w-0">
                <p className="mono truncate">
                  {m.user_id}
                  {isSelf && <span className="ml-2 text-xs text-[color:var(--ink-mute)]">(you)</span>}
                </p>
                <p className="text-xs text-[color:var(--ink-mute)]">joined {formatDate(m.joined_at)}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {canManage && !isOwner && !isSelf ? (
                  <select
                    value={m.role}
                    disabled={busy}
                    onChange={(e) =>
                      void changeRole(m.user_id, e.target.value as AssignableGroupRole)
                    }
                    className="cyber-input disabled:opacity-50"
                    style={{ width: 'auto' }}
                  >
                    <option value="sidekick">sidekick</option>
                    <option value="member">member</option>
                  </select>
                ) : (
                  <span className="chip" style={{ color: 'var(--ink-dim)' }}>
                    {m.role}
                  </span>
                )}
                {isSelf && !isOwner && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void remove(m.user_id, true)}
                    className="btn-ghost"
                    style={{ width: 'auto' }}
                  >
                    Leave
                  </button>
                )}
                {canManage && !isSelf && !isOwner && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void remove(m.user_id, false)}
                    className="btn-ghost"
                    style={{ width: 'auto', color: 'var(--hot)', borderColor: 'var(--hot)' }}
                  >
                    Remove
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// --- Invite section --------------------------------------------------

function InviteSection({ groupId }: { groupId: string }) {
  const [email, setEmail] = useState('')
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<GroupInviteResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setCreating(true)
    try {
      const invite = await createGroupInvite(groupId, {
        ...(email.trim() ? { invitedEmail: email.trim() } : {}),
      })
      setCreated(invite)
      setEmail('')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create invite.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="p-4 space-y-3" style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}>
      <h3 className="text-xs font-medium text-[color:var(--ink-mute)]">Invite someone</h3>
      {error && <p className="text-sm text-[color:var(--ink)]" style={{ color: 'var(--hot)' }}>{error}</p>}
      {created ? (
        <div className="p-3 space-y-1" style={{ border: '1.5px solid var(--line)', background: 'var(--surface-2)' }}>
          <p className="text-xs text-[color:var(--ink-dim)]">Invite created — share this code:</p>
          <p className="text-sm break-all" style={{ fontFamily: 'var(--font-mono)', color: 'var(--ink)' }}>{created.code}</p>
          <p className="text-xs text-[color:var(--ink-mute)]">
            Expires{' '}
            {new Date(created.expires_at).toLocaleDateString(undefined, {
              dateStyle: 'medium',
            })}
          </p>
          <button
            type="button"
            onClick={() => setCreated(null)}
            className="text-xs text-[color:var(--ink-mute)] hover:text-[color:var(--ink-dim)] underline"
          >
            Create another
          </button>
        </div>
      ) : (
        <form onSubmit={(e) => void handleCreate(e)} className="space-y-3">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email (optional)"
            className="w-full cyber-input"
          />
          <button type="submit" disabled={creating} className="btn-brutal" style={{ width: 'auto' }}>
            {creating ? 'Creating…' : 'Create invite'}
          </button>
        </form>
      )}
    </div>
  )
}

// --- Transfer section ------------------------------------------------

function TransferSection({
  groupId,
  onTransferred,
}: {
  groupId: string
  onTransferred: () => void
}) {
  const [newOwnerUserId, setNewOwnerUserId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleTransfer(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await transferGroup(groupId, newOwnerUserId.trim())
      setNewOwnerUserId('')
      onTransferred()
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.code === 'transfer_target_not_member'
            ? 'The new owner must already be a member of this group.'
            : err.message
          : 'Transfer failed.',
      )
      setSubmitting(false)
    }
  }

  return (
    <div className="p-4 space-y-3" style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}>
      <h3 className="text-xs font-medium text-[color:var(--ink-mute)]">Transfer ownership</h3>
      <p className="text-xs text-[color:var(--ink-dim)]">
        The new owner must already be a member. You will become a sidekick after the
        transfer.
      </p>
      {error && <p className="text-sm text-[color:var(--ink)]" style={{ color: 'var(--hot)' }}>{error}</p>}
      <form onSubmit={(e) => void handleTransfer(e)} className="space-y-3">
        <input
          type="text"
          required
          value={newOwnerUserId}
          onChange={(e) => setNewOwnerUserId(e.target.value)}
          placeholder="New owner user ID"
          className="w-full cyber-input"
        />
        <button
          type="submit"
          disabled={submitting}
          className="btn-ghost"
          style={{ width: 'auto' }}
        >
          {submitting ? 'Transferring…' : 'Transfer ownership'}
        </button>
      </form>
    </div>
  )
}

// --- Danger zone -----------------------------------------------------

function DangerZone({ groupId, onDeleted }: { groupId: string; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false)

  async function handleDelete() {
    if (!confirm('Delete this group? This cannot be undone.')) return
    setDeleting(true)
    try {
      await deleteGroup(groupId)
      onDeleted()
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Delete failed.')
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium text-[color:var(--ink-mute)]">Danger zone</h3>
      <button
        type="button"
        disabled={deleting}
        onClick={() => void handleDelete()}
        className="btn-hot"
        style={{ width: 'auto' }}
      >
        {deleting ? 'Deleting…' : 'Delete group'}
      </button>
    </div>
  )
}
