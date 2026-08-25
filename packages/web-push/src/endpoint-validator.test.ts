import { describe, it, expect } from 'vitest'
import { isAllowedPushEndpoint } from './endpoint-validator.js'

describe('isAllowedPushEndpoint', () => {
  describe('accepts production push services', () => {
    it('accepts FCM (Chrome/Edge)', () => {
      expect(
        isAllowedPushEndpoint(
          'https://fcm.googleapis.com/fcm/send/abc123:APA91b...',
        ),
      ).toBe(true)
      expect(
        isAllowedPushEndpoint(
          'https://fcm.googleapis.com/wp/eYz9...:APA91b...',
        ),
      ).toBe(true)
    })

    it('accepts Apple Web Push subdomains', () => {
      expect(
        isAllowedPushEndpoint('https://web.push.apple.com/abcDEF123'),
      ).toBe(true)
      expect(
        isAllowedPushEndpoint('https://api.push.apple.com/3/device/abc'),
      ).toBe(true)
    })

    it('accepts Mozilla autopush', () => {
      expect(
        isAllowedPushEndpoint(
          'https://updates.push.services.mozilla.com/wpush/v2/abc123',
        ),
      ).toBe(true)
    })
  })

  describe('rejects SSRF vectors', () => {
    it('rejects internal Cloudflare metadata addresses', () => {
      expect(isAllowedPushEndpoint('http://169.254.169.254/latest/meta-data/')).toBe(
        false,
      )
      expect(
        isAllowedPushEndpoint('https://169.254.169.254/latest/meta-data/'),
      ).toBe(false)
    })

    it('rejects private network ranges', () => {
      expect(isAllowedPushEndpoint('http://10.0.0.1/admin')).toBe(false)
      expect(isAllowedPushEndpoint('https://192.168.1.1/')).toBe(false)
      expect(isAllowedPushEndpoint('https://127.0.0.1:8080/admin')).toBe(false)
      expect(isAllowedPushEndpoint('https://localhost:8081/')).toBe(false)
    })

    it('rejects dangerous schemes', () => {
      expect(isAllowedPushEndpoint('javascript:alert(1)')).toBe(false)
      expect(isAllowedPushEndpoint('data:text/html,<script>1</script>')).toBe(false)
      expect(isAllowedPushEndpoint('file:///etc/passwd')).toBe(false)
      expect(isAllowedPushEndpoint('ftp://example.com/')).toBe(false)
    })

    it('rejects plain http even on allowlisted hosts (HTTPS-only)', () => {
      expect(
        isAllowedPushEndpoint('http://fcm.googleapis.com/fcm/send/abc'),
      ).toBe(false)
    })

    it('rejects look-alike hosts that almost match the allowlist', () => {
      expect(isAllowedPushEndpoint('https://fcm.googleapis.com.evil/x')).toBe(false)
      expect(isAllowedPushEndpoint('https://evil-fcm.googleapis.com/x')).toBe(false)
      expect(isAllowedPushEndpoint('https://push.apple.com.attacker/x')).toBe(false)
      expect(isAllowedPushEndpoint('https://notmozilla.com/x')).toBe(false)
    })

    it('rejects bare apex of suffix-only entries (avoid accidental match)', () => {
      // The Apple/Mozilla entries use '.push.apple.com' / '.push.services.
      // mozilla.com' — a leading dot enforces at least one subdomain. Without
      // both assertions a future allowlist edit could accidentally widen one
      // and not the other.
      expect(isAllowedPushEndpoint('https://push.apple.com/x')).toBe(false)
      expect(
        isAllowedPushEndpoint('https://push.services.mozilla.com/x'),
      ).toBe(false)
    })

    it('rejects IPv6 loopback (classic SSRF bypass attempt)', () => {
      expect(isAllowedPushEndpoint('https://[::1]/x')).toBe(false)
      expect(isAllowedPushEndpoint('http://[::1]/x')).toBe(false)
      expect(isAllowedPushEndpoint('https://[fe80::1]/x')).toBe(false)
    })

    it('rejects a custom port on an allowlisted host (URL.host includes port)', () => {
      // url.host returns 'fcm.googleapis.com:8080' when a port is present,
      // which does not equal the exact-match 'fcm.googleapis.com' entry.
      expect(
        isAllowedPushEndpoint('https://fcm.googleapis.com:8080/fcm/send/abc'),
      ).toBe(false)
    })

    it('rejects malformed URLs', () => {
      expect(isAllowedPushEndpoint('')).toBe(false)
      expect(isAllowedPushEndpoint('not-a-url')).toBe(false)
      expect(isAllowedPushEndpoint('https://')).toBe(false)
    })
  })

  describe('host-suffix matching is case-insensitive', () => {
    it('normalises host to lowercase before comparison', () => {
      expect(
        isAllowedPushEndpoint('https://FCM.GoogleAPIs.com/fcm/send/abc'),
      ).toBe(true)
    })
  })

  describe('allowExtraHosts (dev/test only)', () => {
    it('extends the allowlist when allowExtraHosts is supplied', () => {
      expect(
        isAllowedPushEndpoint('https://localhost:8081/dev-push', {
          allowExtraHosts: ['localhost:8081'],
        }),
      ).toBe(true)
    })

    it('still rejects non-https even with allowExtraHosts', () => {
      expect(
        isAllowedPushEndpoint('http://localhost:8081/dev-push', {
          allowExtraHosts: ['localhost:8081'],
        }),
      ).toBe(false)
    })
  })
})
