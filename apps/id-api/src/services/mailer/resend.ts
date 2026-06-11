import type { Mailer, MailerSendInput } from '../types.js'

// ResendMailer — uses the Resend HTTPS API directly (no SDK
// dependency for V1; we control the wire format). Requires
// RESEND_API_KEY.

export interface ResendMailerOptions {
  apiKey: string
  from: string
  apiBase?: string // override for tests
  fetchImpl?: typeof fetch
}

interface ResendResponse {
  id?: string
  message?: string
  name?: string
}

export function createResendMailer(opts: ResendMailerOptions): Mailer {
  const base = opts.apiBase ?? 'https://api.resend.com'
  const fetchImpl = opts.fetchImpl ?? fetch
  return {
    async send(input: MailerSendInput) {
      const res = await fetchImpl(`${base}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: opts.from,
          to: input.to,
          subject: input.subject,
          html: input.html,
          text: input.text,
          headers: input.headers,
          tags: input.tags?.map((t) => ({ name: t })),
        }),
      })
      const body = (await res.json().catch(() => ({}))) as ResendResponse
      if (!res.ok || !body.id) {
        throw new Error(
          `resend send failed: status=${res.status} name=${body.name ?? ''} message=${body.message ?? ''}`,
        )
      }
      return { messageId: body.id }
    },
  }
}
