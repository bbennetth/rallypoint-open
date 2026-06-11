import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// scripts/gen-cf-secrets.sh assembles the CF_WORKER_SECRETS JSON the deploy
// workflow consumes. The interesting (and only error-prone) logic is the
// cross-app peer-key duplication: a single generated *_API_KEY value has to
// land in every app that authenticates against it (id-api is the authority).
// These tests run the real script and assert the structural + duplication +
// independence invariants on its output.

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

const APPS = ['id-api', 'lists-api', 'events-api', 'money-api', 'planner-api']
// 32 random bytes base64-encoded (no padding stripped) -> 44 chars.
const RANDOM_KEY = /^[A-Za-z0-9+/]{43}=$/

// The exact key set the script must emit per app, mirroring docs/deploy/
// cloudflare.md section 3. OPEN_METEO_COMMERCIAL_API_KEY is intentionally
// omitted (optional, commercial weather tier only). Locks the contract so a
// stray or dropped key fails loudly.
const EXPECTED_KEYS: Record<string, string[]> = {
  'id-api': [
    'ARGON2_PEPPER', 'SESSION_HMAC_KEY', 'SIGNIN_CODE_HMAC_KEY',
    'EVENTS_API_KEY', 'LISTS_API_KEY', 'MONEY_API_KEY', 'PLANNER_API_KEY',
    'ADMIN_TOKEN', 'RESEND_API_KEY', 'TURNSTILE_SECRET',
  ],
  'lists-api': [
    'LISTS_API_KEY', 'LISTS_SESSION_KEY_V1', 'REALTIME_TOKEN_HMAC_KEY',
    'EVENTS_API_KEY', 'PLANNER_API_KEY',
  ],
  'events-api': [
    'EVENTS_API_KEY', 'EVENTS_SESSION_KEY_V1', 'REALTIME_TOKEN_HMAC_KEY',
  ],
  'money-api': [
    'MONEY_API_KEY', 'MONEY_SESSION_KEY_V1', 'REALTIME_TOKEN_HMAC_KEY',
  ],
  'planner-api': ['PLANNER_API_KEY', 'PLANNER_SESSION_KEY_V1'],
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

  it('includes all five apps in each env', () => {
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

  it('duplicates each shared peer key into every app that uses it', () => {
    for (const env of Object.values(run())) {
      // id-api is the authority for the four *_API_KEY peer keys.
      expect(env['lists-api'].EVENTS_API_KEY).toBe(env['id-api'].EVENTS_API_KEY)
      expect(env['events-api'].EVENTS_API_KEY).toBe(env['id-api'].EVENTS_API_KEY)
      expect(env['lists-api'].LISTS_API_KEY).toBe(env['id-api'].LISTS_API_KEY)
      expect(env['money-api'].MONEY_API_KEY).toBe(env['id-api'].MONEY_API_KEY)
      expect(env['lists-api'].PLANNER_API_KEY).toBe(env['id-api'].PLANNER_API_KEY)
      expect(env['planner-api'].PLANNER_API_KEY).toBe(env['id-api'].PLANNER_API_KEY)
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
    expect(d.qa['id-api'].EVENTS_API_KEY).not.toBe(d.prod['id-api'].EVENTS_API_KEY)
  })
})
