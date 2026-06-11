import { describe, it, expect } from 'vitest'
import {
  CONNECTING_STALE_MS,
  CONNECTION_COLORS,
  RECENTLY_SYNCED_GRACE_MS,
  decideConnectionView,
  wasRecentlyConnected,
} from './connection-status.js'

const NOW = 1_700_000_000_000

describe('decideConnectionView', () => {
  it('returns connected when online + synced', () => {
    const v = decideConnectionView({
      online: true,
      synced: true,
      lastSyncedAt: NOW - 60_000,
      now: NOW,
    })
    expect(v.phase).toBe('connected')
    expect(v.color).toBe(CONNECTION_COLORS.connected)
    expect(v.title).toContain('Connected')
  })

  it('returns connecting when online but not synced + watchdog has not fired', () => {
    const v = decideConnectionView({
      online: true,
      synced: false,
      lastSyncedAt: NOW - 5_000,
      connectingStale: false,
      now: NOW,
    })
    expect(v.phase).toBe('connecting')
    expect(v.color).toBe(CONNECTION_COLORS.connecting)
    expect(v.title).toContain('Reconnecting')
  })

  it('returns connecting when watchdog fired but inside the recently-connected grace', () => {
    const v = decideConnectionView({
      online: true,
      synced: false,
      lastSyncedAt: NOW - 60_000,
      connectingStale: true,
      syncLostAt: NOW - 10_000, // 10s ago → inside the 30s grace
      now: NOW,
    })
    expect(v.phase).toBe('connecting')
  })

  it('returns offline when watchdog fired and grace has expired', () => {
    const v = decideConnectionView({
      online: true,
      synced: false,
      lastSyncedAt: NOW - 5 * 60_000,
      connectingStale: true,
      syncLostAt: NOW - (RECENTLY_SYNCED_GRACE_MS + 5_000),
      now: NOW,
    })
    expect(v.phase).toBe('offline')
    expect(v.color).toBe(CONNECTION_COLORS.offline)
    expect(v.title).toContain('Offline')
  })

  it('returns offline immediately when navigator.onLine is false (bypasses grace)', () => {
    const v = decideConnectionView({
      online: false,
      synced: false,
      lastSyncedAt: NOW - 1_000,
      connectingStale: false,
      syncLostAt: NOW - 1_000, // still well inside grace
      now: NOW,
    })
    expect(v.phase).toBe('offline')
  })

  it('uses "changes queue locally" copy when there is no prior sync to reference', () => {
    const v = decideConnectionView({
      online: false,
      synced: false,
      lastSyncedAt: null,
      now: NOW,
    })
    expect(v.title).toBe('Offline — changes queue locally')
  })

  it('uses bare "Reconnecting" copy when there is no prior sync timestamp', () => {
    const v = decideConnectionView({
      online: true,
      synced: false,
      lastSyncedAt: null,
      now: NOW,
    })
    expect(v.title).toBe('Reconnecting')
  })
})

describe('wasRecentlyConnected', () => {
  it('returns false for a null syncLostAt', () => {
    expect(wasRecentlyConnected(null, NOW)).toBe(false)
  })
  it('returns true inside the grace window', () => {
    expect(wasRecentlyConnected(NOW - 5_000, NOW)).toBe(true)
  })
  it('returns false outside the grace window', () => {
    expect(wasRecentlyConnected(NOW - (RECENTLY_SYNCED_GRACE_MS + 100), NOW)).toBe(false)
  })
  it('exposes a sane CONNECTING_STALE_MS', () => {
    expect(CONNECTING_STALE_MS).toBeGreaterThanOrEqual(1000)
  })
})
