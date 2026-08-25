import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import type { UserInfo } from '@rallypoint/shared'
import { AccountShell } from '../ui/AccountShell.js'
import { Avatar, Banner, Button, Field } from '@rallypoint/ui'
import { RequireAuth } from '../ui/RequireAuth.js'
import { api } from '../api/client.js'
import { useAsyncTask } from '@rallypoint/web-kit'
import { isPasskeySupported, registerNewPasskey } from '../lib/webauthn.js'
import { providerMeta } from '../ui/provider-icons.js'

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

// AI & privacy — the cross-app AI-data opt-out. Stored as
// `aiTrainingOptOut` in the shared settings namespace, so every
// Rallypoint app honors it. Opting out keeps AI features working but
// stops prompt/response content (and photos) from being stored in the
// AI trace corpus — only ops telemetry (model, latency, errors) remains.
function AiPrivacySection() {
  const [optOut, setOptOut] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api
      .get<{ settings: Record<string, unknown> }>('/api/v1/ui/settings/shared')
      .then((res) => {
        if (cancelled) return
        if (res.ok) setOptOut(res.data.settings['aiTrainingOptOut'] === true)
        else setError(res.error.message)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function toggle(next: boolean) {
    setError(null)
    setSaving(true)
    const prev = optOut
    setOptOut(next)
    const res = await api.patch<{ settings: Record<string, unknown> }>(
      '/api/v1/ui/settings/shared',
      { aiTrainingOptOut: next },
    )
    setSaving(false)
    if (!res.ok) {
      setOptOut(prev)
      setError(res.error.message)
    }
  }

  return (
    <section className="mb-10 rounded-lg border border-[color:var(--line)] p-6" style={{ background: 'var(--surface)' }}>
      <h2 className="mb-1 text-lg font-medium">AI &amp; privacy</h2>
      <p className="mb-4 text-sm text-[color:var(--ink-dim)]">
        AI features (like photo scans) normally store what you sent and what the AI answered, to
        help us improve the models. Opt out to keep using AI features without your prompts, photos,
        or results being stored — only anonymous technical metrics remain.
      </p>
      {error ? (
        <div className="mb-4">
          <Banner tone="error">{error}</Banner>
        </div>
      ) : null}
      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={optOut === true}
          disabled={optOut === null || saving}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span>Don&apos;t store my AI prompts and responses</span>
      </label>
    </section>
  )
}

interface Passkey {
  id: string
  label: string
  createdAt: string
  lastUsedAt: string | null
  backedUp: boolean | null
}

function PasskeyRow({ passkey, onChanged }: { passkey: Passkey; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(passkey.label)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (!label.trim()) return
    setBusy(true)
    setError(null)
    const res = await api.patch<{ ok: true }>(
      `/api/v1/ui/webauthn/credentials/${encodeURIComponent(passkey.id)}`,
      { label: label.trim() },
    )
    setBusy(false)
    if (!res.ok) {
      setError(res.error.message)
      return
    }
    setEditing(false)
    onChanged()
  }

  async function remove() {
    setBusy(true)
    setError(null)
    const res = await api.delete<{ ok: true }>(
      `/api/v1/ui/webauthn/credentials/${encodeURIComponent(passkey.id)}`,
    )
    setBusy(false)
    if (!res.ok) {
      setError(res.error.message)
      return
    }
    onChanged()
  }

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-md border border-[color:var(--line)] p-3">
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            className="cyber-input w-full"
            value={label}
            autoFocus
            onChange={(e) => setLabel(e.target.value)}
            maxLength={64}
          />
        ) : (
          <div className="truncate font-medium">{passkey.label}</div>
        )}
        <div className="text-xs text-[color:var(--ink-dim)]">
          Added {new Date(passkey.createdAt).toLocaleDateString()}
          {passkey.lastUsedAt
            ? ` · last used ${new Date(passkey.lastUsedAt).toLocaleDateString()}`
            : ' · never used'}
        </div>
        {error ? <div className="mt-1 text-xs text-[color:var(--hot)]">{error}</div> : null}
      </div>
      {editing ? (
        <Button type="button" loading={busy} onClick={() => void save()} style={{ width: 'auto' }}>
          Save
        </Button>
      ) : (
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => setEditing(true)}
          style={{ width: 'auto' }}
        >
          Rename
        </Button>
      )}
      <Button
        type="button"
        variant="hot"
        disabled={busy}
        onClick={() => void remove()}
        style={{ width: 'auto' }}
      >
        Remove
      </Button>
    </li>
  )
}

// Passkeys — register a WebAuthn credential and use it to sign in without
// a password. Registration requires this active session.
function PasskeysSection() {
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const supported = isPasskeySupported()
  const run = useAsyncTask()

  const refetch = useCallback(
    () =>
      run(async (ctx) => {
        const res = await api.get<{ credentials: Passkey[] }>('/api/v1/ui/webauthn/credentials')
        if (ctx.stale()) return
        if (res.ok) setPasskeys(res.data.credentials)
        else setError(res.error.message)
      }),
    [run],
  )
  useEffect(() => {
    void refetch()
  }, [refetch])

  async function onAdd() {
    setBusy(true)
    setError(null)
    setInfo(null)
    const res = await registerNewPasskey()
    setBusy(false)
    if (!res.ok) {
      setError(res.error?.message ?? 'Could not add a passkey.')
      return
    }
    setInfo('Passkey added.')
    void refetch()
  }

  return (
    <section
      className="mb-10 rounded-lg border border-[color:var(--line)] p-6"
      style={{ background: 'var(--surface)' }}
    >
      <h2 className="mb-1 text-lg font-medium">Passkeys</h2>
      <p className="mb-4 text-sm text-[color:var(--ink-dim)]">
        Sign in with your fingerprint, face, or a security key — no password or emailed code.
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
      {!supported ? (
        <Banner tone="info">This browser or device doesn&apos;t support passkeys.</Banner>
      ) : (
        <>
          {passkeys && passkeys.length > 0 ? (
            <ul className="mb-4 space-y-2">
              {passkeys.map((p) => (
                <PasskeyRow key={p.id} passkey={p} onChanged={() => void refetch()} />
              ))}
            </ul>
          ) : (
            <p className="mb-4 text-sm text-[color:var(--ink-dim)]">No passkeys yet.</p>
          )}
          <Button type="button" loading={busy} onClick={() => void onAdd()} style={{ width: 'auto' }}>
            {busy ? 'Waiting…' : 'Add a passkey'}
          </Button>
        </>
      )}
    </section>
  )
}

interface LinkedIdentity {
  id: string
  provider: string
  email: string | null
  createdAt: string
  lastUsedAt: string | null
}

// Linked accounts — connect Google/Apple/GitHub for one-tap sign-in, or
// unlink one (blocked if it's the only remaining sign-in method).
function LinkedAccountsSection() {
  const [identities, setIdentities] = useState<LinkedIdentity[] | null>(null)
  const [providers, setProviders] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const run = useAsyncTask()

  const refetch = useCallback(
    () =>
      run(async (ctx) => {
        const [ids, provs] = await Promise.all([
          api.get<{ identities: LinkedIdentity[] }>('/api/v1/ui/oauth/identities'),
          api.get<{ providers: string[] }>('/api/v1/ui/oauth/providers'),
        ])
        if (ctx.stale()) return
        if (ids.ok) setIdentities(ids.data.identities)
        else setError(ids.error.message)
        if (provs.ok) setProviders(provs.data.providers)
      }),
    [run],
  )
  useEffect(() => {
    void refetch()
  }, [refetch])

  if (providers.length === 0) return null

  const linkedProviders = new Set((identities ?? []).map((i) => i.provider))
  const connectable = providers.filter((p) => !linkedProviders.has(p))

  async function unlink(id: string) {
    setBusyId(id)
    setError(null)
    const res = await api.delete<{ ok: true }>(`/api/v1/ui/oauth/identities/${encodeURIComponent(id)}`)
    setBusyId(null)
    if (!res.ok) {
      setError(res.error.message)
      return
    }
    void refetch()
  }

  return (
    <section
      className="mb-10 rounded-lg border border-[color:var(--line)] p-6"
      style={{ background: 'var(--surface)' }}
    >
      <h2 className="mb-1 text-lg font-medium">Linked accounts</h2>
      <p className="mb-4 text-sm text-[color:var(--ink-dim)]">
        Connect a social account to sign in with one tap.
      </p>
      {error ? (
        <div className="mb-4">
          <Banner tone="error">{error}</Banner>
        </div>
      ) : null}
      {identities && identities.length > 0 ? (
        <ul className="mb-4 space-y-2">
          {identities.map((i) => {
            const meta = providerMeta(i.provider)
            return (
              <li
                key={i.id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-[color:var(--line)] p-3"
              >
                <span className="inline-flex items-center gap-2 font-medium">
                  {meta ? <meta.Icon /> : null}
                  {meta?.label ?? i.provider}
                </span>
                {i.email ? (
                  <span className="truncate text-xs text-[color:var(--ink-dim)]">{i.email}</span>
                ) : null}
                <span className="flex-1" />
                <Button
                  type="button"
                  variant="hot"
                  loading={busyId === i.id}
                  onClick={() => void unlink(i.id)}
                  style={{ width: 'auto' }}
                >
                  Unlink
                </Button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="mb-4 text-sm text-[color:var(--ink-dim)]">No linked accounts yet.</p>
      )}
      {connectable.length > 0 ? (
        <div className="space-y-2">
          {connectable.map((slug) => {
            const meta = providerMeta(slug)
            if (!meta) return null
            const { label, Icon } = meta
            return (
              <Button
                key={slug}
                type="button"
                variant="ghost"
                onClick={() => {
                  window.location.href = `/api/v1/oauth/${slug}/start?link=1&returnTo=${encodeURIComponent(
                    '/account/settings',
                  )}`
                }}
                style={{ width: 'auto' }}
              >
                <span className="inline-flex items-center justify-center gap-2">
                  <Icon /> Connect {label}
                </span>
              </Button>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}

export function AccountSettingsPage() {
  return (
    <RequireAuth>
      {(user, refetch) => (
        <AccountShell user={user}>
          <h1 className="mb-6 text-2xl font-semibold">Account settings</h1>
          <AvatarSection user={user} onUserChanged={refetch} />
          <ChangeProfileSection user={user} onUserChanged={refetch} />
          <PasskeysSection />
          <LinkedAccountsSection />
          <ChangePasswordSection user={user} onUserChanged={() => undefined} />
          <ChangeEmailSection user={user} onUserChanged={() => undefined} />
          <AiPrivacySection />
        </AccountShell>
      )}
    </RequireAuth>
  )
}
