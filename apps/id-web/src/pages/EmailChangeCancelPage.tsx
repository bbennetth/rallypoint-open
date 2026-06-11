import { useState, type FormEvent, useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AuthCard } from '../ui/AuthCard.js'
import { Banner, Button } from '@rallypoint/ui'
import { api } from '../api/client.js'

// Cancel-email-change landing. The link comes via email to the
// OLD address; the user might not be signed in on this device.
// We auto-submit on mount IF the token looks valid; otherwise
// expose a manual button.

export function EmailChangeCancelPage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle')
  const [message, setMessage] = useState<string | null>(null)

  const onSubmit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!token) {
      setStatus('error')
      setMessage('This cancel link is malformed (missing token).')
      return
    }
    setStatus('submitting')
    const res = await api.post<{ ok: true }>('/api/v1/ui/me/email-change/cancel', {
      cancelToken: token,
    })
    if (res.ok) {
      setStatus('success')
      setMessage(null)
    } else {
      setStatus('error')
      setMessage(res.error.message)
    }
  }

  useEffect(() => {
    // Auto-fire once on mount when a token is present. Honor the
    // user's intent — the email they clicked said "click to cancel";
    // no second confirmation. onSubmit is not in the deps array
    // because it's a new closure every render and we DON'T want to
    // re-fire the cancel on every state change.
    if (token) void onSubmit()
  }, [token])

  if (status === 'success') {
    return (
      <AuthCard
        title="Email change cancelled"
        subtitle="Your account email stays as it was. No further action needed."
        footer={
          <Link to="/" className="underline hover:text-[color:var(--ink)]">
            Back to homepage
          </Link>
        }
      >
        <Banner tone="success">The pending email change has been cancelled.</Banner>
      </AuthCard>
    )
  }

  if (status === 'error') {
    return (
      <AuthCard
        title="Could not cancel the email change"
        subtitle="The link may have expired, already been used, or the change was already confirmed."
        footer={
          <Link to="/signin" className="underline hover:text-[color:var(--ink)]">
            Sign in to investigate
          </Link>
        }
      >
        <Banner tone="error">{message}</Banner>
      </AuthCard>
    )
  }

  return (
    <AuthCard title="Cancelling email change…" subtitle="Hold tight.">
      <form onSubmit={onSubmit}>
        <Banner tone="info">Submitting your cancel request.</Banner>
        <Button type="submit" loading={status === 'submitting'}>
          {status === 'submitting' ? 'Cancelling…' : 'Retry'}
        </Button>
      </form>
    </AuthCard>
  )
}
