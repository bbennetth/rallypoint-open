// Small chip shown in each weekday header on the Plan page's week view.
// Displays the day's assigned type (preset label or free-text) or a "+ Type"
// affordance when unset; tapping opens the DayTypeSheet editor. Self-managing
// (reads the global weekly-rhythm store + owns the open state) so DayBlock
// just drops it in without threading extra props.

import { useState } from 'react'
import { dayTypeDisplayLabel, type DayKey } from '@rallypoint/fitness-shared'
import { useDayTypes } from '../lib/day-type-settings.js'
import { DayTypeSheet } from './DayTypeSheet.js'

export function DayTypeChip({ dayKey }: { dayKey: DayKey }) {
  const value = useDayTypes()[dayKey]
  const [open, setOpen] = useState(false)
  const label = value ? dayTypeDisplayLabel(value) : null
  return (
    <>
      <button
        type="button"
        className={`day-type-chip${value ? ' set' : ''}`}
        aria-label={label ? `Change day type (currently ${label})` : 'Set day type'}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
      >
        {label ?? '+ Type'}
      </button>
      {open && <DayTypeSheet dayKey={dayKey} onClose={() => setOpen(false)} />}
    </>
  )
}
