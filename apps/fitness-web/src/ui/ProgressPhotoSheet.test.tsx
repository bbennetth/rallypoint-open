// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  listProgressPhotoPoses: vi.fn(),
  uploadProgressPhoto: vi.fn(),
  downscaleImage: vi.fn(),
  fileExifDate: vi.fn(),
}))

vi.mock('../lib/api.js', () => ({
  ApiError: class ApiError extends Error {},
  listProgressPhotoPoses: mocks.listProgressPhotoPoses,
  uploadProgressPhoto: mocks.uploadProgressPhoto,
}))
vi.mock('../lib/image.js', () => ({ downscaleImage: mocks.downscaleImage }))
vi.mock('../lib/exif.js', () => ({ fileExifDate: mocks.fileExifDate }))

import { ProgressPhotoSheet } from './ProgressPhotoSheet.js'

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.listProgressPhotoPoses.mockResolvedValue([])
  mocks.downscaleImage.mockImplementation(async (file: File) => file)
  mocks.fileExifDate.mockResolvedValue(new Date('2026-07-01T18:30:00.000Z'))
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => `blob:${Math.random()}`),
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
})

afterEach(cleanup)

describe('ProgressPhotoSheet shared picker regression', () => {
  it('keeps EXIF prefill, per-slot upload, partial success, and retry behavior', async () => {
    const firstDto = {
      id: 'pp_front',
      setId: 'fps_one',
      takenAt: '2026-07-01T18:30:00.000Z',
      pose: 'front',
      contentType: 'image/jpeg',
      sizeBytes: 5,
      note: null,
      createdAt: '2026-07-01T18:30:00.000Z',
      url: '/front',
    }
    const secondDto = { ...firstDto, id: 'pp_back', pose: 'back', url: '/back' }
    mocks.uploadProgressPhoto
      .mockResolvedValueOnce(firstDto)
      .mockRejectedValueOnce(new Error('temporary upload failure'))
      .mockResolvedValueOnce(secondDto)
    const onSaved = vi.fn()
    render(<ProgressPhotoSheet onClose={() => {}} onSaved={onSaved} />)

    expect(screen.getByRole('group', { name: 'Front' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Back' })).toBeTruthy()
    const front = new File(['front'], 'front.jpg', { type: 'image/jpeg' })
    const back = new File(['back'], 'back.jpg', { type: 'image/jpeg' })
    fireEvent.change(screen.getByLabelText('Front: add a photo'), {
      target: { files: [front] },
    })
    fireEvent.change(screen.getByLabelText('Back: add a photo'), {
      target: { files: [back] },
    })
    await waitFor(() => expect(mocks.fileExifDate).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: 'Save 2 photos' }))
    expect(await screen.findByRole('button', { name: 'Retry failed' })).toBeTruthy()
    expect(mocks.uploadProgressPhoto).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: 'Retry failed' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(mocks.uploadProgressPhoto).toHaveBeenCalledTimes(3)
    expect(mocks.uploadProgressPhoto.mock.calls.filter((call) => call[0] === front)).toHaveLength(1)
    expect(mocks.uploadProgressPhoto.mock.calls[2]?.[1]).toMatchObject({ setId: 'fps_one' })
  })
})
