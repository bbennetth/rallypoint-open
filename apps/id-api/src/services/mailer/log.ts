import { ulid } from 'ulid'
import type { Mailer, MailerSendInput } from '../types.js'

// LogMailer — writes the payload to a sink (defaults to stdout
// via console.warn). Used in tests; never wire this up in
// production.

export interface LogMailerOptions {
  sink?: (line: string) => void
}

export function createLogMailer(opts: LogMailerOptions = {}): Mailer & { readonly sent: MailerSendInput[] } {
  const sink = opts.sink ?? ((line) => console.warn(line))
  const sent: MailerSendInput[] = []
  return {
    sent,
    async send(input: MailerSendInput) {
      sent.push(input)
      const messageId = `log-${ulid()}`
      sink(
        `[log-mailer] -> ${input.to} | ${input.subject} (messageId=${messageId})`,
      )
      return { messageId }
    },
  }
}
