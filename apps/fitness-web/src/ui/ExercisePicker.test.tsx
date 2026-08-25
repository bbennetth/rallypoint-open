// @vitest-environment jsdom
//
// The picker's open/close rules are pure and unit-tested in
// picker-close.test.ts. What can't be covered there is the wiring:
// whether a real focus transition re-enters onFocus mid-batch. These
// tests drive actual DOM focus (not fireEvent.focus, which doesn't move
// document.activeElement and would hide exactly the bug they guard).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ExerciseDto } from '@rallypoint/fitness-shared'
import { ExercisePicker } from './ExercisePicker.js'

/** Real DOM focus (so document.activeElement actually moves — which
 *  fireEvent.focus does not do), wrapped so React flushes the result. */
function focus(el: HTMLElement) {
  act(() => el.focus())
}

// jsdom implements no layout, so it ships no scrollIntoView. Every real
// browser has it; stub it so the focus behaviour under test can run.
const scrollIntoView = vi.fn()
Element.prototype.scrollIntoView = scrollIntoView

afterEach(() => scrollIntoView.mockClear())

afterEach(cleanup)

function exercise(over: Partial<ExerciseDto> & { id: string; name: string }): ExerciseDto {
  return {
    isCustom: false,
    muscles: [{ muscleId: 'glutes', role: 'primary' }],
    ...over,
  } as ExerciseDto
}

const CATALOG = [
  exercise({ id: 'ex_conv', name: 'Conventional Deadlift' }),
  exercise({ id: 'ex_def', name: 'Deficit Deadlift' }),
]

function renderPicker(value = 'dead') {
  const onChange = vi.fn()
  const onCreate = vi.fn()
  render(
    <ExercisePicker
      exercises={CATALOG}
      value={value}
      onChange={onChange}
      onCreate={onCreate}
    />,
  )
  const input = screen.getByRole('combobox') as HTMLInputElement
  return { input, onChange, onCreate }
}

describe('ExercisePicker dropdown lifecycle', () => {
  it('keeps the results up when the on-screen keyboard is dismissed', () => {
    // The reported bug: dismissing the iOS keyboard blurs the input with
    // no relatedTarget, which used to close the list the user was reading.
    const { input } = renderPicker()
    focus(input)
    expect(screen.getByRole('listbox')).toBeTruthy()

    fireEvent.blur(input, { relatedTarget: null })

    expect(screen.queryByRole('listbox')).not.toBeNull()
  })

  it('closes when focus moves to an unrelated field', () => {
    const { input } = renderPicker()
    focus(input)
    const outside = document.createElement('input')
    document.body.appendChild(outside)

    fireEvent.blur(input, { relatedTarget: outside })

    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('closes for good when a row is picked by keyboard', () => {
    // Regression guard: pick() restores focus to the input, and .focus()
    // dispatches focusin synchronously — so without the restoring-focus
    // flag, onFocus re-opened the dropdown in the same React batch and
    // the list popped straight back up.
    const { input, onChange } = renderPicker()
    focus(input)
    const row = screen.getByText('Conventional Deadlift').closest('button')!

    focus(row)
    fireEvent.keyDown(row, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith({ name: 'Conventional Deadlift', exerciseId: 'ex_conv' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(input)
    // The restored focus must not be mistaken for a user focus: that
    // would re-run onFocus, smooth-scrolling the row on every pick.
    // (Once, from the opening focus() at the top of this test.)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('closes for good when a row is picked by pointer', () => {
    const { input, onChange } = renderPicker()
    focus(input)
    const row = screen.getByText('Deficit Deadlift').closest('button')!

    fireEvent.pointerDown(row)

    expect(onChange).toHaveBeenCalledWith({ name: 'Deficit Deadlift', exerciseId: 'ex_def' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('still opens on a genuine focus after a pick', () => {
    // The suppression flag must not latch: the pointer path never fires
    // onFocus, so a flag cleared only inside onFocus would stay set and
    // swallow the user's next focus.
    const { input } = renderPicker()
    focus(input)
    fireEvent.pointerDown(screen.getByText('Deficit Deadlift').closest('button')!)
    expect(screen.queryByRole('listbox')).toBeNull()

    act(() => input.blur())
    focus(input)

    expect(screen.queryByRole('listbox')).not.toBeNull()
  })

  it('closes on Escape while focus sits on a row', () => {
    const { input } = renderPicker()
    focus(input)
    const row = screen.getByText('Conventional Deadlift').closest('button')!
    focus(row)

    fireEvent.keyDown(row, { key: 'Escape' })

    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
