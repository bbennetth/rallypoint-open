import { describe, expect, it } from 'vitest'
import {
  shouldCloseOnBlur,
  shouldCloseOnOutsidePointerDown,
  shouldOpenOnFocus,
} from './picker-close.js'

describe('shouldCloseOnBlur', () => {
  it('keeps the dropdown open when the keyboard is dismissed', () => {
    // iOS "done"/collapse blurs the input with no focus destination —
    // the case that used to wipe the results mid-read.
    expect(shouldCloseOnBlur(false, false)).toBe(false)
  })

  it('keeps the dropdown open when focus moves into the dropdown itself', () => {
    expect(shouldCloseOnBlur(true, true)).toBe(false)
  })

  it('closes when focus moves to an element outside the picker', () => {
    expect(shouldCloseOnBlur(true, false)).toBe(true)
  })
})

describe('shouldOpenOnFocus', () => {
  it('opens the dropdown when the user focuses the input', () => {
    expect(shouldOpenOnFocus(false)).toBe(true)
  })

  it('does not re-open the dropdown pick() is closing', () => {
    // pick() restores focus to the input synchronously; treating that
    // as a user focus would reopen the list and re-scroll on every pick.
    expect(shouldOpenOnFocus(true)).toBe(false)
  })
})

describe('shouldCloseOnOutsidePointerDown', () => {
  it('closes on a press outside the picker', () => {
    expect(shouldCloseOnOutsidePointerDown(false)).toBe(true)
  })

  it('stays open for presses inside the picker (rows, scrollbar)', () => {
    expect(shouldCloseOnOutsidePointerDown(true)).toBe(false)
  })
})
