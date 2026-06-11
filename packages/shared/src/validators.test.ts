import { describe, it, expect } from 'vitest'
import {
  emailField,
  usernameField,
  personNameField,
  passwordField,
  SignupRequestSchema,
  SigninStartRequestSchema,
  UpdateMeSchema,
  VerifyEmailRequestSchema,
} from './validators.js'

describe('emailField', () => {
  it('accepts a normal email and lowercases it', () => {
    expect(emailField.parse('User@Example.com')).toBe('user@example.com')
  })

  it('rejects strings that are not emails', () => {
    expect(() => emailField.parse('not-an-email')).toThrow()
  })

  it('trims surrounding whitespace', () => {
    expect(emailField.parse('  a@b.co  ')).toBe('a@b.co')
  })

  it('rejects empty strings', () => {
    expect(() => emailField.parse('')).toThrow()
  })

  it('rejects overlong emails', () => {
    const long = 'a'.repeat(250) + '@b.co'
    expect(() => emailField.parse(long)).toThrow()
  })
})

describe('usernameField (display name)', () => {
  it('accepts free-text names with spaces, case, and unicode', () => {
    expect(usernameField.parse('Alice Jones')).toBe('Alice Jones')
    expect(usernameField.parse('héllo wörld')).toBe('héllo wörld')
    expect(usernameField.parse('admin')).toBe('admin') // no longer reserved
  })

  it('trims surrounding whitespace', () => {
    expect(usernameField.parse('  Bob  ')).toBe('Bob')
  })

  it('rejects empty / whitespace-only names', () => {
    expect(() => usernameField.parse('')).toThrow()
    expect(() => usernameField.parse('   ')).toThrow()
  })

  it('rejects names longer than 80 chars', () => {
    expect(() => usernameField.parse('a'.repeat(81))).toThrow()
  })
})

describe('personNameField (first / last)', () => {
  it('accepts a normal name and an empty string', () => {
    expect(personNameField.parse('Alice')).toBe('Alice')
    expect(personNameField.parse('')).toBe('')
  })

  it('rejects names longer than 80 chars', () => {
    expect(() => personNameField.parse('a'.repeat(81))).toThrow()
  })
})

describe('passwordField', () => {
  it('accepts a 12-char password', () => {
    expect(passwordField.parse('a'.repeat(12))).toBeTruthy()
  })

  it('rejects an 11-char password', () => {
    expect(() => passwordField.parse('a'.repeat(11))).toThrow()
  })

  it('rejects a 257-char password', () => {
    expect(() => passwordField.parse('a'.repeat(257))).toThrow()
  })
})

describe('SignupRequestSchema', () => {
  const valid = {
    email: 'user@example.com',
    name: 'Alice Jones',
    password: 'a-very-strong-password',
    captchaToken: 'tok',
  } as const

  it('accepts a well-formed body (name → username)', () => {
    const parsed = SignupRequestSchema.parse(valid)
    expect(parsed.email).toBe('user@example.com')
    expect(parsed.name).toBe('Alice Jones')
  })

  it('rejects password equal to email (case-insensitive)', () => {
    expect(() =>
      SignupRequestSchema.parse({
        ...valid,
        password: 'USER@EXAMPLE.COM',
        email: 'user@example.com',
      }),
    ).toThrow()
  })

  it('no longer rejects password equal to the name', () => {
    expect(() =>
      SignupRequestSchema.parse({ ...valid, name: 'longpassword1', password: 'longpassword1' }),
    ).not.toThrow()
  })

  it('requires a name', () => {
    const { name: _omit, ...noName } = valid
    expect(() => SignupRequestSchema.parse(noName)).toThrow()
  })

  it('requires a captchaToken', () => {
    expect(() => SignupRequestSchema.parse({ ...valid, captchaToken: '' })).toThrow()
  })

  it('rejects missing fields', () => {
    expect(() => SignupRequestSchema.parse({})).toThrow()
  })
})

describe('SigninStartRequestSchema (email-only)', () => {
  it('accepts an email + password and lowercases the email', () => {
    const parsed = SigninStartRequestSchema.parse({
      email: 'User@Example.com',
      password: 'pw',
    })
    expect(parsed.email).toBe('user@example.com')
  })

  it('rejects a non-email identifier', () => {
    expect(() => SigninStartRequestSchema.parse({ email: 'alice', password: 'pw' })).toThrow()
  })
})

describe('UpdateMeSchema', () => {
  it('accepts a username-only patch', () => {
    expect(() =>
      UpdateMeSchema.parse({ username: 'New Name', currentPassword: 'pw' }),
    ).not.toThrow()
  })

  it('accepts first/last patches', () => {
    expect(() =>
      UpdateMeSchema.parse({ firstName: 'A', lastName: 'B', currentPassword: 'pw' }),
    ).not.toThrow()
  })

  it('requires at least one of username/firstName/lastName', () => {
    expect(() => UpdateMeSchema.parse({ currentPassword: 'pw' })).toThrow()
  })
})

describe('VerifyEmailRequestSchema', () => {
  it('accepts a plausible token', () => {
    expect(
      VerifyEmailRequestSchema.parse({ token: 'rpv_abcdefghijklmnopqrstuvwxyz' }),
    ).toBeTruthy()
  })

  it('rejects too-short tokens', () => {
    expect(() => VerifyEmailRequestSchema.parse({ token: 'rpv_x' })).toThrow()
  })
})
