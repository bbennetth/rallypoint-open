import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useConnectionStore, selectCanEdit } from './connection.js'

beforeEach(() => {
  useConnectionStore.setState({
    online: true,
    synced: false,
    syncLostAt: null,
    bootstrapStale: false,
  })
})

describe('useConnectionStore', () => {
  it('setOnline updates the online field', () => {
    useConnectionStore.getState().setOnline(false)
    expect(useConnectionStore.getState().online).toBe(false)
  })

  it('setSynced(true) clears syncLostAt', () => {
    useConnectionStore.setState({ synced: false, syncLostAt: 1_000 })
    useConnectionStore.getState().setSynced(true)
    const s = useConnectionStore.getState()
    expect(s.synced).toBe(true)
    expect(s.syncLostAt).toBeNull()
  })

  it('first true→false transition stamps syncLostAt', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(123_456)
    useConnectionStore.setState({ synced: true, syncLostAt: null })
    useConnectionStore.getState().setSynced(false)
    expect(useConnectionStore.getState().syncLostAt).toBe(123_456)
    now.mockRestore()
  })

  it('repeated false→false does NOT refresh syncLostAt', () => {
    useConnectionStore.setState({ synced: true, syncLostAt: null })
    const now = vi.spyOn(Date, 'now').mockReturnValue(100)
    useConnectionStore.getState().setSynced(false)
    expect(useConnectionStore.getState().syncLostAt).toBe(100)
    now.mockReturnValue(200)
    useConnectionStore.getState().setSynced(false)
    // Still 100 — the grace window must measure from the original drop.
    expect(useConnectionStore.getState().syncLostAt).toBe(100)
    now.mockRestore()
  })

  it('selectCanEdit gates on both flags', () => {
    expect(selectCanEdit({ online: true, synced: true } as never)).toBe(true)
    expect(selectCanEdit({ online: false, synced: true } as never)).toBe(false)
    expect(selectCanEdit({ online: true, synced: false } as never)).toBe(false)
  })
})
