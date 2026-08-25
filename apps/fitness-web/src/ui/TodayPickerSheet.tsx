// The action list behind each of the /log dashboard's two hero tiles —
// "how do you want to log food?" and "what do you want to start?". One
// component for both so the two halves of the dashboard read the same.
//
// A row runs its action and then closes. That order matters for the
// photo row: `useFilePicker`'s `.click()` has to fire inside the tap's
// user activation, and closing first would re-render before it ran. The
// picker's `<input>` lives with the capture hook up in the page, not in
// this sheet, so unmounting the sheet never orphans it.

import { Drawer, Icon, type IconName } from '@rallypoint/ui'

export interface TodayPickerItem {
  key: string
  label: string
  icon: IconName
  /** Optional second line — what the action actually does. */
  hint?: string
  onSelect: () => void
}

export function TodayPickerSheet({
  open,
  title,
  items,
  onClose,
}: {
  open: boolean
  title: string
  items: readonly TodayPickerItem[]
  onClose: () => void
}) {
  return (
    <Drawer open={open} mobileSheet title={title} onClose={onClose}>
      <div className="fit-picker">
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            className="fit-picker-row"
            onClick={() => {
              it.onSelect()
              onClose()
            }}
          >
            <span className="ico" aria-hidden>
              <Icon name={it.icon} size={16} />
            </span>
            <span className="txt">
              <span className="nm">{it.label}</span>
              {it.hint && <span className="hint">{it.hint}</span>}
            </span>
            <span className="go" aria-hidden>
              <Icon name="chevron" size={14} stroke={2} />
            </span>
          </button>
        ))}
      </div>
    </Drawer>
  )
}
