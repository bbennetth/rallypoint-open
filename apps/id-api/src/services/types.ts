// External-service adapter interfaces. Every adapter has a hosted
// impl (production) and a local-dev impl (no cloud account, no
// paid keys) — see docs/design/adapter-interfaces.md.

import type { ObjectStore } from '@rallypoint/object-store'

export interface MailerSendInput {
  to: string
  subject: string
  html: string
  text: string
  headers?: Record<string, string>
  tags?: string[]
}

export interface Mailer {
  send(input: MailerSendInput): Promise<{ messageId: string }>
}

export interface CaptchaVerifier {
  verify(input: { token: string; ip: string }): Promise<{ success: boolean; reason?: string }>
}

export interface BreachedPasswordCheck {
  isBreached(password: string): Promise<{ breached: boolean; occurrences?: number }>
}

export interface Services {
  mailer: Mailer
  captcha: CaptchaVerifier
  breachedPassword: BreachedPasswordCheck
  objectStore: ObjectStore
}

export type { ObjectStore } from '@rallypoint/object-store'
