import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { AccountShell } from '../ui/AccountShell.js'
import { Banner, Button, Field } from '@rallypoint/ui'
import { RequireAuth } from '../ui/RequireAuth.js'
import { api } from '../api/client.js'

const CONFIRM_PHRASE = 'DELETE MY ACCOUNT'

export function AccountDeletePage() {
  return (
    <RequireAuth>
      {(user) => (
        <AccountShell user={user}>
          <DeleteForm onDeleted={() => undefined} />
        </AccountShell>
      )}
    </RequireAuth>
  )
}

function DeleteForm({ onDeleted }: { onDeleted: () => void }) {
  const navigate = useNavigate()
  const [currentPassword, setCurrentPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [deletedAt, setDeletedAt] = useState<Date | null>(null)
  const [hardPurgeAt, setHardPurgeAt] = useState<Date | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (confirm !== CONFIRM_PHRASE) {
      setError(`Type "${CONFIRM_PHRASE}" exactly to confirm.`)
      return
    }
    setSubmitting(true)
    const res = await api.delete<{ ok: true; hardPurgeAt: string }>(
      '/api/v1/ui/me',
      { currentPassword, confirm: CONFIRM_PHRASE },
    )
    setSubmitting(false)
    if (!res.ok) {
      setError(res.error.message)
      return
    }
    setDeletedAt(new Date())
    setHardPurgeAt(new Date(res.data.hardPurgeAt))
    onDeleted()
  }

  if (deletedAt && hardPurgeAt) {
    return (
      <section className="rounded-lg border border-white/10 p-6" style={{ background: 'var(--surface)' }}>
        <h1 className="mb-2 text-xl font-semibold">Account deactivated</h1>
        <p className="mb-4 text-sm text-[color:var(--ink)]">
          All active sessions have been signed out. Your account data is scheduled for
          permanent deletion on{' '}
          <strong>{hardPurgeAt.toUTCString()}</strong>.
        </p>
        <p className="mb-6 text-sm text-[color:var(--ink-dim)]">
          Until then you can restore the account by contacting support at{' '}
          <a className="underline" href="https://id.rallypt.app/support">
            id.rallypt.app/support
          </a>.
        </p>
        <Button onClick={() => navigate('/')} style={{ width: 'auto' }}>Return to homepage</Button>
      </section>
    )
  }

  return (
    <section className="rounded-lg border border-white/10 p-6" style={{ background: 'var(--surface)' }}>
      <h1 className="mb-2 text-xl font-semibold">Delete your account</h1>
      <p className="mb-4 text-sm text-[color:var(--ink)]">
        This deactivates your account immediately. You have <strong>30 days</strong> to
        restore it via support before data is permanently purged.
      </p>
      <ul className="mb-6 list-disc space-y-1 pl-5 text-sm text-[color:var(--ink-dim)]">
        <li>Every active session (this one included) is signed out.</li>
        <li>Your email becomes reusable after the grace period ends.</li>
        <li>Audit-log entries survive the purge, with your user-id tombstoned.</li>
      </ul>
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
          label={`Type "${CONFIRM_PHRASE}" to confirm`}
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <Button
          type="submit"
          variant="hot"
          loading={submitting}
          disabled={!currentPassword || confirm !== CONFIRM_PHRASE}
          style={{ width: 'auto' }}
        >
          {submitting ? 'Deactivating…' : 'Delete my account'}
        </Button>
      </form>
    </section>
  )
}
