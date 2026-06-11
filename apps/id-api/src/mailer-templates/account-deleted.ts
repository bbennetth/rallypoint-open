import { escapeHtml } from './_escape.js'
export interface AccountDeletedInput {
  username: string
  hardPurgeAt: Date
  supportLink?: string
}

// Sent at account-delete time. The user has a 30-day grace window
// during which support can restore the account. After that, the
// hard-purge job tombstones audit FKs and wipes the user row.
export function renderAccountDeleted(input: AccountDeletedInput): {
  subject: string
  html: string
  text: string
} {
  const purgePretty = input.hardPurgeAt.toUTCString()
  const subject = 'Your Rallypoint ID account is scheduled for deletion'
  const support = input.supportLink ?? 'https://id.rallypt.app/support'
  const text = [
    `Hi ${input.username},`,
    '',
    'Your Rallypoint ID account has been deactivated. All active',
    'sessions have been signed out.',
    '',
    'There is a 30-day grace period during which we can restore the',
    `account if you contact support. After ${purgePretty}, the account`,
    'data will be permanently deleted and cannot be recovered.',
    '',
    `Need to restore? ${support}`,
  ].join('\n')
  const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#111;">
  <p>Hi ${escapeHtml(input.username)},</p>
  <p>Your Rallypoint ID account has been deactivated. All active
     sessions have been signed out.</p>
  <p>There is a <strong>30-day grace period</strong> during which we can
     restore the account if you contact support. After
     <time>${escapeHtml(purgePretty)}</time> the account data will be
     permanently deleted and cannot be recovered.</p>
  <p>Need to restore? <a href="${escapeHtml(support)}">${escapeHtml(support)}</a></p>
</body></html>`
  return { subject, html, text }
}
