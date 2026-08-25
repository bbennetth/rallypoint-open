// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import type { ChangeEvent } from 'react'

// Tmp-id guards: a just-created event carries a tmp id until its outbox
// create flushes; ticket load + upload are raw request/response and must
// not target an id the server hasn't minted.

vi.mock('../lib/api.js', () => ({
  ApiError: class ApiError extends Error {},
  listTickets: vi.fn().mockResolvedValue([{ id: 'tk_1' }]),
  uploadTicket: vi.fn().mockResolvedValue({ id: 'tk_new' }),
  getTicketDownloadUrl: vi.fn().mockReturnValue('http://localhost/dl'),
}))

import { listTickets, uploadTicket } from '../lib/api.js'
import { useEventTickets, ACCEPTED_MIME } from './useEventTickets.js'

function pickEvent(file: File): ChangeEvent<HTMLInputElement> {
  return {
    target: { files: [file], value: '' },
  } as unknown as ChangeEvent<HTMLInputElement>
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useEventTickets — tmp-id guards', () => {
  it('skips the tickets load for a tmp event id', async () => {
    const onError = vi.fn()
    renderHook(() => useEventTickets('tmp_abc', onError))
    await new Promise((r) => setTimeout(r, 10))
    expect(listTickets).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('loads tickets for a real event id', async () => {
    const onError = vi.fn()
    const { result } = renderHook(() => useEventTickets('evt_real', onError))
    await waitFor(() => expect(result.current.tickets).toEqual([{ id: 'tk_1' }]))
    expect(listTickets).toHaveBeenCalledWith('evt_real')
  })

  it('refuses an upload while the event id is temporary', async () => {
    const onError = vi.fn()
    const { result } = renderHook(() => useEventTickets('tmp_abc', onError))
    const file = new File(['x'], 't.pdf', { type: ACCEPTED_MIME[3]! })
    await act(async () => {
      await result.current.onPickFile(pickEvent(file))
    })
    expect(uploadTicket).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('still syncing'))
  })

  it('uploads normally for a real event id', async () => {
    const onError = vi.fn()
    const { result } = renderHook(() => useEventTickets('evt_real', onError))
    const file = new File(['x'], 't.pdf', { type: ACCEPTED_MIME[3]! })
    await act(async () => {
      await result.current.onPickFile(pickEvent(file))
    })
    expect(uploadTicket).toHaveBeenCalledWith('evt_real', file)
    expect(onError).not.toHaveBeenCalled()
  })
})
