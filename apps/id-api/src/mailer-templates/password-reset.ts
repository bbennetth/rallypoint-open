import { escapeHtml } from './_escape.js'
// Password-reset email templates.

export interface PasswordResetRequestedInput {
  username: string
  link: string
  expiresAt: Date
}

export function renderPasswordResetRequested(input: PasswordResetRequestedInput): {
  subject: string
  html: string
  text: string
} {
  const expiresPretty = input.expiresAt.toUTCString()
  const subject = 'Reset your Rallypoint ID password'
  const text = [
    `Hi ${input.username},`,
    '',
    'A password reset was requested for your Rallypoint ID. To set a',
    'new password, open this link:',
    '',
    input.link,
    '',
    `This link expires at ${expiresPretty} and works exactly once.`,
    '',
    "If you didn't request this, you can safely ignore this email — no",
    'changes were made to your account.',
  ].join('\n')
  const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#111;">
  <p>Hi ${escapeHtml(input.username)},</p>
  <p>A password reset was requested for your Rallypoint ID. To set a new password:</p>
  <p><a href="${escapeHtml(input.link)}" style="display:inline-block;padding:10px 16px;background:#6b4cf2;color:#fff;border-radius:6px;text-decoration:none;">Reset password</a></p>
  <p style="color:#555;font-size:13px;">
    Or paste this URL into your browser:<br>
    <code>${escapeHtml(input.link)}</code>
  </p>
  <p style="color:#555;font-size:13px;">
    This link expires at <time>${escapeHtml(expiresPretty)}</time> and works exactly once.
  </p>
  <p style="color:#888;font-size:12px;">
    If you didn't request this, you can safely ignore this email — no
    changes were made to your account.
  </p>
</body></html>`
  return { subject, html, text }
}

export interface PasswordResetCompletedInput {
  username: string
  supportLink?: string
}

export function renderPasswordResetCompleted(input: PasswordResetCompletedInput): {
  subject: string
  html: string
  text: string
} {
  const subject = 'Your Rallypoint ID password was changed'
  const text = [
    `Hi ${input.username},`,
    '',
    'Your Rallypoint ID password was just changed using a password',
    'reset link. All other active sessions have been signed out.',
    '',
    "If this wasn't you, contact support immediately:",
    input.supportLink ?? 'https://id.rallypt.app/support',
  ].join('\n')
  const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#111;">
  <p>Hi ${escapeHtml(input.username)},</p>
  <p>Your Rallypoint ID password was just changed using a password reset link.
     All other active sessions have been signed out.</p>
  <p style="color:#b91c1c;font-weight:600;">
    If this wasn't you, contact support immediately:
    <a href="${escapeHtml(input.supportLink ?? 'https://id.rallypt.app/support')}">id.rallypt.app/support</a>.
  </p>
</body></html>`
  return { subject, html, text }
}
