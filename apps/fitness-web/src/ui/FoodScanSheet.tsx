// Capture surface for the food logger's scan paths. It CAPTURES; it does
// not review — the estimate goes straight to the review sheet, which hosts
// the refine loop (see ScanRefineBlock). There used to be a read-only
// results screen here handing off to an editable one showing the same
// numbers; merging them removed a tap and a whole phase.
//
// Photo/text scan state lives in the page's useFoodScan session, because a
// refine happens while this sheet is unmounted. Barcode + nutrition-label
// remain local — they resolve to an item in one shot and have no loop.

import { useState } from 'react'
import { Banner, Button, Drawer, Field, ImagePickerField } from '@rallypoint/ui'
import { captureException } from '@rallypoint/web-kit'
import type { FoodItemDto } from '@rallypoint/fitness-shared'
import { ApiError, lookupFoodBarcode, scanNutritionLabel, sendAiFeedback } from '../lib/api.js'
import { decodeBarcodeFromFile } from '../lib/barcode.js'
import { LiveBarcodeScanner } from './LiveBarcodeScanner.js'
import type { FoodScanController } from './use-food-scan.js'

// 'text' is the photo scanner, text only ("I ate 5 cherries"): no image,
// quantities come from the words, so no portion-bias calibration.
export type FoodScanMode = 'barcode' | 'photo' | 'text'

export interface FoodScanSheetProps {
  mode: FoodScanMode
  // The page's scan session. Photo/text results are read from here, not
  // handed back by callback — a refine fires while this sheet is closed.
  session: FoodScanController
  onClose: () => void
  onBarcodeItem: (item: FoodItemDto) => void
  // The barcode is unknown and the user chose to enter it by hand instead
  // of scanning the label.
  onBarcodeUnknown: (upc: string) => void
  // An unknown barcode's Nutrition Facts label was read by AI into an
  // unsaved candidate item (source 'ai', keyed by the upc). The token
  // authorizes the shared-cache write on save.
  onLabelItem: (item: FoodItemDto, contributionToken: string) => void
  // "Incorrect?" flow: open straight into the nutrition-label capture for
  // this UPC (skipping the scanner) to re-read and REPLACE bad cached
  // data. Copy switches to correction wording and the manual-entry escape
  // hatch is hidden (a manual entry can't fix the shared row).
  correctUpc?: string
}

type LocalPhase = 'pick' | 'working' | 'error'

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

export function FoodScanSheet({
  mode,
  session,
  onClose,
  onBarcodeItem,
  onBarcodeUnknown,
  onLabelItem,
  correctUpc,
}: FoodScanSheetProps) {
  const [phase, setPhase] = useState<LocalPhase>('pick')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [barcodeFile, setBarcodeFile] = useState<File | null>(null)
  // Photo mode's confirm step: an optional second photo and free-text
  // context, both gathered BEFORE the first scan. `context` seeds from the
  // session so reopening the sheet after an error doesn't drop what was
  // already typed.
  const [supportingFile, setSupportingFile] = useState<File | null>(null)
  const [context, setContext] = useState(session.base)
  // Text mode: the free-text meal description.
  const [description, setDescription] = useState('')
  const [descriptionError, setDescriptionError] = useState<string | null>(null)
  // Set when a scanned barcode is unknown to both our cache and OFF — the
  // sheet then offers the nutrition-label capture sub-flow.
  const [unknownUpc, setUnknownUpc] = useState<string | null>(correctUpc ?? null)
  const [labelFile, setLabelFile] = useState<File | null>(null)
  const [labelProductFile, setLabelProductFile] = useState<File | null>(null)
  const [barcodeSource, setBarcodeSource] = useState<'live' | 'photo'>('live')
  // The UPC whose lookup failed (e.g. Open Food Facts outage) — lets the
  // error state offer "Try again" without making the user rescan.
  const [failedUpc, setFailedUpc] = useState<string | null>(null)

  const title = correctUpc
    ? 'Fix this product'
    : mode === 'barcode'
      ? 'Scan a barcode'
      : mode === 'text'
        ? 'Describe your food'
        : 'Scan your food'

  // Photo/text run on the session; barcode/label on local phase.
  const scanning = mode === 'barcode' ? phase === 'working' : session.phase === 'working'
  const shownError = mode === 'barcode' ? error : (error ?? session.error)

  function closeWithFeedback() {
    // Walking away from an un-logged estimate is a rejection signal — but
    // only the photo/text modes own the session; a barcode close reporting
    // against it would attribute the wrong capture.
    if (mode !== 'barcode') session.abandon()
    onClose()
  }

  async function handleUpc(upc: string) {
    setPhase('working')
    setError(null)
    setNotice(null)
    setFailedUpc(null)
    try {
      const res = await lookupFoodBarcode(upc)
      if (res.item) {
        onBarcodeItem(res.item)
      } else {
        // Unknown to our cache + OFF — offer the nutrition-label read.
        setUnknownUpc(upc)
        setPhase('pick')
      }
    } catch (err: unknown) {
      captureException(err, { feature: 'food-scan', scan_step: 'barcode-lookup', ...errMeta(err) })
      setError(errMessage(err, 'Barcode lookup failed.'))
      setFailedUpc(upc)
      setPhase('error')
    }
  }

  // Explicitly pressed, not auto-fired on pick: a successful read hands off
  // and closes the sheet, so auto-firing would strand the optional
  // product-front photo the user hasn't added yet.
  async function runLabelScan(upc: string, label: File, product: File | null) {
    setPhase('working')
    setError(null)
    try {
      const { item, contributionToken, responseId } = await scanNutritionLabel(upc, label, product)
      if (responseId) void sendAiFeedback(responseId, 'accepted', item)
      onLabelItem(item, contributionToken)
    } catch (err: unknown) {
      captureException(err, {
        feature: 'food-scan',
        scan_step: 'label-scan',
        image_bytes: label.size,
        image_mime: label.type || 'unknown',
        product_image_bytes: product?.size ?? 0,
        ...errMeta(err),
      })
      setError(errMessage(err, "Couldn't read the nutrition facts — try a sharper photo of the panel."))
      // Stay in the label sub-flow (unknownUpc still set) so the user can
      // retake without rescanning the barcode.
      setPhase('pick')
    }
  }

  async function handleBarcodeFile(file: File) {
    setBarcodeFile(file)
    setPhase('working')
    setError(null)
    // A decode failure is a different error than a lookup failure — don't
    // leave a stale "Try again" pointing at a previously failed UPC.
    setFailedUpc(null)
    try {
      const upc = await decodeBarcodeFromFile(file)
      if (!upc) {
        setError('No barcode found — try a closer, sharper shot of the code.')
        setPhase('error')
        return
      }
      await handleUpc(upc)
    } catch (err: unknown) {
      captureException(err, { feature: 'food-scan', scan_step: 'barcode-decode', ...errMeta(err) })
      setError(errMessage(err, 'Barcode lookup failed.'))
      setPhase('error')
    }
  }

  function fallbackToPhoto(reason?: string) {
    setBarcodeSource('photo')
    setNotice(reason ?? null)
  }

  return (
    <Drawer open mobileSheet title={title} onClose={closeWithFeedback}>
      <div className="food-flow">
        {shownError && <Banner tone="error">{shownError}</Banner>}
        {notice && <Banner tone="info">{notice}</Banner>}

        {/* A failed lookup (e.g. Open Food Facts outage) keeps the decoded
            digits — retry the lookup without rescanning the barcode. */}
        {mode === 'barcode' && phase === 'error' && failedUpc !== null && (
          <div className="btn-row">
            <Button onClick={() => void handleUpc(failedUpc)}>Try again</Button>
          </div>
        )}

        {mode === 'barcode' &&
          unknownUpc === null &&
          barcodeSource === 'live' &&
          phase === 'pick' && (
            <LiveBarcodeScanner onDetected={handleUpc} onFallbackToPhoto={fallbackToPhoto} />
          )}

        {mode === 'barcode' &&
          unknownUpc === null &&
          !(barcodeSource === 'live' && phase === 'pick') && (
            <ImagePickerField
              label="Barcode photo"
              hint="The barcode is decoded on your device; only its digits are sent."
              file={barcodeFile}
              onChange={(next) => {
                setBarcodeFile(next)
                if (next) void handleBarcodeFile(next)
              }}
              status={phase === 'working' ? 'working' : error ? 'error' : undefined}
              error={error ?? undefined}
              disabled={phase === 'working'}
            />
          )}

        {mode === 'barcode' && unknownUpc !== null && (
          <div className="food-flow">
            <Banner tone="info">
              {correctUpc
                ? `Photograph the Nutrition Facts label for barcode ${unknownUpc} and we'll re-read the macros — saving replaces the incorrect saved nutrition for everyone.`
                : `Barcode ${unknownUpc} isn't in our database or Open Food Facts yet. Photograph its Nutrition Facts label and we'll read the macros — saving adds it for everyone.`}
            </Banner>
            <div className="food-photo-grid">
              <ImagePickerField
                label="Nutrition facts label"
                hint="Required. Fill the frame with the panel; avoid glare."
                required
                file={labelFile}
                onChange={setLabelFile}
                status={phase === 'working' ? 'working' : undefined}
                disabled={phase === 'working'}
              />
              <ImagePickerField
                label="Product name & brand"
                hint="Optional. The front of the package."
                file={labelProductFile}
                onChange={setLabelProductFile}
                status={phase === 'working' ? 'working' : undefined}
                disabled={phase === 'working'}
              />
            </div>
            <div className="btn-row">
              {!correctUpc && (
                <Button
                  variant="ghost"
                  onClick={() => onBarcodeUnknown(unknownUpc)}
                  disabled={phase === 'working'}
                >
                  Enter manually instead
                </Button>
              )}
              <Button
                onClick={() => {
                  if (labelFile) void runLabelScan(unknownUpc, labelFile, labelProductFile)
                }}
                disabled={!labelFile || phase === 'working'}
                loading={phase === 'working'}
              >
                {phase === 'working' ? 'Reading…' : 'Read the label'}
              </Button>
            </div>
          </div>
        )}

        {mode === 'text' && (
          <>
            <Field
              label="What did you eat or drink?"
              placeholder="e.g. 5 cherries, a bowl of oatmeal with honey"
              value={description}
              disabled={scanning}
              onChange={(event) => setDescription(event.target.value)}
              {...(descriptionError ? { error: descriptionError } : {})}
            />
            <Button
              onClick={() => {
                const desc = description.trim()
                if (!desc) {
                  setDescriptionError('Describe what you ate before analyzing.')
                  return
                }
                setDescriptionError(null)
                session.startText(desc)
              }}
              disabled={!description.trim() || scanning}
              loading={scanning}
            >
              {scanning ? 'Estimating…' : 'Estimate nutrition'}
            </Button>
          </>
        )}

        {/* Photo mode opens on the confirm step: the trigger already picked
            the file, and this is the last stop before an AI call — swap the
            shot, add a menu/label photo, or type what the model can't see. */}
        {mode === 'photo' && (
          <>
            <div className="food-photo-grid">
              <ImagePickerField
                label="Food photo"
                hint="Show the portion you ate."
                required
                file={session.photo}
                onChange={(next) => {
                  if (next) {
                    // A replacement is a new subject: stage() clears the
                    // session's stored context, so the local fields have to
                    // go with it or the old meal's notes ride along.
                    session.stage(next)
                    setContext('')
                    setSupportingFile(null)
                  }
                }}
                status={scanning ? 'working' : session.error ? 'error' : undefined}
                disabled={scanning}
              />
              <ImagePickerField
                label="Menu or ingredient photo"
                hint="Optional. Add a menu, label, recipe, or ingredient view."
                file={supportingFile}
                onChange={setSupportingFile}
                status={scanning ? 'working' : undefined}
                disabled={scanning}
              />
            </div>
            <Field
              label="Context (optional)"
              placeholder="e.g. total weight 300g, lean ground beef"
              value={context}
              disabled={scanning}
              onChange={(event) => setContext(event.target.value)}
            />
            <Button
              onClick={() => session.analyze({ base: context, supporting: supportingFile })}
              disabled={!session.photo || scanning}
              loading={scanning}
            >
              {scanning ? 'Analyzing…' : 'Analyze meal'}
            </Button>
          </>
        )}
      </div>
    </Drawer>
  )
}
