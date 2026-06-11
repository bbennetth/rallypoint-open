import { useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import type { UserInfo } from '@rallypoint/shared'
import { AccountShell } from '../ui/AccountShell.js'
import { Avatar, Banner, Button, Field } from '@rallypoint/ui'
import { RequireAuth } from '../ui/RequireAuth.js'
import { api } from '../api/client.js'

// Three independent sub-forms, each with its own reauth field and
// state. Sharing a single form would make field validation harder
// (current password applies to all but the user only wants to
// commit one section at a time).

interface SectionProps {
  user: UserInfo
  onUserChanged: () => void
}

function ChangePasswordSection({ onUserChanged }: SectionProps) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setInfo(null)
    if (newPassword.length < 12) {
      setError('New password must be at least 12 characters.')
      return
    }
    setSubmitting(true)
    const res = await api.post<{ ok: true }>('/api/v1/ui/me/change-password', {
      currentPassword,
      newPassword,
    })
    setSubmitting(false)
    if (!res.ok) {
      setError(res.error.message)
      return
    }
    setInfo('Password updated. Other devices have been signed out.')
    setCurrentPassword('')
    setNewPassword('')
    onUserChanged()
  }

  return (
    <section className="mb-10 rounded-lg border border-[color:var(--line)] p-6" style={{ background: 'var(--surface)' }}>
      <h2 className="mb-1 text-lg font-medium">Change password</h2>
      <p className="mb-4 text-sm text-[color:var(--ink-dim)]">
        We'll sign out every other device when you update this.
      </p>
      {info ? (
        <div className="mb-4">
          <Banner tone="success">{info}</Banner>
        </div>
      ) : null}
      {error ? (
        <div className="mb-4">
          <Banner tone="error">{error}</Banner>
        </div>
      ) : null}
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <Field
          label="Current password"
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
        />
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          hint="12 characters minimum. HIBP-checked."
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />
        <Button type="submit" loading={submitting} style={{ width: 'auto' }}>
          {submitting ? 'Updating…' : 'Update password'}
        </Button>
      </form>
    </section>
  )
}

function ChangeEmailSection({ user }: SectionProps) {
  const [newEmail, setNewEmail] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setInfo(null)
    if (!newEmail.trim()) {
      setError('Enter the new email address.')
      return
    }
    setSubmitting(true)
    const res = await api.post<{ ok: true }>('/api/v1/ui/me/email-change/request', {
      newEmail: newEmail.trim(),
      currentPassword,
    })
    setSubmitting(false)
    if (!res.ok) {
      setError(res.error.message)
      return
    }
    setInfo(
      'Check your inbox: we sent a confirmation link to the new address and a "cancel" notice to the old one.',
    )
    setNewEmail('')
    setCurrentPassword('')
  }

  return (
    <section className="mb-10 rounded-lg border border-[color:var(--line)] p-6" style={{ background: 'var(--surface)' }}>
      <h2 className="mb-1 text-lg font-medium">Change email</h2>
      <p className="mb-4 text-sm text-[color:var(--ink-dim)]">
        Current: <code className="text-[color:var(--ink)]">{user.email}</code>. We'll email the new
        address to confirm and the old address with a cancel link.
      </p>
      {info ? (
        <div className="mb-4">
          <Banner tone="success">{info}</Banner>
        </div>
      ) : null}
      {error ? (
        <div className="mb-4">
          <Banner tone="error">{error}</Banner>
        </div>
      ) : null}
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <Field
          label="New email"
          type="email"
          autoComplete="email"
          required
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
        />
        <Field
          label="Current password"
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
        />
        <Button type="submit" loading={submitting} style={{ width: 'auto' }}>
          {submitting ? 'Sending…' : 'Request email change'}
        </Button>
      </form>
    </section>
  )
}

function AvatarSection({ user, onUserChanged }: SectionProps) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    // Clear the input so re-picking the same file fires onChange again.
    e.target.value = ''
    if (!file) return
    setError(null)
    setInfo(null)
    setBusy(true)
    const res = await api.uploadAvatar(file)
    setBusy(false)
    if (!res.ok) {
      setError(res.error.message)
      return
    }
    setInfo('Avatar updated.')
    onUserChanged()
  }

  async function onRemove() {
    setError(null)
    setInfo(null)
    setBusy(true)
    const res = await api.delete<UserInfo>('/api/v1/ui/me/avatar')
    setBusy(false)
    if (!res.ok) {
      setError(res.error.message)
      return
    }
    setInfo('Avatar removed.')
    onUserChanged()
  }

  return (
    <section className="mb-10 rounded-lg border border-[color:var(--line)] p-6" style={{ background: 'var(--surface)' }}>
      <h2 className="mb-1 text-lg font-medium">Avatar</h2>
      <p className="mb-4 text-sm text-[color:var(--ink-dim)]">
        PNG, JPEG, or WebP up to 25&nbsp;MB. Large photos are automatically
        resized to a 512&nbsp;px square before upload. HEIC files (iPhone default)
        must be converted to JPEG or PNG first.
      </p>
      {info ? (
        <div className="mb-4">
          <Banner tone="success">{info}</Banner>
        </div>
      ) : null}
      {error ? (
        <div className="mb-4">
          <Banner tone="error">{error}</Banner>
        </div>
      ) : null}
      <div className="flex items-center gap-4">
        {/* The Avatar is decorative (alt="" / aria-hidden); name the wrapper so
            screen readers identify it as the user's current avatar (#301). */}
        <span role="img" aria-label="Current avatar" style={{ display: 'inline-flex' }}>
          <Avatar
            size={64}
            pictureUrl={user.picture}
            name={user.name}
            firstName={user.first_name}
            lastName={user.last_name}
            email={user.email}
          />
        </span>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={onPick}
        />
        <Button
          type="button"
          loading={busy}
          onClick={() => fileRef.current?.click()}
          style={{ width: 'auto' }}
        >
          {busy ? 'Working…' : user.picture ? 'Replace' : 'Upload'}
        </Button>
        {user.picture ? (
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={onRemove}
            style={{ width: 'auto' }}
          >
            Remove
          </Button>
        ) : null}
      </div>
    </section>
  )
}

function ChangeProfileSection({ user, onUserChanged }: SectionProps) {
  const [displayName, setDisplayName] = useState(user.name)
  const [firstName, setFirstName] = useState(user.first_name ?? '')
  const [lastName, setLastName] = useState(user.last_name ?? '')
  const [currentPassword, setCurrentPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const dirty =
    displayName !== user.name ||
    firstName !== (user.first_name ?? '') ||
    lastName !== (user.last_name ?? '')

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setInfo(null)
    if (!dirty) {
      setInfo('No changes.')
      return
    }
    if (!displayName.trim()) {
      setError('Display name is required.')
      return
    }
    setSubmitting(true)
    const body: Record<string, unknown> = { currentPassword }
    if (displayName !== user.name) body.username = displayName.trim()
    // Empty string clears the name server-side (`firstName || null`).
    if (firstName !== (user.first_name ?? '')) body.firstName = firstName.trim()
    if (lastName !== (user.last_name ?? '')) body.lastName = lastName.trim()
    const res = await api.patch<{ ok: true }>('/api/v1/ui/me', body)
    setSubmitting(false)
    if (!res.ok) {
      setError(res.error.message)
      return
    }
    setInfo('Profile updated.')
    setCurrentPassword('')
    onUserChanged()
  }

  return (
    <section className="mb-10 rounded-lg border border-[color:var(--line)] p-6" style={{ background: 'var(--surface)' }}>
      <h2 className="mb-1 text-lg font-medium">Profile</h2>
      <p className="mb-4 text-sm text-[color:var(--ink-dim)]">
        Your display name is shown across Rallypoint apps. First and last name are optional.
      </p>
      {info ? (
        <div className="mb-4">
          <Banner tone="success">{info}</Banner>
        </div>
      ) : null}
      {error ? (
        <div className="mb-4">
          <Banner tone="error">{error}</Banner>
        </div>
      ) : null}
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <Field
          label="Display name"
          autoComplete="nickname"
          required
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <Field
          label="First name"
          autoComplete="given-name"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
        />
        <Field
          label="Last name"
          autoComplete="family-name"
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
        />
        <Field
          label="Current password"
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
        />
        <Button type="submit" loading={submitting} disabled={!dirty || !currentPassword} style={{ width: 'auto' }}>
          {submitting ? 'Saving…' : 'Save changes'}
        </Button>
      </form>
    </section>
  )
}

export function AccountSettingsPage() {
  return (
    <RequireAuth>
      {(user) => (
        <AccountShell user={user}>
          <h1 className="mb-6 text-2xl font-semibold">Account settings</h1>
          <AvatarSection user={user} onUserChanged={() => window.location.reload()} />
          <ChangeProfileSection
            user={user}
            onUserChanged={() => window.location.reload()}
          />
          <ChangePasswordSection user={user} onUserChanged={() => undefined} />
          <ChangeEmailSection user={user} onUserChanged={() => undefined} />
        </AccountShell>
      )}
    </RequireAuth>
  )
}
