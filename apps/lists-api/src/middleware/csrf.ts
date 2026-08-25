import type { MiddlewareHandler } from 'hono'
import {
  createRequireCsrf,
  createCsrfIssueHandler,
  generateCsrfToken,
  CSRF_HEADER,
} from '@rallypoint/api-kit'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'

// CSRF double-submit. Shared implementation lives in @rallypoint/api-kit;
// this app supplies its cookie-name env key + error factory.

const config = {
  cookieNameEnvKey: 'LISTS_CSRF_COOKIE_NAME',
  errors: { csrfInvalid: () => errors.csrfInvalid() },
}

export const csrfIssueHandler = createCsrfIssueHandler(config) as MiddlewareHandler<HonoApp>

export function requireCsrf(): MiddlewareHandler<HonoApp> {
  return createRequireCsrf(config) as MiddlewareHandler<HonoApp>
}

export { generateCsrfToken, CSRF_HEADER }
