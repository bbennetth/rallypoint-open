// Prompt shown when one of the actor's custom-exercise submissions has
// been approved and the admin's global replacement is ready: offer to
// roll the actor's logged history onto the new global exercise, or keep
// the custom exercise (and its history) separate. One offer at a time —
// the chrome-level MigrationOfferGate advances to the next offer (if
// any) after each response.

import { useState } from 'react'
import { ConfirmDialog } from '@rallypoint/ui'
import type { SubmissionDto } from '@rallypoint/fitness-shared'

export interface SubmissionMigratePromptProps {
  submission: SubmissionDto
  onDecide: (accept: boolean) => void | Promise<void>
  onDismiss: () => void
}

export function SubmissionMigratePrompt({
  submission,
  onDecide,
  onDismiss,
}: SubmissionMigratePromptProps) {
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
      title="Your custom exercise is now built-in"
      body={`"${submission.exerciseName}" was approved and is now part of the catalog. Migrate your logged history to the catalog version?`}
      confirmLabel="Migrate"
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
