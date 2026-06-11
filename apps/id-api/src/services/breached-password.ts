import { createHash } from 'node:crypto'
import type { BreachedPasswordCheck } from './types.js'

// HIBP k-anonymity API: client sends a SHA-1 prefix (5 chars),
// server responds with all suffixes for hashes starting with
// that prefix. Client checks for its own suffix locally. The
// password itself never leaves the process.

export function createHibpCheck(opts: { fetchImpl?: typeof fetch; apiBase?: string } = {}): BreachedPasswordCheck {
  const fetchImpl = opts.fetchImpl ?? fetch
  const apiBase = opts.apiBase ?? 'https://api.pwnedpasswords.com'

  return {
    async isBreached(password: string) {
      const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase()
      const prefix = sha1.slice(0, 5)
      const suffix = sha1.slice(5)
      const res = await fetchImpl(`${apiBase}/range/${prefix}`, {
        method: 'GET',
        headers: { 'Add-Padding': 'true' },
      })
      if (!res.ok) {
        // Network / API failure → fail-closed semantics live at the
        // caller. Here we say "not breached" so the call doesn't
        // block all signups when HIBP is briefly down. Caller logs.
        return { breached: false }
      }
      const text = await res.text()
      for (const line of text.split('\n')) {
        const [hashSuffix, countRaw] = line.trim().split(':')
        if (hashSuffix === suffix) {
          return { breached: true, occurrences: Number(countRaw ?? 0) }
        }
      }
      return { breached: false }
    },
  }
}

let stubWarned = false
export function createStubBreachedCheck(): BreachedPasswordCheck {
  return {
    async isBreached() {
      if (!stubWarned) {
        console.warn(
          '[hibp] StubBreachedCheck active — every password passes the breach check. ' +
            'Do not use in production.',
        )
        stubWarned = true
      }
      return { breached: false }
    },
  }
}

export function createAlwaysBreachedCheck(): BreachedPasswordCheck {
  return {
    async isBreached() {
      return { breached: true, occurrences: 999 }
    },
  }
}
