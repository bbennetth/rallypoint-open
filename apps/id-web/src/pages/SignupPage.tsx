import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { SignupRequestSchema } from '@rallypoint/shared'
import { AuthCard } from '../ui/AuthCard.js'
import { Banner, Button, Field } from '@rallypoint/ui'
import { Turnstile } from '../ui/Turnstile.js'
import { api } from '../api/client.js'
import { apiValidationToFieldErrors, type FieldErrors, zodToFieldErrors } from '../lib/zod-errors.js'
import { returnToLabel, safeReturnTo } from '../lib/return-to.js'

export function SignupPage() {
  const [params] = useSearchParams()
  const returnTo = safeReturnTo(params.get('returnTo'))

  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    setErrors({})
    if (!captchaToken) {
      setFormError('Please complete the captcha.')
      return
    }
    const body = {
      email: email.trim(),
      name: name.trim(),
      password,
      captchaToken,
    }
    const parsed = SignupRequestSchema.safeParse(body)
    if (!parsed.success) {
      setErrors(zodToFieldErrors(parsed.error))
      return
    }
    setSubmitting(true)
    const res = await api.post<{ ok: true }>('/api/v1/ui/signup', parsed.data)
    setSubmitting(false)
    if (!res.ok) {
      if (res.error.code === 'validation_failed') {
        setErrors(apiValidationToFieldErrors(res.error.details))
      } else if (res.error.code === 'password_breached') {
        setErrors({ password: res.error.message })
      } else {
        setFormError(res.error.message)
      }
      return
    }
    setSubmitted(true)
  }

  if (submitted) {
    return (
      <AuthCard
        title="Check your email"
        subtitle="If an account was created, we sent a verification link to your inbox."
        footer={
          <span>
            Wrong email?{' '}
            <button
              type="button"
              className="underline hover:text-[color:var(--ink)]"
              onClick={() => {
                setSubmitted(false)
                setEmail('')
              }}
            >
              Try again
            </button>
          </span>
        }
      >
        <Banner tone="success">
          Verification can take a few minutes to arrive. The link expires in 24 hours.
        </Banner>
        <p className="text-sm text-[color:var(--ink-dim)]">
          Once you've verified, you'll be redirected to{' '}
          <code className="break-all text-[color:var(--ink)]" title={returnTo}>
            {returnToLabel(returnTo)}
          </code>
          .
        </p>
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title="Create your Rallypoint ID"
      subtitle="One account for every Rallypoint app."
      footer={
        <span>
          Already have an account?{' '}
          <Link
            to={`/signin${returnTo === '/' ? '' : `?returnTo=${encodeURIComponent(returnTo)}`}`}
            className="underline"
            style={{ color: 'var(--ink-dim)' }}
          >
            Sign in
          </Link>
        </span>
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
          {...(errors.email ? { error: errors.email } : {})}
        />
        <Field
          label="Name"
          autoComplete="name"
          required
          hint="Your display name across Rallypoint apps. You can change it later."
          value={name}
          onChange={(e) => setName(e.target.value)}
          {...(errors.name ? { error: errors.name } : {})}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          hint="12 characters minimum. We check against the HaveIBeenPwned breach list."
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          {...(errors.password ? { error: errors.password } : {})}
        />
        <Turnstile onToken={setCaptchaToken} onError={() => setCaptchaToken(null)} />
        <Button type="submit" loading={submitting} disabled={!captchaToken}>
          {submitting ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
    </AuthCard>
  )
}
