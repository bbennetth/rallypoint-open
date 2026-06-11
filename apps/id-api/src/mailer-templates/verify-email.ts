import { escapeHtml } from './_escape.js'
// Email templates are pure functions of their input. They live
// in code (not a DB table) so prod can't drift from the code's
// expected wire format.

export interface VerifyEmailInput {
  username: string
  link: string
  expiresAt: Date
}

export function renderVerifyEmail(input: VerifyEmailInput): {
  subject: string
  html: string
  text: string
} {
  const expiresIso = input.expiresAt.toISOString()
  const expiresPretty = input.expiresAt.toUTCString()
  const subject = 'Confirm your Rallypoint ID email address'
  const text = [
    `Hi ${input.username},`,
    '',
    'Confirm your email address to finish setting up your Rallypoint ID:',
    '',
    input.link,
    '',
    `This link expires at ${expiresPretty}.`,
    '',
    "If you didn't sign up for a Rallypoint ID, you can ignore this email.",
  ].join('\n')
  const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#111;">
  <p>Hi ${escapeHtml(input.username)},</p>
  <p>Confirm your email address to finish setting up your Rallypoint ID:</p>
  <p><a href="${escapeHtml(input.link)}" style="display:inline-block;padding:10px 16px;background:#6b4cf2;color:#fff;border-radius:6px;text-decoration:none;">Confirm email</a></p>
  <p style="color:#555;font-size:13px;">
    Or paste this URL into your browser:<br>
    <code>${escapeHtml(input.link)}</code>
  </p>
  <p style="color:#555;font-size:13px;">
    This link expires at <time datetime="${expiresIso}">${escapeHtml(expiresPretty)}</time>.
  </p>
  <p style="color:#888;font-size:12px;">If you didn't sign up for a Rallypoint ID, you can ignore this email.</p>
</body></html>`
  return { subject, html, text }
}
