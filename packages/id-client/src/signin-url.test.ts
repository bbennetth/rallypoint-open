import { describe, it, expect } from 'vitest'
import { signinUrl, signupUrl } from './signin-url.js'

describe('signinUrl', () => {
  it('builds a URL with just the base', () => {
    expect(signinUrl({ hostedUiUrl: 'https://id.rallypt.app' })).toBe(
      'https://id.rallypt.app/signin',
    )
  })

  it('strips trailing slashes on the base', () => {
    expect(signinUrl({ hostedUiUrl: 'https://id.rallypt.app///' })).toBe(
      'https://id.rallypt.app/signin',
    )
  })

  it('appends returnTo as a query string', () => {
    expect(
      signinUrl({
        hostedUiUrl: 'https://id.rallypt.app',
        returnTo: 'https://app.example.com/dashboard',
      }),
    ).toBe(
      'https://id.rallypt.app/signin?returnTo=https%3A%2F%2Fapp.example.com%2Fdashboard',
    )
  })

  it('appends loginHint as login_hint', () => {
    expect(
      signinUrl({ hostedUiUrl: 'https://id.rallypt.app', loginHint: 'alice@example.com' }),
    ).toBe('https://id.rallypt.app/signin?login_hint=alice%40example.com')
  })
})

describe('signupUrl', () => {
  it('builds a URL with just the base', () => {
    expect(signupUrl({ hostedUiUrl: 'https://id.rallypt.app' })).toBe(
      'https://id.rallypt.app/signup',
    )
  })

  it('appends returnTo', () => {
    expect(
      signupUrl({
        hostedUiUrl: 'https://id.rallypt.app',
        returnTo: 'https://app.example.com/welcome',
      }),
    ).toContain('returnTo=')
  })
})
