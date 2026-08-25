// Typeahead input for picking a movement from the exercise catalog.
// The catalog list is fetched once by the parent (ComposerPage) and
// passed in so N movement rows share one fetch. Free text stays
// allowed — an unmatched name falls back to the slug id at save time —
// but picking a row binds the real catalog exerciseId, and the last
// dropdown row hands off to AddExerciseSheet for inline creation.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ExerciseDto } from '@rallypoint/fitness-shared'
import {
  shouldCloseOnBlur,
  shouldCloseOnOutsidePointerDown,
  shouldOpenOnFocus,
} from './picker-close.js'

export interface ExercisePickerProps {
  exercises: ExerciseDto[]
  value: string
  placeholder?: string
  onChange: (next: { name: string; exerciseId: string | null }) => void
  onCreate: (query: string) => void
}

const MAX_RESULTS = 8

// Primary-muscle hint under each row, e.g. "Lats · Biceps". The collapsed
// taxonomy slugs are single words, so capitalizing them is a faithful label
// without needing the muscle-groups fetch here.
function primaryMuscleHint(e: ExerciseDto): string {
  return e.muscles
    .filter((m) => m.role === 'primary')
    .slice(0, 3)
    .map((m) => m.muscleId.charAt(0).toUpperCase() + m.muscleId.slice(1).replace(/_/g, ' '))
    .join(' · ')
}

export function ExercisePicker({
  exercises,
  value,
  placeholder,
  onChange,
  onCreate,
}: ExercisePickerProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // True only while pick() is programmatically returning focus to the
  // input, so onFocus can tell that apart from the user focusing it.
  const restoringFocus = useRef(false)

  // Outside-press closing. This replaces blur-closing (which fired on
  // every keyboard dismissal and hid the results); a press anywhere
  // outside the picker is the unambiguous "I'm done here" signal.
  useEffect(() => {
    if (!open) return
    function onPointerDown(ev: PointerEvent) {
      const target = ev.target
      const inside =
        target instanceof Node && containerRef.current !== null
          ? containerRef.current.contains(target)
          : false
      if (shouldCloseOnOutsidePointerDown(inside)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase()
    if (!q) return exercises.slice(0, MAX_RESULTS)
    return exercises.filter((e) => e.name.toLowerCase().includes(q)).slice(0, MAX_RESULTS)
  }, [exercises, value])

  const exactMatch = useMemo(
    () => exercises.some((e) => e.name.toLowerCase() === value.trim().toLowerCase()),
    [exercises, value],
  )

  function pick(e: ExerciseDto) {
    onChange({ name: e.name, exerciseId: e.id })
    // Closing unmounts the popover, so a row picked by keyboard takes
    // the focused element with it and focus falls back to <body> —
    // the next Tab would restart from the top of the page. Put focus
    // back on the input so tabbing continues into this row's rep/load
    // fields. A no-op on the pointer path, where preventDefault kept
    // focus on the input the whole time.
    //
    // The flag is what makes this safe: `.focus()` dispatches focusin
    // synchronously, so without it the input's onFocus would re-open
    // the dropdown we're closing (same React batch, last write wins)
    // and scroll the row on every pick.
    restoringFocus.current = true
    inputRef.current?.focus()
    restoringFocus.current = false
    setOpen(false)
  }

  function startCreate() {
    setOpen(false)
    // No focus restore here, unlike pick(): this opens AddExerciseSheet,
    // which autoFocuses its own first field.
    onCreate(value.trim())
  }

  // Enter/Space on a focused row. The rows are reachable by Tab, but
  // their pointerdown handler calls preventDefault (to hold focus), so
  // no click ever reaches them — keyboard activation needs its own
  // path. Keying off keydown rather than click keeps the two input
  // modes disjoint, so neither can fire the other's handler twice.
  function onRowKeyDown(ev: React.KeyboardEvent, activate: () => void) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return
    ev.preventDefault()
    activate()
  }

  return (
    <div
      className="ex-pick"
      ref={containerRef}
      // Escape lives on the container, not the input, so it also closes
      // the dropdown while focus sits on one of the result rows.
      onKeyDown={(ev) => {
        if (ev.key === 'Escape' && open) {
          ev.stopPropagation()
          setOpen(false)
        }
      }}
    >
      <input
        ref={inputRef}
        className="pl-input"
        value={value}
        onChange={(e) => {
          onChange({ name: e.target.value, exerciseId: null })
          setOpen(true)
        }}
        onFocus={() => {
          // Focus we put back after a pick isn't the user asking for
          // the list again.
          if (!shouldOpenOnFocus(restoringFocus.current)) return
          setOpen(true)
          // Scroll the container (not the input) so `.ex-pick`'s
          // scroll-margin — which reserves the popover's height below
          // the row — is what gets brought into view, keeping the
          // results clear of the on-screen keyboard. 'nearest' means
          // rows that already have room don't jump.
          containerRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        }}
        onBlur={(ev) => {
          const next = ev.relatedTarget
          const inside =
            next instanceof Node && containerRef.current !== null
              ? containerRef.current.contains(next)
              : false
          if (shouldCloseOnBlur(next !== null, inside)) setOpen(false)
        }}
        placeholder={placeholder}
        style={{ width: '100%' }}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
      />
      {open && (matches.length > 0 || value.trim()) && (
        <div role="listbox" className="ex-pick-pop">
          {matches.map((e) => (
            <button
              key={e.id}
              type="button"
              role="option"
              aria-selected={false}
              className="ex-pick-row"
              // pointerdown (not click) so the pick lands even while the
              // input still holds focus, and preventDefault keeps focus
              // where it is instead of bouncing the keyboard. Covers
              // touch and mouse in one handler, so there's no emulated
              // second event to double-fire on.
              onPointerDown={(ev) => {
                ev.preventDefault()
                pick(e)
              }}
              onKeyDown={(ev) => onRowKeyDown(ev, () => pick(e))}
            >
              <span className="ex-pick-nm">
                {e.name}
                {primaryMuscleHint(e) && (
                  <span className="ex-pick-hint">{primaryMuscleHint(e)}</span>
                )}
              </span>
              {e.isCustom && <span className="pl-chip sm">CUSTOM</span>}
            </button>
          ))}
          {value.trim() && !exactMatch && (
            <button
              type="button"
              className="ex-pick-create"
              onPointerDown={(ev) => {
                ev.preventDefault()
                startCreate()
              }}
              onKeyDown={(ev) => onRowKeyDown(ev, startCreate)}
            >
              + Create “{value.trim()}”
            </button>
          )}
        </div>
      )}
    </div>
  )
}
