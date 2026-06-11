import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { AuthCard } from '../ui/AuthCard.js'
import { Banner, Button, Field } from '@rallypoint/ui'
import { api } from '../api/client.js'
import { safeReturnTo } from '../lib/return-to.js'

// Two-step signin:
//   1. email + password  →  POST /signin/start  →  { challengeId }
//   2. 6-digit code      →  POST /signin/complete  →  session cookie + redirect

type Step = 'credentials' | '2fa'

export function SigninPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const returnTo = safeReturnTo(params.get('returnTo'))
  const hint = params.get('login_hint') ?? ''

  const [step, setStep] = useState<Step>('credentials')
  const [email, setEmail] = useState(hint)
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [challengeId, setChallengeId] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [info, setInfo] = useState<string | null>(null)

  async function onCredentialsSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (!email.trim() || !password) {
      setFormError('Enter your email and password.')
      return
    }
    setSubmitting(true)
    const res = await api.post<{ ok: true; challengeId: string }>(
      '/api/v1/ui/signin/start',
      { email: email.trim(), password },
    )
    setSubmitting(false)
    if (!res.ok) {
      setFormError(res.error.message)
      return
    }
    setChallengeId(res.data.challengeId)
    setStep('2fa')
    setInfo('We sent a 6-digit code to your email. Enter it below.')
  }

  async function onCodeSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (!challengeId) return
    if (!/^[0-9]{6}$/.test(code)) {
      setFormError('Enter the 6-digit code we emailed you.')
      return
    }
    setSubmitting(true)
    const res = await api.post<{ ok: true }>('/api/v1/ui/signin/complete', {
      challengeId,
      code,
    })
    setSubmitting(false)
    if (!res.ok) {
      setFormError(res.error.message)
      return
    }
    // Cookie is set by the API; jump to returnTo.
    if (returnTo.startsWith('http')) {
      window.location.href = returnTo
    } else {
      navigate(returnTo)
    }
  }

  async function onResend() {
    if (!challengeId) return
    setSubmitting(true)
    setFormError(null)
    await api.post('/api/v1/ui/signin/resend-2fa', { challengeId })
    setSubmitting(false)
    setInfo('A fresh code is on the way.')
  }

  if (step === 'credentials') {
    return (
      <AuthCard
        title="Sign in to Rallypoint ID"
        footer={
          <span>
            New here?{' '}
            <Link
              to={`/signup${returnTo === '/' ? '' : `?returnTo=${encodeURIComponent(returnTo)}`}`}
              className="underline"
              style={{ color: 'var(--ink-dim)' }}
            >
              Create an account
            </Link>
          </span>
        }
      >
        {formError ? (
          <div className="mb-4">
            <Banner tone="error">{formError}</Banner>
          </div>
        ) : null}
        <form onSubmit={onCredentialsSubmit} noValidate className="space-y-4">
          <Field
            label="Email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Field
            label="Password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div className="text-right">
            <Link
              to="/password-reset"
              className="text-xs text-[color:var(--ink-dim)] underline hover:text-[color:var(--ink)]"
            >
              Forgot password?
            </Link>
          </div>
          <Button type="submit" loading={submitting}>
            {submitting ? 'Checking…' : 'Continue'}
          </Button>
        </form>
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title="Enter your sign-in code"
      subtitle="We emailed a 6-digit code. It expires in 10 minutes."
      footer={
        <button
          type="button"
          className="underline hover:text-[color:var(--ink)]"
          onClick={() => {
            setStep('credentials')
            setChallengeId(null)
            setCode('')
            setInfo(null)
            setFormError(null)
          }}
        >
          ← Use a different account
        </button>
      }
    >
      {info ? <Banner tone="info">{info}</Banner> : null}
      {formError ? <Banner tone="error">{formError}</Banner> : null}
      <form onSubmit={onCodeSubmit} noValidate className="space-y-4">
        <Field
          label="6-digit code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          pattern="[0-9]{6}"
          required
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        />
        <Button type="submit" loading={submitting}>
          {submitting ? 'Verifying…' : 'Sign in'}
        </Button>
        <div className="mt-3 text-center text-sm">
          <button
            type="button"
            disabled={submitting}
            className="text-[color:var(--ink-dim)] underline hover:text-[color:var(--ink)] disabled:opacity-50"
            onClick={onResend}
          >
            Resend code
          </button>
        </div>
      </form>
    </AuthCard>
  )
}
