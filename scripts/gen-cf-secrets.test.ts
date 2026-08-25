import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// scripts/gen-cf-secrets.sh assembles the CF_WORKER_SECRETS JSON the deploy
// workflow consumes. Since the RPC-bindings migration retired the cross-app
// *_API_KEY peer keys, every key is per-app independent — these tests run the
// real script and lock the per-app key contract plus the randomness /
// placeholder / qa-prod-independence invariants on its output.

const SCRIPT = fileURLToPath(new URL('./gen-cf-secrets.sh', import.meta.url))

function hasOpenssl(): boolean {
  try {
    execFileSync('bash', ['-c', 'command -v openssl'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function run(...args: string[]): Record<string, Record<string, Record<string, string>>> {
  const out = execFileSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'], // drop the stderr guidance banner
  })
  return JSON.parse(out)
}

// lists-mcp is intentionally absent: it has no runtime secrets (only NODE_ENV).
const APPS = ['id-api', 'lists-api', 'events-api', 'money-api', 'planner-api', 'fitness-api', 'admin-api']
// 32 random bytes base64-encoded (no padding stripped) -> 44 chars.
const RANDOM_KEY = /^[A-Za-z0-9+/]{43}=$/

// The exact key set the script must emit per app, mirroring docs/deploy/
// cloudflare.md section 3. Intentionally omitted: OPEN_METEO_COMMERCIAL_API_KEY
// (optional, commercial weather tier only) and planner-api's VAPID_* trio
// (hand-generated per env via gen-vapid-keys.ts — an identical placeholder in
// both envs would trip check-vapid-isolation.sh). Locks the contract so a
// stray or dropped key fails loudly.
const EXPECTED_KEYS: Record<string, string[]> = {
  'id-api': [
    'ARGON2_PEPPER', 'SESSION_HMAC_KEY', 'SIGNIN_CODE_HMAC_KEY',
    'ADMIN_TOKEN', 'RESEND_API_KEY', 'TURNSTILE_SECRET',
  ],
  'lists-api': ['LISTS_SESSION_KEY_V1', 'REALTIME_TOKEN_HMAC_KEY'],
  'events-api': ['EVENTS_SESSION_KEY_V1', 'REALTIME_TOKEN_HMAC_KEY', 'ADMIN_USER_IDS'],
  'money-api': ['MONEY_SESSION_KEY_V1', 'REALTIME_TOKEN_HMAC_KEY'],
  'planner-api': ['PLANNER_SESSION_KEY_V1'],
  'fitness-api': ['FITNESS_SESSION_KEY_V1'],
  'admin-api': ['ADMIN_SESSION_KEY_V1', 'ADMIN_USER_IDS'],
}

describe.skipIf(!hasOpenssl())('gen-cf-secrets.sh', () => {
  it('emits both envs by default, one when an env is named', () => {
    expect(Object.keys(run()).sort()).toEqual(['prod', 'qa'])
    expect(Object.keys(run('qa'))).toEqual(['qa'])
    expect(Object.keys(run('prod'))).toEqual(['prod'])
  })

  it('rejects an unknown env argument', () => {
    expect(() => run('staging')).toThrow()
  })

  it('includes every app in each env', () => {
    const d = run()
    for (const env of ['qa', 'prod']) {
      expect(Object.keys(d[env]).sort()).toEqual([...APPS].sort())
    }
  })

  it('emits exactly the documented key set for every app+env', () => {
    const d = run()
    for (const env of ['qa', 'prod']) {
      for (const app of APPS) {
        expect(Object.keys(d[env][app]).sort()).toEqual([...EXPECTED_KEYS[app]].sort())
      }
    }
  })

  it('gives every app an independent session key (no cross-app duplication)', () => {
    for (const env of Object.values(run())) {
      const sessions = new Set([
        env['lists-api'].LISTS_SESSION_KEY_V1,
        env['events-api'].EVENTS_SESSION_KEY_V1,
        env['money-api'].MONEY_SESSION_KEY_V1,
        env['planner-api'].PLANNER_SESSION_KEY_V1,
        env['fitness-api'].FITNESS_SESSION_KEY_V1,
      ])
      expect(sessions.size).toBe(5)
    }
  })

  it('gives each app an independent REALTIME_TOKEN_HMAC_KEY', () => {
    for (const env of Object.values(run())) {
      const keys = new Set([
        env['lists-api'].REALTIME_TOKEN_HMAC_KEY,
        env['events-api'].REALTIME_TOKEN_HMAC_KEY,
        env['money-api'].REALTIME_TOKEN_HMAC_KEY,
      ])
      expect(keys.size).toBe(3)
    }
  })

  it('fills generated keys with base64 randomness and leaves third-party keys as REPLACE_ME', () => {
    const { qa } = run('qa')
    expect(qa['id-api'].ARGON2_PEPPER).toMatch(RANDOM_KEY)
    expect(qa['id-api'].SESSION_HMAC_KEY).toMatch(RANDOM_KEY)
    expect(qa['id-api'].ADMIN_TOKEN).toMatch(RANDOM_KEY)
    expect(qa['planner-api'].PLANNER_SESSION_KEY_V1).toMatch(RANDOM_KEY)
    expect(qa['fitness-api'].FITNESS_SESSION_KEY_V1).toMatch(RANDOM_KEY)

    // Third-party credentials remain placeholders for the operator to fill.
    expect(qa['id-api'].RESEND_API_KEY).toBe('REPLACE_ME')
    expect(qa['id-api'].TURNSTILE_SECRET).toBe('REPLACE_ME')
  })

  it('honors $CF_SECRETS_PLACEHOLDER', () => {
    const out = execFileSync('bash', [SCRIPT, 'qa'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, CF_SECRETS_PLACEHOLDER: 'FILL_ME_IN' },
    })
    expect(JSON.parse(out).qa['id-api'].RESEND_API_KEY).toBe('FILL_ME_IN')
  })

  it('generates independent values for qa and prod', () => {
    const d = run()
    expect(d.qa['id-api'].SESSION_HMAC_KEY).not.toBe(d.prod['id-api'].SESSION_HMAC_KEY)
    expect(d.qa['fitness-api'].FITNESS_SESSION_KEY_V1).not.toBe(d.prod['fitness-api'].FITNESS_SESSION_KEY_V1)
  })
})
