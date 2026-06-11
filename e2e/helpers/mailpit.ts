// Mailpit REST API helpers (dev stack, http://localhost:8025). The dev
// stack routes all outbound mail to Mailpit, so the sign-in 2FA code
// lands here. The code appears in both the subject ("Your Rallypoint ID
// sign-in code: 123456") and the body — we read the subject first since
// it's present in the list response (no per-message fetch needed).

const MAILPIT_BASE = process.env.MAILPIT_BASE_URL ?? 'http://localhost:8025'
const CODE_RE = /\b(\d{6})\b/

interface MailpitListMessage {
  ID: string
  Subject: string
  Created: string
}

interface MailpitListResponse {
  messages: MailpitListMessage[]
}

interface MailpitMessage {
  Text?: string
  HTML?: string
  Subject?: string
}

// Delete every message. Call before triggering a send so the code we
// later read is guaranteed to be the fresh one, not a stale leftover.
export async function clearMailpit(): Promise<void> {
  const res = await fetch(`${MAILPIT_BASE}/api/v1/messages`, { method: 'DELETE' })
  if (!res.ok) {
    throw new Error(`mailpit clear failed: ${res.status} ${res.statusText}`)
  }
}

async function fetchMessageBody(id: string): Promise<string> {
  const res = await fetch(`${MAILPIT_BASE}/api/v1/message/${id}`)
  if (!res.ok) return ''
  const msg = (await res.json()) as MailpitMessage
  return `${msg.Subject ?? ''}\n${msg.Text ?? ''}\n${msg.HTML ?? ''}`
}

// Poll Mailpit for the newest message addressed to `recipient` and pull
// the 6-digit code out of it. Throws on timeout — a missing code is a
// real test failure (the sign-in email never arrived).
export async function waitForSigninCode(
  recipient: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 15_000
  const pollMs = opts.pollMs ?? 500
  const deadline = Date.now() + timeoutMs
  const query = encodeURIComponent(`to:${recipient}`)

  let lastSeen = 0
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT_BASE}/api/v1/search?query=${query}`)
    if (res.ok) {
      const body = (await res.json()) as MailpitListResponse
      const newest = body.messages?.[0]
      if (newest) {
        lastSeen = body.messages.length
        const fromSubject = CODE_RE.exec(newest.Subject)
        if (fromSubject) return fromSubject[1]!
        const fromBody = CODE_RE.exec(await fetchMessageBody(newest.ID))
        if (fromBody) return fromBody[1]!
      }
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for a sign-in code emailed to ` +
      `${recipient} (saw ${lastSeen} message(s) but no 6-digit code)`,
  )
}
