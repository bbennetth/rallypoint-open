import { describe, it, expect } from 'vitest'
import { renderVerifyEmail } from './verify-email.js'

describe('renderVerifyEmail', () => {
  const base = {
    username: 'alice',
    link: 'https://id.example.com/verify-email?token=rpv_xyz',
    expiresAt: new Date('2026-01-01T00:00:00.000Z'),
  }

  it('includes the link verbatim in both html and text', () => {
    const out = renderVerifyEmail(base)
    expect(out.text).toContain(base.link)
    expect(out.html).toContain(base.link)
  })

  it('escapes HTML-injecting usernames in the html output', () => {
    const out = renderVerifyEmail({ ...base, username: 'alice<script>' })
    expect(out.html).not.toContain('<script>')
    expect(out.html).toContain('&lt;script&gt;')
  })

  it('shows a stable subject line', () => {
    const out = renderVerifyEmail(base)
    expect(out.subject).toMatch(/Rallypoint ID/)
  })
})
