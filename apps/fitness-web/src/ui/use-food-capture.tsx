// The food CAPTURE stack — barcode / photo / text / label / search /
// manual — as a hook, so the Food tab and the /log dashboard drive one
// implementation instead of two copies. (A fix to the barcode
// "Incorrect?" flow used to have to land twice.)
//
// Scope is deliberately the CREATE paths only. Editing an existing diary
// row, the drink logger, and the shared-cache migration prompt stay on
// FoodPage: the dashboard never exercises them, so hoisting them here
// would widen the surface for nothing.
//
// Mount `node` ONCE and UNCONDITIONALLY. It carries the sheets AND, via
// FoodScanSheet, the file input behind the camera paths — a `<input>`
// rendered inside a `{open && …}` branch never fires `change`.

import { useEffect, useState, type ReactNode } from 'react'
import { MASS_ONLY_UNIT_CTX } from '@rallypoint/fitness-shared'
import type { FoodFavoriteDto, FoodItemDto, FoodLogEntryDto } from '@rallypoint/fitness-shared'
import {
  confirmStateFromItem,
  loggedAtFor,
  photoConfirmProps,
  textConfirmProps,
  unitCtxFromItem,
  type FoodConfirmState,
} from '../lib/food-view.js'
import { foodContributionNotice } from '../lib/food-submissions.js'
import { useFoodScan } from './use-food-scan.js'
import { FoodConfirmSheet } from './FoodConfirmSheet.js'
import { FoodScanSheet, type FoodScanMode } from './FoodScanSheet.js'
import { FoodSearchSheet } from './FoodSearchSheet.js'

type ConfirmTarget =
  | { kind: 'barcode'; item: FoodItemDto }
  // Photo/text are MARKERS, not payloads: the estimate lives in the scan
  // session so a refine from the review sheet can replace it in place.
  | { kind: 'photo' }
  // A text-described meal ("I ate 5 cherries") — the photo scanner, text
  // only. Logs with source 'text'; no portionBias (quantities are stated).
  | { kind: 'text' }
  // A name-search pick — a cached FoodItemDto logged as a manual entry
  // (with provenance), distinct from the barcode-scan path.
  | { kind: 'search'; item: FoodItemDto }
  // An AI-read nutrition label for an unknown UPC: an unsaved candidate
  // (source 'ai') that logs AND contributes the reviewed product to the
  // shared cache on save. `token` authorizes the contribution (verified
  // server-side). `correction` marks the "Incorrect?" re-scan of an
  // already-cached UPC: saving replaces the shared row instead of
  // contributing a new one.
  | { kind: 'label'; item: FoodItemDto; token: string; correction?: boolean }
  | { kind: 'manual'; upc?: string; name?: string }

const EMPTY_FORM: FoodConfirmState = {
  name: '',
  grams: '',
  unit: 'g',
  amount: '',
  kcal: '',
  proteinG: '',
  carbsG: '',
  fatG: '',
  note: '',
}

/** The capture paths a host can trigger. The photo path is separate
 *  (`onPhoto`) because its file picker has to open inside the triggering
 *  gesture. */
export type FoodCaptureAction = 'barcode' | 'text' | 'manual'

export interface FoodCapture {
  /** Stage a picked photo and open the confirm-before-analyze step. */
  onPhoto: (file: File) => void
  openAction: (action: FoodCaptureAction) => void
  /** Transient post-save notice (a shared-cache contribution). The host
   *  renders it wherever its own layout puts banners. */
  notice: string | null
  /** The sheet stack. Mount once, unconditionally. */
  node: ReactNode
}

export interface FoodCaptureOptions {
  /** The day being logged onto ('YYYY-MM-DD'). */
  date: string
  /** The user's local today, for `loggedAtFor`'s now-vs-noon rule. */
  today: string
  /** Fired after any create-path save lands. */
  onSaved: (entry?: FoodLogEntryDto) => void
  /** Pinned quick-log templates offered at the top of the search sheet
   *  before the user types. Omit (with `onLogFavorite`) on hosts that
   *  don't offer one-tap re-logging. */
  favorites?: FoodFavoriteDto[]
  /** Re-log a pin. The sheet closes itself first — the host owns the
   *  write, same as it owns `onSaved`. */
  onLogFavorite?: (fav: FoodFavoriteDto) => void
}

export function useFoodCapture({
  date,
  today,
  onSaved,
  favorites,
  onLogFavorite,
}: FoodCaptureOptions): FoodCapture {
  const [scanMode, setScanMode] = useState<FoodScanMode | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmTarget | null>(null)
  // "Incorrect?" flow: the UPC whose cached nutrition the user is
  // re-scanning the label for. Opens FoodScanSheet straight into the
  // label capture; the corrected read comes back as a label candidate
  // with correction: true.
  const [correctUpc, setCorrectUpc] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // The AI scan session for the photo/text paths. Held HERE, above the
  // capture sheet, because a refine from the review sheet re-runs while
  // the capture sheet is closed.
  const session = useFoodScan()

  // An estimate landed: close the capture sheet and show the ONE review
  // screen. Re-fires on every refine pass, which is what keeps the review
  // sheet open and re-seeded while the user iterates.
  useEffect(() => {
    if (session.phase !== 'ready' || !session.estimate) return
    setScanMode(null)
    setConfirm({ kind: session.kind === 'text' ? 'text' : 'photo' })
  }, [session.phase, session.revision, session.estimate, session.kind])

  // Transient post-save notice — clears on the next save cycle or after a
  // short delay so it doesn't linger.
  useEffect(() => {
    if (!notice) return
    const id = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(id)
  }, [notice])

  function confirmProps() {
    if (!confirm) return null
    const loggedAt = loggedAtFor(date, today)
    if (confirm.kind === 'barcode' || confirm.kind === 'search') {
      const grams = confirm.item.servingGrams ?? 100
      const scannedUpc = confirm.kind === 'barcode' ? confirm.item.upc : null
      // A searched item is a hand-picked add, logged as manual; the
      // barcode path keeps its 'barcode' provenance.
      const source: 'barcode' | 'manual' = confirm.kind === 'barcode' ? 'barcode' : 'manual'
      return {
        title: 'Confirm & log',
        initial: confirmStateFromItem(confirm.item, grams),
        source,
        per100g: confirm.item.per100g,
        unitCtx: unitCtxFromItem(confirm.item),
        foodItemId: confirm.item.id,
        loggedAt,
        estimateNotice: null,
        // "Incorrect?" — barcode candidates with a UPC can hand off to a
        // label re-scan that replaces the cached nutrition.
        ...(scannedUpc
          ? {
              onReportIncorrect: () => {
                setConfirm(null)
                setCorrectUpc(scannedUpc)
              },
            }
          : {}),
      }
    }
    if (confirm.kind === 'label') {
      // AI-read label candidate — not yet persisted. Logs the entry AND
      // contributes the reviewed product to the shared cache (saveAsUpc);
      // no foodItemId (the row doesn't exist until this save).
      const it = confirm.item
      const grams = it.servingGrams ?? 100
      const correction = confirm.correction === true
      return {
        title: correction ? 'Confirm the fix' : 'Confirm & save',
        initial: confirmStateFromItem(it, grams),
        source: 'barcode' as const,
        per100g: it.per100g,
        unitCtx: unitCtxFromItem(it),
        loggedAt,
        estimateNotice: correction
          ? 'AI-read from the label — check the numbers. Saving logs this and replaces the saved nutrition for this barcode.'
          : 'AI-read from the label — check the numbers. Saving logs this and adds the product to our database.',
        ...(it.upc
          ? {
              saveAsUpc: {
                upc: it.upc,
                token: confirm.token,
                brand: it.brand,
                servingGrams: it.servingGrams ?? grams,
                servingUnit: it.servingUnit ?? ('g' as const),
                isLiquid: it.isLiquid,
                ...(correction ? { correction: true as const } : {}),
              },
            }
          : {}),
      }
    }
    if (confirm.kind === 'photo' || confirm.kind === 'text') {
      const meal = session.estimate
      if (!meal) return null
      const props =
        confirm.kind === 'photo'
          ? photoConfirmProps(
              meal,
              { responseId: session.responseId, portionBias: session.portionBias },
              loggedAt,
            )
          : textConfirmProps(meal, { responseId: session.responseId }, loggedAt)
      return {
        ...props,
        // The refine loop lives here — this IS the results screen.
        revision: session.revision,
        refine: {
          questions: session.openQuestions,
          busy: session.phase === 'working',
          error: session.error,
          onRerun: session.refine,
          ...(confirm.kind === 'photo' ? { onAddSupportingPhoto: session.addSupportingPhoto } : {}),
        },
      }
    }
    return {
      title: 'Log food manually',
      initial: { ...EMPTY_FORM, name: confirm.name ?? '' },
      source: 'manual' as const,
      per100g: null,
      unitCtx: MASS_ONLY_UNIT_CTX,
      loggedAt,
      estimateNotice: confirm.upc
        ? `Barcode ${confirm.upc} isn't in Open Food Facts yet — enter it once here.`
        : null,
      allowSaveAsCustom: true,
    }
  }

  function openAction(action: FoodCaptureAction) {
    if (action === 'barcode') setScanMode('barcode')
    else if (action === 'text') {
      // The session outlives its sheet, so a fresh description must not
      // open under a previous scan's error banner.
      session.reset()
      setScanMode('text')
    } else setSearchOpen(true)
  }

  // A photo arrived from a one-tap trigger. It is STAGED, not scanned —
  // the sheet opens on the confirm step so context or a second photo can
  // still go in before an AI call is spent.
  function onPhoto(file: File) {
    // A new photo discards whatever estimate was pending; report it as
    // rejected before stage() wipes the chain (no-op when there's nothing
    // outstanding).
    session.abandon()
    setConfirm(null)
    setScanMode('photo')
    session.stage(file)
  }

  const cp = confirmProps()

  const node = (
    <>
      {scanMode && (
        <FoodScanSheet
          mode={scanMode}
          session={session}
          onClose={() => setScanMode(null)}
          onBarcodeItem={(item) => {
            setScanMode(null)
            setConfirm({ kind: 'barcode', item })
          }}
          onBarcodeUnknown={(upc) => {
            setScanMode(null)
            setConfirm({ kind: 'manual', upc })
          }}
          onLabelItem={(item, token) => {
            setScanMode(null)
            setConfirm({ kind: 'label', item, token })
          }}
        />
      )}

      {correctUpc && (
        <FoodScanSheet
          mode="barcode"
          session={session}
          correctUpc={correctUpc}
          onClose={() => setCorrectUpc(null)}
          onBarcodeItem={() => setCorrectUpc(null)}
          onBarcodeUnknown={() => setCorrectUpc(null)}
          onLabelItem={(item, token) => {
            setCorrectUpc(null)
            setConfirm({ kind: 'label', item, token, correction: true })
          }}
        />
      )}

      {searchOpen && (
        <FoodSearchSheet
          {...(favorites ? { favorites } : {})}
          {...(onLogFavorite
            ? {
                onLogFavorite: (fav: FoodFavoriteDto) => {
                  setSearchOpen(false)
                  onLogFavorite(fav)
                },
              }
            : {})}
          onClose={() => setSearchOpen(false)}
          onPick={(item) => {
            setSearchOpen(false)
            setConfirm({ kind: 'search', item })
          }}
          onManual={(name) => {
            setSearchOpen(false)
            setConfirm({ kind: 'manual', name })
          }}
        />
      )}

      {cp && (
        <FoodConfirmSheet
          {...cp}
          onClose={() => {
            // Only the AI-estimate targets own the scan session; this sheet
            // also serves barcode/label/search/manual, and reporting their
            // saves would attribute them to a stale AI trace.
            const wasEstimate = confirm?.kind === 'photo' || confirm?.kind === 'text'
            setConfirm(null)
            // Closing an un-logged AI estimate is the rejection signal —
            // no-op once a save has already latched acceptance.
            if (wasEstimate) session.abandon()
          }}
          onSaved={(entry) => {
            if (confirm?.kind === 'photo' || confirm?.kind === 'text') session.accept()
            setNotice(foodContributionNotice(entry?.contributionStatus))
            onSaved(entry)
          }}
        />
      )}
    </>
  )

  return { onPhoto, openAction, notice, node }
}
