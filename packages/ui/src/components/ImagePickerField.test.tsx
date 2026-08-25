// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { ImagePickerField, type ImagePickerFieldProps } from './ImagePickerField.js'

const createObjectURL = vi.fn<(file: Blob) => string>()
const revokeObjectURL = vi.fn<(url: string) => void>()

beforeEach(() => {
  createObjectURL.mockReset()
  revokeObjectURL.mockReset()
  createObjectURL.mockImplementation(
    (file) => `blob:${file.size}:${createObjectURL.mock.calls.length}`,
  )
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
})

afterEach(cleanup)

function Controlled(props: Partial<ImagePickerFieldProps> = {}) {
  const [file, setFile] = useState<File | null>(null)
  return <ImagePickerField label="Food photo" file={file} onChange={setFile} {...props} />
}

describe('ImagePickerField', () => {
  it('selects, replaces, removes, and permits same-file reselection through one input', () => {
    render(<Controlled />)
    // One input, no capture attribute: the OS chooser offers camera AND
    // library itself, so reproducing that split in-app would only cost a tap.
    const input = screen.getByLabelText('Food photo: add a photo') as HTMLInputElement
    expect(screen.queryByLabelText('Food photo: take a photo')).toBeNull()
    expect(screen.queryByLabelText('Food photo: choose from library')).toBeNull()
    expect(input.getAttribute('capture')).toBeNull()

    const first = new File(['one'], 'meal.jpg', { type: 'image/jpeg' })
    fireEvent.change(input, { target: { files: [first] } })
    expect(screen.getByText('Selected')).toBeTruthy()
    expect(input.value).toBe('')
    expect(screen.getByRole('button', { name: 'Replace photo' })).toBeTruthy()

    const replacement = new File(['two'], 'menu.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [replacement] } })
    expect(createObjectURL).toHaveBeenCalledWith(replacement)
    expect(revokeObjectURL).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(screen.getByText('No image selected')).toBeTruthy()
    fireEvent.change(input, { target: { files: [first] } })
    expect(screen.getByText('Selected')).toBeTruthy()
  })

  it('opens the picker from the button without a user-activation-breaking hop', () => {
    render(<Controlled />)
    const input = screen.getByLabelText('Food photo: add a photo')
    const click = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByRole('button', { name: 'Add photo' }))
    // Synchronous within the onClick — anything deferred loses Safari's
    // user-activation token and the picker silently never opens.
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('cleans up previews on controlled replacement and unmount', () => {
    const first = new File(['one'], 'one.jpg', { type: 'image/jpeg' })
    const second = new File(['two'], 'two.jpg', { type: 'image/jpeg' })
    const { rerender, unmount } = render(
      <ImagePickerField label="Progress" file={first} onChange={() => {}} />,
    )
    rerender(<ImagePickerField label="Progress" file={second} onChange={() => {}} />)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:3:1')
    unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:3:2')
  })

  it('exposes required descriptions, tile/state variants, errors, and disabled controls', () => {
    render(
      <ImagePickerField
        label="Front"
        hint="Show your full pose"
        required
        variant="tile"
        status="working"
        error="Upload failed"
        file={null}
        onChange={() => {}}
        disabled
      />,
    )
    expect(screen.getByText(/Front/).textContent).toContain('(required)')
    expect(screen.getByText('Upload failed')).toBeTruthy()
    expect(screen.getByText('Working')).toBeTruthy()
    expect(screen.getByRole('group').className).toContain('image-picker--tile')
    expect((screen.getByRole('button', { name: 'Add photo' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(screen.getByLabelText('Front: add a photo').getAttribute('aria-required')).toBe('true')
  })
})
