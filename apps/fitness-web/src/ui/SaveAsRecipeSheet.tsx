// Save-as-recipe sheet: snapshot a prepared meal's ingredient lines into a
// reusable recipe you can cook from later. Name required; notes + servings
// optional (servings prefills from the batch when it has one).

import { useState } from 'react'
import { Banner, Button, Drawer, Field } from '@rallypoint/ui'
import type { RecipeDto } from '@rallypoint/fitness-shared'
import { ApiError, saveMealPrepAsRecipe } from '../lib/api.js'

export interface SaveAsRecipeSheetProps {
  mealId: string
  defaultName: string
  defaultServings: number | null
  onClose: () => void
  onSaved: (recipe: RecipeDto) => void
}

export function SaveAsRecipeSheet({
  mealId,
  defaultName,
  defaultServings,
  onClose,
  onSaved,
}: SaveAsRecipeSheetProps) {
  const [name, setName] = useState(defaultName)
  const [notes, setNotes] = useState('')
  const [servings, setServings] = useState(defaultServings !== null ? String(defaultServings) : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    setError(null)
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Give this recipe a name.')
      return
    }
    let servingsNum: number | undefined
    if (servings.trim() !== '') {
      const n = Number(servings)
      if (!isFinite(n) || n <= 0) {
        setError('Servings must be a positive number.')
        return
      }
      servingsNum = n
    }
    setSaving(true)
    try {
      const recipe = await saveMealPrepAsRecipe(mealId, {
        name: trimmed,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(servingsNum !== undefined ? { servings: servingsNum } : {}),
      })
      onSaved(recipe)
      onClose()
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not save that recipe.',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer open mobileSheet title="Save as recipe" onClose={onClose}>
      <div style={{ display: 'grid', gap: 14 }}>
        {error && <Banner tone="error">{error}</Banner>}
        <Field label="Recipe name" value={name} onChange={(e) => setName(e.target.value)} />
        <Field
          label="Notes (optional)"
          placeholder="e.g. double the chili powder next time"
          maxLength={2000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <Field
          label="Servings (optional)"
          type="number"
          min={0}
          inputMode="decimal"
          value={servings}
          onChange={(e) => setServings(e.target.value)}
        />
        <div className="btn-row">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving} loading={saving}>
            {saving ? 'Saving…' : 'Save recipe'}
          </Button>
        </div>
      </div>
    </Drawer>
  )
}
