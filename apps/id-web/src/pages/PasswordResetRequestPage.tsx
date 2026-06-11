import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { AuthCard } from '../ui/AuthCard.js'
import { Banner, Button, Field } from '@rallypoint/ui'
import { Turnstile } from '../ui/Turnstile.js'
import { api } from '../api/client.js'

export function PasswordResetRequestPage() {
  const [email, setEmail] = useState('')
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (!captchaToken) {
      setFormError('Please complete the captcha.')
      return
    }
    if (!email.trim()) {
      setFormError('Enter your email.')
      return
    }
    setSubmitting(true)
    const res = await api.post<{ ok: true }>('/api/v1/ui/password-reset/request', {
      email: email.trim(),
      captchaToken,
    })
    setSubmitting(false)
    if (!res.ok) {
      setFormError(res.error.message)
      return
    }
    setSubmitted(true)
  }

  if (submitted) {
    return (
      <AuthCard
        title="Check your email"
        subtitle="If an account exists for that email, we've sent a reset link."
        footer={
          <Link to="/signin" className="underline hover:text-[color:var(--ink)]">
            Back to sign in
          </Link>
        }
      >
        <Banner tone="success">
          The reset link expires in 1 hour and works exactly once.
        </Banner>
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title="Reset your password"
      subtitle="We'll email you a link to set a new password."
      footer={
        <Link to="/signin" className="underline hover:text-[color:var(--ink)]">
          Back to sign in
        </Link>
      }
    >
      {formError ? <Banner tone="error">{formError}</Banner> : null}
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Turnstile onToken={setCaptchaToken} onError={() => setCaptchaToken(null)} />
        <Button type="submit" loading={submitting} disabled={!captchaToken}>
          {submitting ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>
    </AuthCard>
  )
}
