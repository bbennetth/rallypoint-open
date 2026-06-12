// Group-invite link + share-target helpers (#440), ported from
// festival-planner's src/lib/{inviteLink,shareInvite}.ts.
//
// Every share target has a deterministic "compose a message" deep
// link — `buildShareUrl` returns a URL and the caller navigates
// same-tab, which lets iOS universal links / Android App Links route
// to the installed app (or the web composer as a fallback). Targets
// without a web-reachable pre-fill (Messenger, Instagram, Discord)
// are intentionally absent — the Copy button covers "paste it myself".
//
// Pure helpers, unit-tested without a DOM.

export const SHARE_TARGETS = ['sms', 'whatsapp', 'x', 'line'] as const
export type ShareTarget = (typeof SHARE_TARGETS)[number]

export interface ShareInput {
  /** The invite URL — what scanners of the QR also land on. */
  url: string
  /** Message for the pre-filled compose field. `url` is appended for
   *  single-field targets (SMS / WhatsApp); split `text` + `url`
   *  params (X, Line) pass the two separately. */
  message: string
}

// Build the join link the QR encodes and the Copy button copies.
// No code yet (pre-#440 group still backfilling) → bare join page.
export function buildGroupInviteLink(input: {
  shortCode: string | null | undefined
  origin: string
}): string {
  const origin = input.origin.replace(/\/+$/, '')
  if (!input.shortCode) return `${origin}/groups/join`
  return `${origin}/groups/join?code=${input.shortCode}`
}

export function buildShareUrl(target: ShareTarget, { message, url }: ShareInput): string {
  switch (target) {
    case 'sms':
      // iOS Safari accepts `sms:?body=` (15+); Android Chrome too.
      return `sms:?body=${encodeURIComponent(`${message} ${url}`)}`
    case 'whatsapp':
      // wa.me routes to the app if installed, web compose on desktop.
      return `https://wa.me/?text=${encodeURIComponent(`${message} ${url}`)}`
    case 'x':
      // Documented Web Intents endpoint; X counts the split `url`
      // param as a t.co-shortened 23 chars.
      return (
        'https://twitter.com/intent/tweet?' +
        `text=${encodeURIComponent(message)}&url=${encodeURIComponent(url)}`
      )
    case 'line':
      // Cross-platform compose endpoint with universal-link handoff.
      return (
        'https://social-plugins.line.me/lineit/share?' +
        `url=${encodeURIComponent(url)}&text=${encodeURIComponent(message)}`
      )
  }
}
