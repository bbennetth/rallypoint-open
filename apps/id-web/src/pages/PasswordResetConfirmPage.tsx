import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AuthCard } from '../ui/AuthCard.js'
import { Banner, Button, Field } from '@rallypoint/ui'
import { api } from '../api/client.js'

export function PasswordResetConfirmPage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [newPassword, setNewPassword] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    setFieldError(null)
    if (!token) {
      setFormError('This reset link is malformed (missing token).')
      return
    }
    if (newPassword.length < 12) {
      setFieldError('Password must be at least 12 characters.')
      return
    }
    setSubmitting(true)
    const res = await api.post<{ ok: true }>('/api/v1/ui/password-reset/confirm', {
      token,
      newPassword,
    })
    setSubmitting(false)
    if (!res.ok) {
      if (res.error.code === 'password_breached') {
        setFieldError(res.error.message)
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
        title="Password set"
        subtitle="All devices have been signed out. Sign in again with your new password."
        footer={
          <Link to="/signin" className="underline hover:text-[color:var(--ink)]">
            Continue to sign in
          </Link>
        }
      >
        <Banner tone="success">Your Rallypoint ID password has been changed.</Banner>
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title="Choose a new password"
      subtitle="12 characters minimum. We check against the HaveIBeenPwned breach list."
      footer={
        <Link to="/signin" className="underline hover:text-[color:var(--ink)]">
          Back to sign in
        </Link>
      }
    >
      {formError ? <Banner tone="error">{formError}</Banner> : null}
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          {...(fieldError ? { error: fieldError } : {})}
        />
        <Button type="submit" loading={submitting}>
          {submitting ? 'Setting password…' : 'Set new password'}
        </Button>
      </form>
    </AuthCard>
  )
}
