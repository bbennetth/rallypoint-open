import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AuthCard } from '../ui/AuthCard.js'
import { Banner } from '@rallypoint/ui'
import { api } from '../api/client.js'

// Email-change confirm landing. The link comes via email to the
// NEW address. The user MUST be signed in (the API checks
// session.userId === row.userId); we send them to /signin if not.

export function EmailChangeConfirmPage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [status, setStatus] = useState<'submitting' | 'success' | 'error' | 'unauthenticated'>(
    'submitting',
  )
  const [email, setEmail] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!token) {
      setStatus('error')
      setMessage('Missing token.')
      return () => {
        cancelled = true
      }
    }
    api
      .post<{ ok: true; email: string }>('/api/v1/ui/me/email-change/confirm', { token })
      .then((res) => {
        if (cancelled) return
        if (res.ok) {
          setEmail(res.data.email)
          setStatus('success')
        } else if (res.status === 401) {
          setStatus('unauthenticated')
        } else {
          setMessage(res.error.message)
          setStatus('error')
        }
      })
    return () => {
      cancelled = true
    }
  }, [token])

  if (status === 'submitting') {
    return (
      <AuthCard title="Confirming your new email…">
        <Banner tone="info">Just a moment.</Banner>
      </AuthCard>
    )
  }
  if (status === 'unauthenticated') {
    return (
      <AuthCard
        title="Sign in to finish"
        subtitle="We need to confirm it's still you."
        footer={
          <Link
            to={`/signin?returnTo=${encodeURIComponent('/account/email-change/confirm?token=' + token)}`}
            className="underline hover:text-[color:var(--ink)]"
          >
            Continue to sign in
          </Link>
        }
      >
        <Banner tone="info">
          You'll be redirected back to this page after signing in to complete the email
          change.
        </Banner>
      </AuthCard>
    )
  }
  if (status === 'success') {
    return (
      <AuthCard
        title="Email updated"
        subtitle="Future sign-in codes and account notifications will go to your new address."
        footer={
          <Link to="/account/settings" className="underline hover:text-[color:var(--ink)]">
            Back to account settings
          </Link>
        }
      >
        <Banner tone="success">
          Confirmed: <strong>{email}</strong>
        </Banner>
      </AuthCard>
    )
  }
  return (
    <AuthCard
      title="Confirmation failed"
      footer={
        <Link to="/account/settings" className="underline hover:text-[color:var(--ink)]">
          Back to account settings
        </Link>
      }
    >
      <Banner tone="error">{message ?? 'Unknown error.'}</Banner>
    </AuthCard>
  )
}
