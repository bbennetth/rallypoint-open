import type { FieldDefDto, GroupMemberDto } from '../lib/api.js'
import { CustomFieldsEditor } from './CustomFieldsEditor.js'
import { missingRequiredFieldIds } from '../lib/field-form.js'

export function ListAddItemForm({
  isBoard,
  onSubmit,
  newTitle,
  onTitleChange,
  adding,
  fieldDefs,
  newCustomFields,
  addResetKey,
  members,
  onCustomFieldChange,
}: {
  isBoard: boolean
  onSubmit: (e: React.FormEvent) => void
  newTitle: string
  onTitleChange: (value: string) => void
  adding: boolean
  fieldDefs: FieldDefDto[]
  newCustomFields: Record<string, unknown>
  addResetKey: number
  members: GroupMemberDto[]
  onCustomFieldChange: (fieldId: string, value: unknown | null) => void
}) {
  return (
    <form
      onSubmit={onSubmit}
      className="space-y-3"
      style={isBoard ? { maxWidth: '640px' } : undefined}
    >
      <div className="flex items-end gap-3">
        <label className="flex-1 text-sm text-[color:var(--ink-dim)]">
          Add an item
          <input
            value={newTitle}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="e.g. Bring the tent"
            className="cyber-input mt-1"
          />
        </label>
        <button
          type="submit"
          disabled={
            adding ||
            newTitle.trim().length === 0 ||
            missingRequiredFieldIds(fieldDefs, newCustomFields).length > 0
          }
          className="btn-brutal"
          style={{ width: 'auto' }}
        >
          {adding ? 'Adding…' : 'Add'}
        </button>
      </div>
      {fieldDefs.length > 0 && (
        <CustomFieldsEditor
          key={addResetKey}
          defs={fieldDefs}
          values={newCustomFields}
          members={members}
          onChange={onCustomFieldChange}
        />
      )}
    </form>
  )
}
