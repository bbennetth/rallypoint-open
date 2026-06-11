import { Hono } from 'hono'
import type { HonoApp } from '../../context.js'
import { handleSignup } from './signup.js'
import { handleVerifyEmail } from './verify-email.js'
import {
  handleSigninStart,
  handleSigninComplete,
  handleSigninResend,
} from './signin.js'
import {
  handlePasswordResetRequest,
  handlePasswordResetConfirm,
} from './password-reset.js'
import {
  handleChangePassword,
  handleEmailChangeRequest,
  handleEmailChangeConfirm,
  handleEmailChangeCancel,
  handlePatchMe,
  handleDeleteMe,
} from './me.js'
import { requireSession } from '../../middleware/session.js'
import { SESSION_LIFETIME_MS } from '../../session/issue.js'
import { errors } from '../../errors.js'
import { rateLimit } from '../../middleware/rate-limit.js'
import {
  buildSsoHintCookie,
  buildSsoHintClearCookie,
} from '../../lib/sso-hint-cookie.js'

// /api/v1/ui/* auth surface for slices 2 (signup + verify-email)
// and 3b (signin + 2FA). Slice 3a's session/signout routes live
// in routes/auth/session.ts; slices 4/5 add the rest.
//
// Rate-limit policy:
//   - signup: 5 / 10 min per IP + 20 / 24h per IP (signup-per-day)
//   - verify-email: 30 / 5 min per IP
//   - signin/start: 10 / 10 min per IP — password-guessing defense
//   - signin/complete: 30 / 10 min per IP — covers honest typos
//   - signin/resend-2fa: 5 / 10 min per IP — per-challenge resend
//     spam control

export const authUiRoutes = new Hono<HonoApp>()
  .use(
    '/api/v1/ui/signup',
    rateLimit({ route: 'signup-per-day', perIp: { limit: 20, windowSeconds: 24 * 3600 } }),
  )
  .use(
    '/api/v1/ui/signup',
    rateLimit({ route: 'signup', perIp: { limit: 5, windowSeconds: 10 * 60 } }),
  )
  .use(
    '/api/v1/ui/verify-email',
    rateLimit({ route: 'verify-email', perIp: { limit: 30, windowSeconds: 5 * 60 } }),
  )
  .use(
    '/api/v1/ui/signin/start',
    rateLimit({ route: 'signin-start', perIp: { limit: 10, windowSeconds: 10 * 60 } }),
  )
  .use(
    '/api/v1/ui/signin/complete',
    rateLimit({ route: 'signin-complete', perIp: { limit: 30, windowSeconds: 10 * 60 } }),
  )
  .use(
    '/api/v1/ui/signin/resend-2fa',
    rateLimit({ route: 'signin-resend-2fa', perIp: { limit: 5, windowSeconds: 10 * 60 } }),
  )
  .use(
    '/api/v1/ui/password-reset/request',
    rateLimit({ route: 'pwreset-request', perIp: { limit: 5, windowSeconds: 10 * 60 } }),
  )
  .use(
    '/api/v1/ui/password-reset/confirm',
    rateLimit({ route: 'pwreset-confirm', perIp: { limit: 10, windowSeconds: 10 * 60 } }),
  )
  .use(
    '/api/v1/ui/me/change-password',
    rateLimit({ route: 'me-change-pw', perIp: { limit: 10, windowSeconds: 10 * 60 } }),
  )
  .use(
    '/api/v1/ui/me/email-change/request',
    rateLimit({ route: 'me-email-change', perIp: { limit: 5, windowSeconds: 10 * 60 } }),
  )
  .use(
    '/api/v1/ui/me',
    rateLimit({ route: 'me-mutate', perIp: { limit: 20, windowSeconds: 10 * 60 } }),
  )
  .post('/api/v1/ui/signup', async (c) => {
    const body = await readJsonBody(c)
    const result = await handleSignup(body, {
      repos: c.var.repos,
      services: c.var.services,
      passwordHasher: c.var.passwordHasher,
      publicBaseUrl: c.var.env.PUBLIC_BASE_URL,
      argon2PepperKey: c.var.env.ARGON2_PEPPER,
      ipAddress: extractIp(c),
      userAgent: c.req.header('user-agent') ?? '',
      logger: c.var.logger,
    })
    return c.json(result)
  })
  .post('/api/v1/ui/verify-email', async (c) => {
    const body = await readJsonBody(c)
    const result = await handleVerifyEmail(body, {
      repos: c.var.repos,
      argon2PepperKey: c.var.env.ARGON2_PEPPER,
      ipAddress: extractIp(c),
      userAgent: c.req.header('user-agent') ?? '',
    })
    return c.json(result)
  })
  .post('/api/v1/ui/signin/start', async (c) => {
    const body = await readJsonBody(c)
    const result = await handleSigninStart(body, {
      repos: c.var.repos,
      services: c.var.services,
      passwordHasher: c.var.passwordHasher,
      publicBaseUrl: c.var.env.PUBLIC_BASE_URL,
      argon2PepperKey: c.var.env.ARGON2_PEPPER,
      signinCodeHmacKey: c.var.env.SIGNIN_CODE_HMAC_KEY,
      ipAddress: extractIp(c),
      userAgent: c.req.header('user-agent') ?? '',
      logger: c.var.logger,
    })
    return c.json(result)
  })
  .post('/api/v1/ui/signin/complete', async (c) => {
    const body = await readJsonBody(c)
    const result = await handleSigninComplete(body, {
      repos: c.var.repos,
      services: c.var.services,
      passwordHasher: c.var.passwordHasher,
      publicBaseUrl: c.var.env.PUBLIC_BASE_URL,
      argon2PepperKey: c.var.env.ARGON2_PEPPER,
      signinCodeHmacKey: c.var.env.SIGNIN_CODE_HMAC_KEY,
      ipAddress: extractIp(c),
      userAgent: c.req.header('user-agent') ?? '',
      logger: c.var.logger,
    })
    const maxAge = Math.floor(SESSION_LIFETIME_MS / 1000)
    const secure = c.var.env.NODE_ENV === 'production'
    c.header(
      'Set-Cookie',
      `${c.var.env.SESSION_COOKIE_NAME}=${result.sessionToken}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`,
    )
    c.header(
      'Set-Cookie',
      buildSsoHintCookie({
        maxAgeSeconds: maxAge,
        ...(c.var.env.SSO_HINT_COOKIE_DOMAIN ? { domain: c.var.env.SSO_HINT_COOKIE_DOMAIN } : {}),
        secure,
      }),
      { append: true },
    )
    // For UI callers the cookie IS the auth — strip the bearer
    // from the body to avoid them caching it anywhere.
    const { sessionToken: _sessionToken, ...uiPayload } = result
    return c.json(uiPayload)
  })
  .post('/api/v1/ui/signin/resend-2fa', async (c) => {
    const body = await readJsonBody(c)
    const result = await handleSigninResend(body, {
      repos: c.var.repos,
      services: c.var.services,
      passwordHasher: c.var.passwordHasher,
      publicBaseUrl: c.var.env.PUBLIC_BASE_URL,
      argon2PepperKey: c.var.env.ARGON2_PEPPER,
      signinCodeHmacKey: c.var.env.SIGNIN_CODE_HMAC_KEY,
      ipAddress: extractIp(c),
      userAgent: c.req.header('user-agent') ?? '',
      logger: c.var.logger,
    })
    return c.json(result)
  })
  .post('/api/v1/ui/password-reset/request', async (c) => {
    const body = await readJsonBody(c)
    const result = await handlePasswordResetRequest(body, {
      repos: c.var.repos,
      services: c.var.services,
      passwordHasher: c.var.passwordHasher,
      publicBaseUrl: c.var.env.PUBLIC_BASE_URL,
      argon2PepperKey: c.var.env.ARGON2_PEPPER,
      ipAddress: extractIp(c),
      userAgent: c.req.header('user-agent') ?? '',
      logger: c.var.logger,
    })
    return c.json(result)
  })
  .post('/api/v1/ui/password-reset/confirm', async (c) => {
    const body = await readJsonBody(c)
    const { revokedIdHashes, ...result } = await handlePasswordResetConfirm(body, {
      repos: c.var.repos,
      services: c.var.services,
      passwordHasher: c.var.passwordHasher,
      publicBaseUrl: c.var.env.PUBLIC_BASE_URL,
      argon2PepperKey: c.var.env.ARGON2_PEPPER,
      ipAddress: extractIp(c),
      userAgent: c.req.header('user-agent') ?? '',
      logger: c.var.logger,
    })
    for (const h of revokedIdHashes) c.var.sessionCache?.invalidate(h)
    return c.json(result)
  })
  // /me endpoints — require an active session. requireSession()
  // attaches c.var.session for the handler.
  .post(
    '/api/v1/ui/me/change-password',
    requireSession('cookie'),
    async (c) => {
      const body = await readJsonBody(c)
      const result = await handleChangePassword(body, meCtx(c))
      for (const h of result.revokedIdHashes) c.var.sessionCache?.invalidate(h)
      const maxAge = Math.floor(SESSION_LIFETIME_MS / 1000)
      const secure = c.var.env.NODE_ENV === 'production'
      c.header(
        'Set-Cookie',
        `${c.var.env.SESSION_COOKIE_NAME}=${result.newSessionToken}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`,
      )
      c.header(
        'Set-Cookie',
        buildSsoHintCookie({
          maxAgeSeconds: maxAge,
          ...(c.var.env.SSO_HINT_COOKIE_DOMAIN ? { domain: c.var.env.SSO_HINT_COOKIE_DOMAIN } : {}),
          secure,
        }),
        { append: true },
      )
      return c.json({ ok: true })
    },
  )
  .post(
    '/api/v1/ui/me/email-change/request',
    requireSession('cookie'),
    async (c) => {
      const body = await readJsonBody(c)
      const result = await handleEmailChangeRequest(body, meCtx(c))
      return c.json(result)
    },
  )
  .post(
    '/api/v1/ui/me/email-change/confirm',
    requireSession('cookie'),
    async (c) => {
      const body = await readJsonBody(c)
      const result = await handleEmailChangeConfirm(body, meCtx(c))
      return c.json(result)
    },
  )
  // Cancel does NOT require a session — the link goes to the OLD
  // email address, where the user might not be signed in. The
  // cancel-token IS the auth here.
  .post('/api/v1/ui/me/email-change/cancel', async (c) => {
    const body = await readJsonBody(c)
    // MeCtxAuthlessLink — no session field needed (#30); the
    // cancel-token IS the auth.
    const result = await handleEmailChangeCancel(body, {
      repos: c.var.repos,
      services: c.var.services,
      passwordHasher: c.var.passwordHasher,
      publicBaseUrl: c.var.env.PUBLIC_BASE_URL,
      argon2PepperKey: c.var.env.ARGON2_PEPPER,
      ipAddress: extractIp(c),
      userAgent: c.req.header('user-agent') ?? '',
      logger: c.var.logger,
    })
    return c.json(result)
  })
  .patch('/api/v1/ui/me', requireSession('cookie'), async (c) => {
    const body = await readJsonBody(c)
    const result = await handlePatchMe(body, meCtx(c))
    return c.json(result)
  })
  .delete('/api/v1/ui/me', requireSession('cookie'), async (c) => {
    const body = await readJsonBody(c)
    const { revokedIdHashes, ...rest } = await handleDeleteMe(body, meCtx(c))
    for (const h of revokedIdHashes) c.var.sessionCache?.invalidate(h)
    const secure = c.var.env.NODE_ENV === 'production'
    // Clear the session cookie since the session was just invalidated.
    c.header(
      'Set-Cookie',
      `${c.var.env.SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
    )
    // Clear the SSO hint cookie so JS on app subdomains stops attempting
    // silent SSO after account deletion.
    c.header(
      'Set-Cookie',
      buildSsoHintClearCookie({
        ...(c.var.env.SSO_HINT_COOKIE_DOMAIN ? { domain: c.var.env.SSO_HINT_COOKIE_DOMAIN } : {}),
        secure,
      }),
      { append: true },
    )
    return c.json(rest)
  })

// Public HTML landing for the verification link. Posts to the JSON
// API and renders inline success/failure. Replaced by the hosted-
// UI route in slice 6a.
export const publicAuthRoutes = new Hono<HonoApp>().get('/verify-email', (c) => {
  const token = c.req.query('token') ?? ''
  const nonce = c.get('secureHeadersNonce') ?? ''
  const csrfCookieName = c.var.env.CSRF_COOKIE_NAME
  // Post-success redirect target. Mirrors the React VerifyEmailPage,
  // which sends the user to the hosted-UI sign-in after a countdown.
  const redirectUrl = `${c.var.env.UI_ORIGIN}/signin`
  if (!token) {
    return c.html(
      renderVerifyPage({ state: 'missing-token', nonce, csrfCookieName, redirectUrl }),
      400,
    )
  }
  return c.html(
    renderVerifyPage({ state: 'pending', token, nonce, csrfCookieName, redirectUrl }),
  )
})

import type { Context } from 'hono'
import { extractIpFromContext as extractIp } from '../../http/extract-ip.js'
import { escapeHtml } from '../../mailer-templates/_escape.js'

function meCtx(c: Context<HonoApp>) {
  return {
    repos: c.var.repos,
    services: c.var.services,
    passwordHasher: c.var.passwordHasher,
    publicBaseUrl: c.var.env.PUBLIC_BASE_URL,
    argon2PepperKey: c.var.env.ARGON2_PEPPER,
    ipAddress: extractIp(c),
    userAgent: c.req.header('user-agent') ?? '',
    logger: c.var.logger,
    session: c.var.session!,
  }
}

async function readJsonBody(c: { req: { raw: Request } }): Promise<unknown> {
  try {
    return await c.req.raw.json()
  } catch {
    throw errors.bodyInvalid()
  }
}

// extractIp(...) moved to apps/id-api/src/http/extract-ip.ts (#34).

// escapeHtml (HTML-attribute-safe escape) is now imported from
// mailer-templates/_escape.ts — one canonical implementation (#49).

interface RenderVerifyArgs {
  state: 'missing-token' | 'pending'
  token?: string
  nonce: string
  csrfCookieName: string
  redirectUrl: string
}

function renderVerifyPage(args: RenderVerifyArgs): string {
  // The CSP set in build-app.ts uses script-src nonce; the inline
  // <script> tag below carries the matching nonce attribute. Any
  // attacker-injected <script> would NOT carry the nonce and so
  // gets blocked by the browser.
  const nonceAttr = ` nonce="${escapeHtml(args.nonce)}"`
  const head = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verify email — Rallypoint ID</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0a0c10;color:#e5e7eb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
  main{max-width:480px;padding:32px;background:#11151c;border:1px solid #1b2230;border-radius:12px;}
  h1{margin:0 0 16px;font-size:20px;}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;color:#a3a3a3;}
  .err{color:#fca5a5;}
  .ok{color:#86efac;}
  button{background:#6b4cf2;color:#fff;border:0;border-radius:6px;padding:10px 16px;font-size:14px;cursor:pointer;}
</style>
</head><body>`

  if (args.state === 'missing-token') {
    return `${head}<main><h1>Missing token</h1><p class="err">This verification link is malformed.</p></main></body></html>`
  }

  // Token lives in a data-attribute (HTML-escaped). The script
  // body is now CONSTANT — no user-input interpolation at all,
  // so the JSON.stringify-into-script XSS class is structurally
  // gone, not just patched.
  return `${head}
<main id="app" data-token="${escapeHtml(args.token ?? '')}" data-csrf-cookie="${escapeHtml(args.csrfCookieName)}" data-redirect="${escapeHtml(args.redirectUrl)}">
  <h1 id="title">Verifying your email…</h1>
  <p id="message" aria-live="polite"><code>This shouldn't take long.</code></p>
</main>
<noscript><p style="color:#fca5a5;text-align:center;padding:24px;">JavaScript is required to verify your email. Enable JS or use the hosted Rallypoint ID UI.</p></noscript>
<script${nonceAttr}>
(async () => {
  const app = document.getElementById('app');
  const title = document.getElementById('title');
  const message = document.getElementById('message');
  const token = app.dataset.token;
  const csrfCookieName = app.dataset.csrfCookie;
  const redirect = app.dataset.redirect;
  function setMessage(tone, text) {
    message.textContent = '';
    const span = document.createElement('span');
    span.className = tone;
    span.textContent = text;
    message.appendChild(span);
  }
  function readCookie(name) {
    const prefix = name + '=';
    for (const part of document.cookie.split(';')) {
      const p = part.trim();
      if (p.startsWith(prefix)) return p.slice(prefix.length);
    }
    return null;
  }
  try {
    // Get a CSRF token (#18). The endpoint sets the cookie and
    // returns the value for convenience; we read the cookie back
    // so the double-submit header matches what the browser holds.
    const csrfRes = await fetch('/api/v1/ui/csrf', { credentials: 'include' });
    if (!csrfRes.ok) throw new Error('csrf bootstrap failed');
    const csrfBody = await csrfRes.json();
    const csrf = readCookie(csrfCookieName) || csrfBody.csrfToken;
    const res = await fetch('/api/v1/ui/verify-email', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-RP-CSRF': csrf,
      },
      body: JSON.stringify({ token }),
    });
    const body = await res.json();
    if (res.ok && body.ok) {
      title.textContent = 'Email verified.';
      const who = body.email || 'Your email';
      if (redirect) {
        // Auto-redirect to sign-in after a 3s countdown, with an
        // immediate "Continue now" override. Mirrors the hosted-UI
        // VerifyEmailPage so both verify paths behave the same.
        let remaining = 3;
        const renderCountdown = () => {
          setMessage('ok', who + ' is confirmed. Redirecting to sign-in in ' + remaining + '…');
        };
        renderCountdown();
        const p = document.createElement('p');
        const link = document.createElement('a');
        link.href = redirect;
        link.textContent = 'Continue now →';
        link.style.color = '#a78bfa';
        p.appendChild(link);
        app.appendChild(p);
        const timer = setInterval(() => {
          remaining -= 1;
          if (remaining <= 0) {
            clearInterval(timer);
            window.location.assign(redirect);
          } else {
            renderCountdown();
          }
        }, 1000);
      } else {
        setMessage('ok', who + ' is confirmed. You can close this tab.');
      }
    } else {
      title.textContent = 'Verification failed.';
      setMessage('err', (body && body.error && body.error.message) || 'Unknown error');
    }
  } catch (e) {
    title.textContent = 'Verification failed.';
    setMessage('err', 'Network error. Please try again later.');
  }
})();
</script>
</body></html>`
}
