// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CheckboxField } from './CheckboxField.js'

afterEach(cleanup)

describe('CheckboxField', () => {
  it('keeps native checkbox labeling and change behavior', () => {
    const onChange = vi.fn()
    render(<CheckboxField label="Save for next time" onChange={onChange} />)
    const checkbox = screen.getByRole('checkbox', { name: 'Save for next time' })
    expect(checkbox.getAttribute('type')).toBe('checkbox')
    checkbox.focus()
    expect(document.activeElement).toBe(checkbox)
    fireEvent.click(screen.getByText('Save for next time'))
    expect(onChange).toHaveBeenCalledOnce()
  })

  it('renders hint/error relationships and disabled state', () => {
    const { rerender } = render(
      <CheckboxField label="Private food" hint="Only you can see it" disabled />,
    )
    const checkbox = screen.getByRole('checkbox', { name: 'Private food' })
    expect((checkbox as HTMLInputElement).disabled).toBe(true)
    expect(checkbox.getAttribute('aria-describedby')).toBeTruthy()
    expect(screen.getByText('Only you can see it')).toBeTruthy()

    rerender(<CheckboxField label="Private food" error="Grams are required" />)
    expect(screen.getByText('Grams are required')).toBeTruthy()
    expect(screen.getByRole('checkbox').getAttribute('aria-invalid')).toBe('true')
  })
})
