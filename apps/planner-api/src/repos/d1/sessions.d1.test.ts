import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { buildD1Repos, createDb } from './index.js'
import type { Repos } from '../types.js'

// D1 tests for the planner session repo (R2: the shared @rallypoint/api-kit
// session factory + planner's two divergences). Validates:
//  - the base64 <-> Buffer round-trip for the AES-GCM-sealed RPID bearer
//    (ciphertext + nonce survive create -> findByIdHash byte-for-byte). This is
//    the shared factory boundary, so it covers every app, not just planner.
//  - planner's mapExtra (reads last_verified_at) + markVerified (stamps it) —
//    a column no other app's sessions table carries.

const CIPHERTEXT = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x10, 0x7a, 0xa7, 0x2b])
const NONCE = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77])

function baseRecord() {
  return {
    idHash: 'idhash-abc',
    userId: 'user-1',
    rpidBearerCiphertext: CIPHERTEXT,
    rpidBearerNonce: NONCE,
    rpidBearerKeyVersion: 1,
    absoluteExpiresAt: new Date('2027-01-01T00:00:00.000Z'),
    ipHash: 'ip-hash',
    uaHash: 'ua-hash',
  }
}

describe('planner D1 session repo (api-kit factory)', () => {
  let repos: Repos
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM sessions')
    repos = buildD1Repos(createDb(env.DB))
  })

  it('round-trips the sealed RPID bearer through base64 storage byte-for-byte', async () => {
    await repos.sessions.create(baseRecord())
    const got = await repos.sessions.findByIdHash('idhash-abc')
    expect(got).not.toBeNull()
    // Stored base64-encoded as text, decoded back to Buffer on read — the bytes
    // must be identical or AES-GCM decryption would fail in production.
    expect(got!.rpidBearerCiphertext.equals(CIPHERTEXT)).toBe(true)
    expect(got!.rpidBearerNonce.equals(NONCE)).toBe(true)
    expect(got!.rpidBearerKeyVersion).toBe(1)
    expect(got!.userId).toBe('user-1')
    // A brand-new row has never been re-verified → mapExtra folds in null.
    expect(got!.lastVerifiedAt).toBeNull()
  })

  it('markVerified stamps last_verified_at and findByIdHash reads it back', async () => {
    await repos.sessions.create(baseRecord())
    const when = new Date('2026-07-06T12:34:56.000Z')
    await repos.sessions.markVerified('idhash-abc', when)
    const got = await repos.sessions.findByIdHash('idhash-abc')
    expect(got!.lastVerifiedAt).toEqual(when)
  })

  it('deleteByIdHash removes the row', async () => {
    await repos.sessions.create(baseRecord())
    await repos.sessions.deleteByIdHash('idhash-abc')
    expect(await repos.sessions.findByIdHash('idhash-abc')).toBeNull()
  })
})
