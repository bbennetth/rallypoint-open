// The live AI food-scan session: pure reducer (lib/food-scan-session.ts)
// plus the network calls and the AI-trace telemetry.
//
// Held by the PAGE, not the capture sheet, because the estimate has to
// outlive FoodScanSheet — the review sheet hosts the refine loop, so a
// rerun happens while the capture sheet is unmounted.

import { useCallback, useMemo, useRef, useState } from 'react'
import { captureException } from '@rallypoint/web-kit'
import type { ScannedMealEstimate } from '@rallypoint/fitness-shared'
import { ApiError, scanFoodPhoto, scanFoodText, sendAiFeedback } from '../lib/api.js'
import {
  acceptTarget,
  estimateOf,
  foodScanReducer,
  openQuestions,
  rejectTarget,
  retryTarget,
  scanContextFor,
  INITIAL_FOOD_SCAN,
  type FoodScanAction,
  type FoodScanKind,
  type FoodScanPhase,
  type FoodScanSession,
  type QaPair,
} from '../lib/food-scan-session.js'

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : err instanceof Error ? err.message : fallback
}

// Surface the transport/server error code + status on the $exception so
// PostHog shows a real, filterable failure (network_error / timeout /
// ai_capacity / scan_failed) instead of an opaque "TypeError: Load
// failed" with an empty stack. Non-ApiError throws add nothing.
function errMeta(err: unknown): { error_code?: string; http_status?: number } {
  return err instanceof ApiError ? { error_code: err.code, http_status: err.status } : {}
}

export interface RefineInput {
  answers: QaPair[]
  correction: string
}

export interface FoodScanController {
  phase: FoodScanPhase
  kind: FoodScanKind
  estimate: ScannedMealEstimate | null
  openQuestions: string[]
  // The staged/analyzed photo, so the capture sheet can preview it.
  photo: File | null
  // Context the user typed before analyzing; kept so a reopened sheet shows
  // it rather than dropping it.
  base: string
  portionBias: number
  responseId: string | null
  revision: number
  error: string | null
  // Hold a freshly picked photo WITHOUT scanning it. The capture sheet then
  // shows the confirm step (context + optional second photo); nothing is
  // sent until analyze().
  stage: (file: File) => void
  analyze: (input: { base: string; supporting: File | null }) => void
  startText: (text: string) => void
  // Re-run the current subject with more context. Answers and a free-text
  // correction go together in ONE pass (they used to be two round-trips).
  refine: (input: RefineInput) => void
  // Attach a menu/label/ingredient photo and re-run.
  addSupportingPhoto: (file: File) => void
  // The user saved: report acceptance and latch, so the subsequent close
  // isn't also reported as an abandon.
  accept: () => void
  // The user walked away from an un-logged estimate: a rejection signal.
  abandon: () => void
  reset: () => void
}

export function useFoodScan(): FoodScanController {
  const [session, setSession] = useState<FoodScanSession>(INITIAL_FOOD_SCAN)
  // Mirrors `session` so the async runner reads the state it just produced
  // rather than the render's stale closure.
  const ref = useRef(session)
  // The subject of the current chain, kept out of session state because a
  // File isn't part of the pure model. The ref is what the async runner
  // reads; the state is what renders the preview.
  const photo = useRef<File | null>(null)
  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const supporting = useRef<File | null>(null)
  const description = useRef('')
  // Guards against a stale in-flight pass overwriting a newer one (the user
  // can re-pick or refine while a scan is still running).
  const passId = useRef(0)

  const apply = useCallback((action: FoodScanAction): FoodScanSession => {
    const next = foodScanReducer(ref.current, action)
    ref.current = next
    setSession(next)
    return next
  }, [])

  const run = useCallback(
    async (state: FoodScanSession, base?: string) => {
      // No subject means nothing to scan. Bail BEFORE entering 'working',
      // or the sheet spins forever on a state that can never resolve.
      const file = photo.current
      const text = description.current.trim()
      if (state.kind === 'text' ? text === '' : file === null) return

      // A re-run over an existing response is a retry of it.
      const retry = retryTarget(state)
      if (retry) void sendAiFeedback(retry, 'retried')

      const mine = ++passId.current
      const parent = state.firstResponseId
      // Fold `base` in BEFORE assembling the context, so the first pass
      // carries what the user typed on the confirm step.
      const running = apply(base === undefined ? { type: 'run' } : { type: 'run', base })
      const context = scanContextFor(running)

      try {
        if (running.kind === 'text') {
          const { scan, responseId } = await scanFoodText(text, context || undefined, parent)
          if (mine !== passId.current) return
          apply(
            scan.items.length === 0 && scan.questions.length === 0
              ? { type: 'run:empty' }
              : { type: 'run:ok', scan, portionBias: 1, responseId },
          )
          return
        }

        // Narrowed by the subject guard above; erroring rather than
        // returning keeps an impossible state from parking on a spinner.
        if (!file) {
          apply({ type: 'run:error', message: 'Pick a photo to analyze.' })
          return
        }
        const { scan, portionBias, responseId } = await scanFoodPhoto(
          file,
          supporting.current,
          context || undefined,
          parent,
        )
        if (mine !== passId.current) return
        apply(
          scan.items.length === 0 && scan.questions.length === 0
            ? { type: 'run:empty' }
            : { type: 'run:ok', scan, portionBias, responseId },
        )
      } catch (err: unknown) {
        if (mine !== passId.current) return
        if (running.kind === 'text') {
          captureException(err, { feature: 'food-scan', scan_step: 'text-scan', ...errMeta(err) })
          apply({
            type: 'run:error',
            message: errMessage(err, 'Could not estimate the food from that description.'),
          })
          return
        }
        captureException(err, {
          feature: 'food-scan',
          scan_step: 'photo-scan',
          image_bytes: photo.current?.size ?? 0,
          image_mime: photo.current?.type || 'unknown',
          supporting_image_bytes: supporting.current?.size ?? 0,
          ...errMeta(err),
        })
        apply({
          type: 'run:error',
          message: errMessage(err, 'Could not read the food from that photo.'),
        })
      }
    },
    [apply],
  )

  // Pick-without-analyzing: the capture sheet opens on the confirm step so
  // the user can add context or a second photo before an AI call is spent.
  const stage = useCallback(
    (file: File) => {
      // Invalidate any pass still in flight. Without this a slow scan of a
      // photo the user has since replaced still lands, and the review sheet
      // shows the OLD photo's estimate next to the NEW photo's preview.
      passId.current += 1
      photo.current = file
      setPhotoFile(file)
      supporting.current = null
      apply({ type: 'start', kind: 'photo' })
    },
    [apply],
  )

  const analyze = useCallback(
    (input: { base: string; supporting: File | null }) => {
      supporting.current = input.supporting
      void run(ref.current, input.base)
    },
    [run],
  )

  const startText = useCallback(
    (text: string) => {
      description.current = text
      photo.current = null
      setPhotoFile(null)
      void run(apply({ type: 'start', kind: 'text' }))
    },
    [apply, run],
  )

  const refine = useCallback(
    (input: RefineInput) => void run(apply({ type: 'refine', ...input })),
    [apply, run],
  )

  const addSupportingPhoto = useCallback(
    (file: File) => {
      supporting.current = file
      void run(ref.current)
    },
    [run],
  )

  const accept = useCallback(() => {
    // Already latched (e.g. a repeat save): don't re-apply — a no-op state
    // churn while the estimate is on screen re-fires open-on-ready effects.
    if (ref.current.feedbackSent) return
    const target = acceptTarget(ref.current)
    const meal = estimateOf(ref.current)
    // Report the AI's estimate, not the user's confirmed values — the
    // "user corrected it" signal already exists server-side, and changing
    // this payload would fork the trace corpus.
    if (target) void sendAiFeedback(target, 'accepted', meal ?? undefined)
    apply({ type: 'feedback:sent' })
  }, [apply])

  const abandon = useCallback(() => {
    const target = rejectTarget(ref.current)
    if (!target) return
    void sendAiFeedback(target, 'rejected')
    apply({ type: 'feedback:sent' })
  }, [apply])

  const reset = useCallback(() => {
    passId.current += 1
    photo.current = null
    setPhotoFile(null)
    supporting.current = null
    description.current = ''
    apply({ type: 'reset' })
  }, [apply])

  return useMemo(
    () => ({
      phase: session.phase,
      kind: session.kind,
      estimate: estimateOf(session),
      openQuestions: openQuestions(session),
      photo: photoFile,
      base: session.base,
      portionBias: session.portionBias,
      responseId: session.lastResponseId,
      revision: session.revision,
      error: session.error,
      stage,
      analyze,
      startText,
      refine,
      addSupportingPhoto,
      accept,
      abandon,
      reset,
    }),
    [session, photoFile, stage, analyze, startText, refine, addSupportingPhoto, accept, abandon, reset],
  )
}
