// One-tap meal camera for the Food sub-bar. Tapping it opens the OS
// picker directly — no popover, no in-app camera/library choice, no
// "analyze" press — so a photo goes from tap to review sheet in two taps.
//
// Rendered next to FoodQuickAdd's `+` in the sub-bar's fab slot, styled
// quiet so the `+` stays the primary action.

import { Icon, useFilePicker } from '@rallypoint/ui'

export function FoodSnapButton({ onPhoto }: { onPhoto: (file: File) => void }) {
  const picker = useFilePicker({ onPick: onPhoto, ariaLabel: 'Snap a meal' })
  return (
    <>
      <button
        type="button"
        className="rp-fab rp-fab-quiet"
        aria-label="Snap a meal"
        onClick={picker.open}
      >
        <Icon name="camera" size={18} />
      </button>
      {picker.input}
    </>
  )
}
