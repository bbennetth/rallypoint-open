// Prompt shown when one of the actor's food-contribution submissions
// (an AI-read nutrition-label UPC) has been approved and the admin's
// global replacement is ready: offer to link the actor's logged entries
// to the new global food item, or keep the private one separate. One
// offer at a time — FoodPage re-checks after each response, so a
// second offer (if any) surfaces on the next render. Mirrors
// SubmissionMigratePrompt.tsx (the exercise-catalog equivalent).

import { useState } from 'react'
import { ConfirmDialog } from '@rallypoint/ui'
import type { FoodSubmissionDto } from '@rallypoint/fitness-shared'

export interface FoodSubmissionMigratePromptProps {
  submission: FoodSubmissionDto
  onDecide: (accept: boolean) => void | Promise<void>
  onDismiss: () => void
}

export function FoodSubmissionMigratePrompt({
  submission,
  onDecide,
  onDismiss,
}: FoodSubmissionMigratePromptProps) {
  const [busy, setBusy] = useState(false)

  async function decide(accept: boolean) {
    setBusy(true)
    try {
      await onDecide(accept)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ConfirmDialog
      open
      title="Your food contribution is now in the shared database"
      body={`"${submission.name}" is now in the shared food database — link your logged entries to it?`}
      confirmLabel="Link history"
      confirmVariant="brutal"
      busy={busy}
      onConfirm={() => decide(true)}
      extraAction={{
        label: 'Keep separate',
        onAction: () => decide(false),
      }}
      onCancel={onDismiss}
    />
  )
}
