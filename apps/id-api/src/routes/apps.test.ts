import { describe, it, expect } from 'vitest'
import { buildApp } from '../build-app.js'
import { parseEnv } from '../env.js'
import { buildInMemoryRepos } from '../repos/memory.js'
import { createPasswordHasher } from '../crypto/password.js'
import { createAlwaysAllowVerifier } from '../services/captcha.js'
import { createStubBreachedCheck } from '../services/breached-password.js'
import { createLogMailer } from '../services/mailer/log.js'
import { issueSession } from '../session/issue.js'
import type { UserId } from '@rallypoint/shared'
import { launchUrlFromHost, buildLauncherApps } from './apps.js'

// -------------------------------------------------------------------
// Pure helpers
// -------------------------------------------------------------------

describe('launchUrlFromHost', () => {
  it('uses http for bare localhost', () => {
    expect(launchUrlFromHost('localhost')).toBe('http://localhost')
  })

  it('uses http for localhost with a port', () => {
    expect(launchUrlFromHost('localhost:5174')).toBe('http://localhost:5174')
  })

  it('uses https for a real host', () => {
    expect(launchUrlFromHost('events.rallypt.app')).toBe('https://events.rallypt.app')
  })

  it('does not treat a non-localhost host containing "localhost" as local', () => {
    expect(launchUrlFromHost('localhost.evil.com')).toBe('https://localhost.evil.com')
  })
})

describe('buildLauncherApps', () => {
  it('returns only clients whose host is configured', () => {
    const env = parseEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      SSO_EVENTS_HOST: 'localhost:5174',
      SSO_MONEY_HOST: 'money.rallypt.app',
    })
    expect(buildLauncherApps(env)).toEqual([
      { client: 'events', name: 'Events', url: 'http://localhost:5174/me/events' },
      { client: 'money', name: 'Money', url: 'https://money.rallypt.app/me/ledgers' },
    ])
  })

  it('returns an empty list when no SSO hosts are configured', () => {
    const env = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    expect(buildLauncherApps(env)).toEqual([])
  })

  it('includes all apps when all hosts are configured', () => {
    const env = parseEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      SSO_EVENTS_HOST: 'events.rallypt.app',
      SSO_LISTS_HOST: 'lists.rallypt.app',
      SSO_MONEY_HOST: 'money.rallypt.app',
      SSO_PLANNER_HOST: 'planner.rallypt.app',
    })
    expect(buildLauncherApps(env)).toEqual([
      { client: 'events', name: 'Events', url: 'https://events.rallypt.app/me/events' },
      { client: 'lists', name: 'Lists', url: 'https://lists.rallypt.app/me/lists' },
      { client: 'money', name: 'Money', url: 'https://money.rallypt.app/me/ledgers' },
      { client: 'planner', name: 'Planner', url: 'https://planner.rallypt.app/me' },
    ])
  })
})

// -------------------------------------------------------------------
// GET /api/v1/ui/apps
// -------------------------------------------------------------------

const ENV = parseEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  SSO_EVENTS_HOST: 'localhost:5174',
  SSO_LISTS_HOST: 'localhost:5175',
})

function buildTestApp(env = ENV) {
  const repos = buildInMemoryRepos()
  const services = {
    mailer: createLogMailer({ sink: () => undefined }),
    captcha: createAlwaysAllowVerifier(),
    breachedPassword: createStubBreachedCheck(),
  }
  const passwordHasher = createPasswordHasher({ pepper: env.ARGON2_PEPPER })
  const app = buildApp({ env, repos, services, passwordHasher })
  return { app, repos }
}

async function signedInCookie(
  repos: ReturnType<typeof buildInMemoryRepos>,
  env = ENV,
): Promise<string> {
  const id = 'user_01HXTEST00000000000000000A' as UserId
  await repos.users.create({
    id,
    tenantId: 'rallypoint',
    email: 'alice@example.com',
    username: 'alice',
  })
  const { rawToken } = await issueSession(repos.sessions, {
    userId: id,
    tenantId: 'rallypoint',
    ipHash: 'a'.repeat(64),
    uaHash: 'b'.repeat(64),
  })
  return `${env.SESSION_COOKIE_NAME}=${rawToken}`
}

describe('GET /api/v1/ui/apps', () => {
  it('returns the configured apps for a signed-in user', async () => {
    const { app, repos } = buildTestApp()
    const cookie = await signedInCookie(repos)

    const res = await app.request('/api/v1/ui/apps', {
      method: 'GET',
      headers: { cookie },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { apps: Array<{ client: string }> }
    expect(body.apps.map((a) => a.client)).toEqual(['events', 'lists'])
  })

  it('requires a session — 401 without a cookie', async () => {
    const { app } = buildTestApp()

    const res = await app.request('/api/v1/ui/apps', { method: 'GET' })

    expect(res.status).toBe(401)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('session_required')
  })
})
