import { escapeHtml } from './_escape.js'
export interface EmailChangeRequestedInput {
  username: string
  newEmail: string
  confirmLink: string
  expiresAt: Date
}

// To the NEW address: "click to confirm the change."
export function renderEmailChangeRequested(input: EmailChangeRequestedInput): {
  subject: string
  html: string
  text: string
} {
  const expiresPretty = input.expiresAt.toUTCString()
  const subject = 'Confirm your new Rallypoint ID email address'
  const text = [
    `Hi ${input.username},`,
    '',
    `Someone (hopefully you) requested to change the email address`,
    `on a Rallypoint ID account to ${input.newEmail}.`,
    '',
    'To confirm the change, open this link:',
    '',
    input.confirmLink,
    '',
    `This link expires at ${expiresPretty}.`,
    '',
    "If you didn't request this, you can ignore this email. The",
    "change won't take effect.",
  ].join('\n')
  const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#111;">
  <p>Hi ${escapeHtml(input.username)},</p>
  <p>Someone (hopefully you) requested to change the email on a
     Rallypoint ID account to <strong>${escapeHtml(input.newEmail)}</strong>.</p>
  <p><a href="${escapeHtml(input.confirmLink)}" style="display:inline-block;padding:10px 16px;background:#6b4cf2;color:#fff;border-radius:6px;text-decoration:none;">Confirm new email</a></p>
  <p style="color:#555;font-size:13px;">
    Or paste this URL into your browser:<br>
    <code>${escapeHtml(input.confirmLink)}</code>
  </p>
  <p style="color:#555;font-size:13px;">
    This link expires at <time>${escapeHtml(expiresPretty)}</time>.
  </p>
</body></html>`
  return { subject, html, text }
}

export interface EmailChangePendingOldAddressInput {
  username: string
  newEmail: string
  cancelLink: string
  expiresAt: Date
}

// To the OLD address: "your email is being changed; click to cancel."
export function renderEmailChangePendingOldAddress(
  input: EmailChangePendingOldAddressInput,
): { subject: string; html: string; text: string } {
  const expiresPretty = input.expiresAt.toUTCString()
  const subject = 'Heads up: your Rallypoint ID email is changing'
  const text = [
    `Hi ${input.username},`,
    '',
    `Someone requested to change the email on your Rallypoint ID`,
    `account to ${input.newEmail}. The change is pending until`,
    'confirmed at the new address.',
    '',
    "If this wasn't you, cancel it immediately:",
    '',
    input.cancelLink,
    '',
    `Cancel link expires at ${expiresPretty}.`,
  ].join('\n')
  const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#111;">
  <p>Hi ${escapeHtml(input.username)},</p>
  <p>Someone requested to change the email on your Rallypoint ID
     account to <strong>${escapeHtml(input.newEmail)}</strong>.
     The change is pending until confirmed at the new address.</p>
  <p style="color:#b91c1c;font-weight:600;">If this wasn't you, cancel it immediately:</p>
  <p><a href="${escapeHtml(input.cancelLink)}" style="display:inline-block;padding:10px 16px;background:#dc2626;color:#fff;border-radius:6px;text-decoration:none;">Cancel email change</a></p>
  <p style="color:#555;font-size:13px;">
    Or paste this URL into your browser:<br>
    <code>${escapeHtml(input.cancelLink)}</code>
  </p>
  <p style="color:#555;font-size:13px;">
    Cancel link expires at <time>${escapeHtml(expiresPretty)}</time>.
  </p>
</body></html>`
  return { subject, html, text }
}

export interface EmailChangeCompletedInput {
  username: string
  newEmail: string
}

// To the OLD address (post-confirm): "your email was changed."
export function renderEmailChangeCompleted(input: EmailChangeCompletedInput): {
  subject: string
  html: string
  text: string
} {
  const subject = 'Your Rallypoint ID email was changed'
  const text = [
    `Hi ${input.username},`,
    '',
    `The email address on your Rallypoint ID account was changed to`,
    `${input.newEmail}. Future sign-in codes and account notifications`,
    'will go to the new address.',
    '',
    "If this wasn't you, contact support immediately:",
    'https://id.rallypt.app/support',
  ].join('\n')
  const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#111;">
  <p>Hi ${escapeHtml(input.username)},</p>
  <p>The email address on your Rallypoint ID account was changed to
     <strong>${escapeHtml(input.newEmail)}</strong>.</p>
  <p style="color:#b91c1c;">
    If this wasn't you, contact support immediately:
    <a href="https://id.rallypt.app/support">id.rallypt.app/support</a>.
  </p>
</body></html>`
  return { subject, html, text }
}
