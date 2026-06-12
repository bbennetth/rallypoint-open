import { describe, expect, it } from 'vitest'
import { SHARE_TARGETS, buildGroupInviteLink, buildShareUrl } from './share-invite.js'

describe('buildGroupInviteLink', () => {
  it('builds origin/groups/join?code=… and trims trailing slashes', () => {
    expect(buildGroupInviteLink({ shortCode: 'ABC2D3', origin: 'https://events.rallypt.app/' }))
      .toBe('https://events.rallypt.app/groups/join?code=ABC2D3')
  })

  it('falls back to the bare join page when no code yet', () => {
    expect(buildGroupInviteLink({ shortCode: null, origin: 'https://x.test' })).toBe(
      'https://x.test/groups/join',
    )
  })
})

describe('buildShareUrl', () => {
  const input = { url: 'https://x.test/groups/join?code=ABC2D3', message: 'Join my crew!' }

  it('covers exactly sms/whatsapp/x/line', () => {
    expect(SHARE_TARGETS).toEqual(['sms', 'whatsapp', 'x', 'line'])
  })

  it('sms/whatsapp embed message + url in one field', () => {
    expect(buildShareUrl('sms', input)).toBe(
      `sms:?body=${encodeURIComponent('Join my crew! https://x.test/groups/join?code=ABC2D3')}`,
    )
    expect(buildShareUrl('whatsapp', input)).toContain('https://wa.me/?text=')
    expect(decodeURIComponent(buildShareUrl('whatsapp', input))).toContain(input.url)
  })

  it('x/line split text and url params', () => {
    const x = buildShareUrl('x', input)
    expect(x).toContain('twitter.com/intent/tweet?')
    expect(x).toContain(`text=${encodeURIComponent(input.message)}`)
    expect(x).toContain(`url=${encodeURIComponent(input.url)}`)
    const line = buildShareUrl('line', input)
    expect(line).toContain('social-plugins.line.me/lineit/share?')
    expect(line).toContain(`url=${encodeURIComponent(input.url)}`)
  })
})
