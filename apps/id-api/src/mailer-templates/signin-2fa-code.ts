import { escapeHtml } from './_escape.js'
// 2FA code email template. Pure function of inputs.

export interface Signin2faCodeInput {
  username: string
  code: string
  expiresAt: Date
}

export function renderSignin2faCode(input: Signin2faCodeInput): {
  subject: string
  html: string
  text: string
} {
  const expiresPretty = input.expiresAt.toUTCString()
  const subject = `Your Rallypoint ID sign-in code: ${input.code}`
  const text = [
    `Hi ${input.username},`,
    '',
    `Your sign-in code is: ${input.code}`,
    '',
    `This code expires at ${expiresPretty}.`,
    '',
    "If you didn't try to sign in to Rallypoint ID, change your",
    'password immediately — someone may have it.',
  ].join('\n')
  const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#111;">
  <p>Hi ${escapeHtml(input.username)},</p>
  <p>Your sign-in code is:</p>
  <p style="font-size:32px;font-weight:600;letter-spacing:6px;background:#f3f4f6;padding:16px 24px;border-radius:8px;display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">${escapeHtml(input.code)}</p>
  <p style="color:#555;font-size:13px;">
    This code expires at <time>${escapeHtml(expiresPretty)}</time>.
  </p>
  <p style="color:#888;font-size:12px;">
    If you didn't try to sign in to Rallypoint ID, change your
    password immediately — someone may have it.
  </p>
</body></html>`
  return { subject, html, text }
}
