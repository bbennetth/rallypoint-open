// The AI refine loop, hosted on the REVIEW sheet rather than a separate
// results screen. Merging the two review screens is what removes a tap; this
// is the piece that has to come along, because it drives the portion-bias
// calibration and the 'retried' AI-trace signal.
//
// Clarifying questions render here as an optional sharpen, never a gate —
// the estimate is already on screen and savable behind this block. One
// "Re-analyze" submits the answers AND the free-text correction together;
// they used to cost two separate round-trips.
//
// Shared by FoodConfirmSheet (diary) and MealPrepIngredientSheet (recipe)
// so neither path loses the loop.

import { useState } from 'react'
import { Banner, Button, Field, useFilePicker } from '@rallypoint/ui'
import type { QaPair } from '../lib/food-scan-session.js'

export interface ScanRefineProps {
  // Clarifying questions the model is still waiting on. Empty is the
  // common case.
  questions: string[]
  // A rerun is in flight: the host disables Save, because the estimate the
  // user is looking at is about to be replaced.
  busy: boolean
  // A failed rerun. Shown here rather than swallowed — the capture sheet
  // used to own the error banner, but a refine happens with that sheet
  // closed, so without this the numbers just silently stay stale.
  error?: string | null | undefined
  onRerun: (input: { answers: QaPair[]; correction: string }) => void
  // Attach a menu / label / ingredient photo and re-run with it.
  onAddSupportingPhoto?: ((file: File) => void) | undefined
}

export function ScanRefineBlock({
  questions,
  busy,
  error,
  onRerun,
  onAddSupportingPhoto,
}: ScanRefineProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [correction, setCorrection] = useState('')
  const picker = useFilePicker({
    onPick: (file) => onAddSupportingPhoto?.(file),
    ariaLabel: 'Add a menu or label photo',
    disabled: busy,
  })

  const filled = questions
    .map((question) => ({ question, answer: answers[question]?.trim() ?? '' }))
    .filter((pair) => pair.answer !== '')
  const canRerun = !busy && (filled.length > 0 || correction.trim() !== '')

  function rerun() {
    if (!canRerun) return
    onRerun({ answers: filled, correction: correction.trim() })
    setAnswers({})
    setCorrection('')
  }

  return (
    <div className="food-flow">
      {error && <Banner tone="error">{error}</Banner>}
      {questions.length > 0 && (
        <>
          <Banner tone="info">
            Optional — answering these sharpens the estimate. You can log it as-is.
          </Banner>
          {questions.map((question) => (
            <Field
              key={question}
              label={question}
              value={answers[question] ?? ''}
              disabled={busy}
              onChange={(event) =>
                setAnswers((current) => ({ ...current, [question]: event.target.value }))
              }
            />
          ))}
        </>
      )}

      <Field
        label="Not quite right? Tell the AI what to fix"
        placeholder="e.g. there are no beans in here"
        value={correction}
        disabled={busy}
        onChange={(event) => setCorrection(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') rerun()
        }}
      />

      <div className="btn-row">
        {onAddSupportingPhoto && (
          <Button variant="ghost" onClick={picker.open} disabled={busy}>
            Add a menu or label photo
          </Button>
        )}
        <Button onClick={rerun} disabled={!canRerun} loading={busy}>
          {busy ? 'Re-analyzing…' : 'Re-analyze'}
        </Button>
      </div>
      {/* Rendered unconditionally — an input inside a conditional branch
          unmounts before `change` fires and the pick is silently lost. */}
      {picker.input}
    </div>
  )
}
