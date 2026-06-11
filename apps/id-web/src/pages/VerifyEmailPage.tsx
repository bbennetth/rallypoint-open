import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { AuthCard } from '../ui/AuthCard.js'
import { Banner, Button } from '@rallypoint/ui'
import { api } from '../api/client.js'
import { secondsRemaining } from '../lib/countdown.js'

// Slice 6a replaces the slice-2 inline-HTML /verify-email landing.
// The token comes in via ?token=rpv_... and we POST it to the
// JSON API on mount.
//
// On success we auto-redirect to /signin after a 3-second
// countdown (#43) so the user can keep moving without an extra
// click, with a "Continue now" button as an immediate override.

type Status = 'verifying' | 'success' | 'error'

const REDIRECT_DELAY_MS = 3_000

export function VerifyEmailPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const token = params.get('token') ?? ''
  const [status, setStatus] = useState<Status>('verifying')
  const [email, setEmail] = useState<string | null>(null)
  const [message, setMessage] = useState<string>('')
  const [countdown, setCountdown] = useState<number | null>(null)

  // POST the verification token on mount.
  useEffect(() => {
    let cancelled = false
    if (!token) {
      setStatus('error')
      setMessage('This verification link is malformed (missing token).')
      return () => {
        cancelled = true
      }
    }
    api.post<{ ok: true; email: string }>('/api/v1/ui/verify-email', { token }).then((res) => {
      if (cancelled) return
      if (!res.ok) {
        setStatus('error')
        setMessage(res.error.message)
        return
      }
      setEmail(res.data.email)
      setStatus('success')
      setCountdown(Math.ceil(REDIRECT_DELAY_MS / 1000))
    })
    return () => {
      cancelled = true
    }
  }, [token])

  // Drive the visible countdown + the actual redirect off the
  // same deadline so they can't desync (the deadline is the
  // source of truth; the visible count is just derived).
  useEffect(() => {
    if (status !== 'success') return
    const deadline = Date.now() + REDIRECT_DELAY_MS
    const tick = () => {
      const remaining = secondsRemaining(deadline, Date.now())
      setCountdown(remaining)
      if (remaining <= 0) {
        clearInterval(id)
        navigate('/signin', { replace: true })
      }
    }
    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  }, [status, navigate])

  if (status === 'verifying') {
    return (
      <AuthCard title="Verifying your email…" subtitle="This shouldn't take long.">
        <Banner tone="info">Talking to the server…</Banner>
      </AuthCard>
    )
  }

  if (status === 'success') {
    const seconds = countdown ?? Math.ceil(REDIRECT_DELAY_MS / 1000)
    return (
      <AuthCard
        title="Email verified"
        subtitle={`Redirecting to sign-in in ${seconds}…`}
      >
        <Banner tone="success">
          <strong>{email}</strong> is confirmed.
        </Banner>
        <Button onClick={() => navigate('/signin', { replace: true })}>
          Continue now →
        </Button>
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title="Verification failed"
      subtitle="The link may have expired or already been used."
      footer={
        <Link to="/signin" className="underline hover:text-[color:var(--ink)]">
          Back to sign in
        </Link>
      }
    >
      <Banner tone="error">{message}</Banner>
      <p className="text-sm text-[color:var(--ink-dim)]">
        If your link is expired, sign up again from the same email — we'll re-send a fresh
        verification link if the account isn't verified yet.
      </p>
    </AuthCard>
  )
}
