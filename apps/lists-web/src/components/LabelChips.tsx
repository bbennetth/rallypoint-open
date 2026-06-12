import type { LabelDto } from '../lib/api.js'
import { resolveLabels, toggleLabelId } from '../lib/labels.js'
import { statusColorStyle } from '../lib/status-colors.js'

// Label chips + an inline picker for one item (RPL v1.0.0 S12 UI). Renders
// the attached labels as colored chips; a 🏷 disclosure (native <details>,
// so no popover positioning logic) toggles any of the list's labels on the
// item via a full label-id replacement. Renders nothing when the list has
// no labels and the item carries none.

interface LabelChipsProps {
  labelIds: string[]
  labels: LabelDto[]
  onSetLabels: (labelIds: string[]) => void
}

export function LabelChips({ labelIds, labels, onSetLabels }: LabelChipsProps) {
  const attached = resolveLabels(labelIds, labels)
  if (labels.length === 0 && attached.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1">
      {attached.map((l) => (
        <span
          key={l.id}
          className="rounded-full border px-2 py-0.5 text-xs"
          style={statusColorStyle(l.color)}
          title={l.name}
        >
          {l.name}
        </span>
      ))}
      {labels.length > 0 && (
        <details className="relative">
          <summary
            className="cursor-pointer list-none rounded px-1 text-xs text-[color:var(--ink-dim)] hover:text-[color:var(--ink)]"
            title="Edit labels"
            aria-label="Edit labels"
          >
            🏷
          </summary>
          <div
            className="absolute z-10 mt-1 max-h-48 w-44 overflow-auto p-2"
            style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
          >
            {labels.map((l) => (
              <label key={l.id} className="flex items-center gap-2 py-0.5 text-xs">
                <input
                  type="checkbox"
                  checked={labelIds.includes(l.id)}
                  onChange={() => onSetLabels(toggleLabelId(labelIds, l.id))}
                  className="h-3.5 w-3.5"
                  style={{ accentColor: statusColorStyle(l.color).borderColor }}
                />
                <span
                  className="truncate rounded-full border px-1.5"
                  style={statusColorStyle(l.color)}
                >
                  {l.name}
                </span>
              </label>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
