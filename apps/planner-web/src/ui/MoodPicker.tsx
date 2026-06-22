import type { FieldDefDto } from '../lib/api.js'

// Toggle-chip picker over a single_select field's choices (used for the diary
// Mood field). Shared by the Diary page composer/editor and the quick-add FAB.
// Clicking the active choice clears it (passes null).
export function MoodPicker({
  field,
  value,
  onChange,
  disabled,
}: {
  field: FieldDefDto
  value: string | null
  onChange: (choiceId: string | null) => void
  disabled?: boolean
}) {
  const choices = (field.options.choices ?? []).filter((c) => !c.archived)
  return (
    <div
      role="group"
      aria-label={field.label}
      style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}
    >
      {choices.map((c) => {
        const on = value === c.id
        return (
          <button
            key={c.id}
            type="button"
            className="pl-chip toggle"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(on ? null : c.id)}
            style={{
              cursor: disabled ? 'default' : 'pointer',
              borderColor: on ? 'var(--acid)' : 'var(--line)',
              color: on ? 'var(--acid)' : 'var(--ink-mute)',
              background: on ? 'var(--accent-soft)' : 'transparent',
            }}
          >
            {c.label}
          </button>
        )
      })}
    </div>
  )
}
