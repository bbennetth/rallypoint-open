// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { FoodScanResult } from '@rallypoint/fitness-shared'

const mocks = vi.hoisted(() => ({
  scanFoodPhoto: vi.fn(),
  scanFoodText: vi.fn(),
  scanNutritionLabel: vi.fn(),
  lookupFoodBarcode: vi.fn(),
  searchFood: vi.fn(),
  createFoodLogEntry: vi.fn(),
  patchFoodLogEntry: vi.fn(),
  sendAiFeedback: vi.fn(),
}))

vi.mock('../lib/api.js', () => ({
  ApiError: class ApiError extends Error {},
  ...mocks,
}))

import { useEffect, useState } from 'react'
import { photoConfirmProps } from '../lib/food-view.js'
import { FoodConfirmSheet } from './FoodConfirmSheet.js'
import { FoodScanSheet } from './FoodScanSheet.js'
import { FoodSearchSheet } from './FoodSearchSheet.js'
import { useFoodCapture } from './use-food-capture.js'
import { useFoodScan } from './use-food-scan.js'

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => `blob:${Math.random()}`),
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
})

afterEach(cleanup)

// The photo path end-to-end, composed the way FoodPage composes it: a
// capture sheet that confirms before spending a scan, then ONE editable
// review sheet. The old read-only results screen (and its "Review and log
// meal" hand-off) is gone — the assertions that covered its internals now
// live in lib/food-scan-session.test.ts and lib/food-view.test.ts as
// node-env unit tests.
function PhotoFlowHarness() {
  const session = useFoodScan()
  const [confirmOpen, setConfirmOpen] = useState(false)
  useEffect(() => {
    if (session.phase === 'ready' && session.estimate) setConfirmOpen(true)
  }, [session.phase, session.revision, session.estimate])

  return (
    <>
      {!confirmOpen && (
        <FoodScanSheet
          mode="photo"
          session={session}
          onClose={() => {}}
          onBarcodeItem={() => {}}
          onBarcodeUnknown={() => {}}
          onLabelItem={() => {}}
        />
      )}
      {confirmOpen && session.estimate && (
        <FoodConfirmSheet
          {...photoConfirmProps(
            session.estimate,
            { responseId: session.responseId, portionBias: session.portionBias },
            new Date('2026-07-26T12:00:00.000Z'),
          )}
          revision={session.revision}
          refine={{
            questions: session.openQuestions,
            busy: session.phase === 'working',
            onRerun: session.refine,
            onAddSupportingPhoto: session.addSupportingPhoto,
          }}
          onClose={() => setConfirmOpen(false)}
          onSaved={() => {}}
        />
      )}
    </>
  )
}

// Barcode/label modes don't touch the scan session, but the sheet takes one
// — a real hook keeps the harness honest rather than a hand-rolled stub.
function BarcodeSheetHarness({ correctUpc }: { correctUpc?: string }) {
  const session = useFoodScan()
  return (
    <FoodScanSheet
      mode="barcode"
      session={session}
      {...(correctUpc ? { correctUpc } : {})}
      onClose={() => {}}
      onBarcodeItem={() => {}}
      onBarcodeUnknown={() => {}}
      onLabelItem={() => {}}
    />
  )
}

const PASTA: FoodScanResult = {
  mealName: 'Pasta dinner',
  estimatedServings: 1.5,
  items: [{ name: 'Pasta', estimatedGrams: 450, kcal: 700, proteinG: 24, carbsG: 110, fatG: 18 }],
  questions: [],
}
const food = () => new File(['food'], 'food.jpg', { type: 'image/jpeg' })

// Picking stages the photo; nothing is sent until Analyze is pressed.
function stagePhoto(file = food()) {
  fireEvent.change(screen.getByLabelText('Food photo: add a photo'), { target: { files: [file] } })
  return file
}

describe('nutrition capture flow', () => {
  it('confirms before spending a scan, then lands on the editable review sheet', async () => {
    mocks.scanFoodPhoto.mockResolvedValue({ scan: PASTA, portionBias: 1.0, responseId: null })
    render(<PhotoFlowHarness />)

    const picked = stagePhoto()
    // The confirm step: picking alone must not fire an AI call.
    expect(mocks.scanFoodPhoto).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Context (optional)')).toBeTruthy()
    expect(screen.getByRole('group', { name: /Menu or ingredient photo/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Analyze meal' }))
    await waitFor(() =>
      expect(mocks.scanFoodPhoto).toHaveBeenCalledWith(picked, null, undefined, null),
    )

    // Still only ONE review screen — no read-only summary in between.
    expect(await screen.findByRole('button', { name: 'Log it' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Review and log meal' })).toBeNull()
    expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('1.5')
  })

  it('sends the typed context and the optional second photo with the first pass', async () => {
    mocks.scanFoodPhoto.mockResolvedValue({ scan: PASTA, portionBias: 1.0, responseId: null })
    render(<PhotoFlowHarness />)

    const picked = stagePhoto()
    const menu = new File(['menu'], 'menu.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText('Menu or ingredient photo: add a photo'), {
      target: { files: [menu] },
    })
    fireEvent.change(screen.getByLabelText('Context (optional)'), {
      target: { value: 'total weight 300g' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Analyze meal' }))

    await waitFor(() =>
      expect(mocks.scanFoodPhoto).toHaveBeenCalledWith(picked, menu, 'total weight 300g', null),
    )
  })

  it('replaces the staged photo without scanning the discarded one', async () => {
    mocks.scanFoodPhoto.mockResolvedValue({ scan: PASTA, portionBias: 1.0, responseId: null })
    render(<PhotoFlowHarness />)

    stagePhoto()
    const better = new File(['better'], 'better.jpg', { type: 'image/jpeg' })
    stagePhoto(better)
    expect(mocks.scanFoodPhoto).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Analyze meal' }))
    await waitFor(() => expect(mocks.scanFoodPhoto).toHaveBeenCalledTimes(1))
    expect(mocks.scanFoodPhoto).toHaveBeenCalledWith(better, null, undefined, null)
  })

  it('drops a slow scan whose photo has already been replaced', async () => {
    // Otherwise the review sheet opens showing the OLD photo's estimate
    // next to the NEW photo's preview.
    let landStale: (v: unknown) => void = () => {}
    mocks.scanFoodPhoto.mockImplementationOnce(
      () => new Promise((resolve) => (landStale = resolve)),
    )
    render(<PhotoFlowHarness />)
    stagePhoto()
    fireEvent.click(screen.getByRole('button', { name: 'Analyze meal' }))

    // Replace while that first scan is still in flight, then let it land.
    stagePhoto(new File(['better'], 'better.jpg', { type: 'image/jpeg' }))
    // Settle fully before asserting an ABSENCE: the resolved continuation,
    // its state update and the ready-effect all have to get their chance,
    // or this passes for the wrong reason and pins nothing.
    await act(async () => {
      landStale({ scan: PASTA, portionBias: 1.0, responseId: 'stale' })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.queryByRole('button', { name: 'Log it' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Analyze meal' })).toBeTruthy()
  })

  it('clears the typed context and second photo when the photo is replaced', async () => {
    mocks.scanFoodPhoto.mockResolvedValue({ scan: PASTA, portionBias: 1.0, responseId: null })
    render(<PhotoFlowHarness />)

    stagePhoto()
    fireEvent.change(screen.getByLabelText('Menu or ingredient photo: add a photo'), {
      target: { files: [new File(['menu'], 'menu.png', { type: 'image/png' })] },
    })
    fireEvent.change(screen.getByLabelText('Context (optional)'), {
      target: { value: 'burger, total weight 300g' },
    })

    // A replacement is a different meal — the old notes must not ride along.
    const salad = new File(['salad'], 'salad.jpg', { type: 'image/jpeg' })
    stagePhoto(salad)
    expect((screen.getByLabelText('Context (optional)') as HTMLInputElement).value).toBe('')

    fireEvent.click(screen.getByRole('button', { name: 'Analyze meal' }))
    await waitFor(() =>
      expect(mocks.scanFoodPhoto).toHaveBeenCalledWith(salad, null, undefined, null),
    )
  })

  it('re-runs from the review sheet and re-seeds the form from the new estimate', async () => {
    mocks.scanFoodPhoto.mockResolvedValueOnce({
      scan: PASTA,
      portionBias: 1.0,
      responseId: 'resp_1',
    })
    render(<PhotoFlowHarness />)
    stagePhoto()
    fireEvent.click(screen.getByRole('button', { name: 'Analyze meal' }))
    await screen.findByRole('button', { name: 'Log it' })

    mocks.scanFoodPhoto.mockResolvedValueOnce({
      scan: {
        ...PASTA,
        mealName: 'Pasta, no cheese',
        items: [
          { name: 'Pasta', estimatedGrams: 400, kcal: 600, proteinG: 20, carbsG: 100, fatG: 12 },
        ],
      },
      portionBias: 1.0,
      responseId: 'resp_2',
    })
    fireEvent.change(screen.getByLabelText('Not quite right? Tell the AI what to fix'), {
      target: { value: 'no cheese' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Re-analyze' }))

    // The chain anchors on the FIRST response, and the correction rides in
    // the assembled context.
    await waitFor(() =>
      expect(mocks.scanFoodPhoto).toHaveBeenLastCalledWith(
        expect.any(File),
        null,
        'Correction: no cheese',
        'resp_1',
      ),
    )
    // Form re-seeds rather than showing the stale estimate.
    expect(await screen.findByDisplayValue('Pasta, no cheese')).toBeTruthy()
    expect(screen.queryByDisplayValue('Pasta dinner')).toBeNull()
  })

  it('treats clarifying questions as an optional sharpen, not a gate', async () => {
    mocks.scanFoodPhoto.mockResolvedValue({
      scan: { ...PASTA, questions: ['Was there oil?'] },
      portionBias: 1.0,
      responseId: null,
    })
    render(<PhotoFlowHarness />)
    stagePhoto()
    fireEvent.click(screen.getByRole('button', { name: 'Analyze meal' }))

    // The question shows, but it does not block the save.
    const save = (await screen.findByRole('button', { name: 'Log it' })) as HTMLButtonElement
    expect(save.disabled).toBe(false)
    expect(screen.getByLabelText('Was there oil?')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Use current estimate' })).toBeNull()
  })
})

// The REAL capture stack, not a hand-rolled harness — the reopen-after-save
// bug lived in the interplay between useFoodCapture's open-on-ready effect
// and the scan session's feedback latch, which PhotoFlowHarness doesn't have.
function CaptureStackHarness({ onSaved = () => {} }: { onSaved?: () => void }) {
  const capture = useFoodCapture({ date: '2026-07-26', today: '2026-07-26', onSaved })
  return (
    <>
      <button onClick={() => capture.onPhoto(food())}>Pick photo</button>
      {capture.node}
    </>
  )
}

describe('capture stack (useFoodCapture)', () => {
  async function openReviewSheet() {
    mocks.scanFoodPhoto.mockResolvedValue({ scan: PASTA, portionBias: 1.0, responseId: 'resp_1' })
    fireEvent.click(screen.getByRole('button', { name: 'Pick photo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Analyze meal' }))
    await screen.findByRole('button', { name: 'Log it' })
  }

  // Settle fully before asserting the sheet is GONE: the accept/abandon
  // state update and the open-on-ready effect must get their chance to
  // (wrongly) reopen it, or the assertion passes for the wrong reason.
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

  it('closes the review sheet after "Log it" and does not reopen it', async () => {
    // The reported bug: saving latched acceptance but left the session
    // 'ready', so the sheet popped straight back up and every further
    // "Log it" logged a duplicate entry.
    mocks.createFoodLogEntry.mockResolvedValue({})
    const onSaved = vi.fn()
    render(<CaptureStackHarness onSaved={onSaved} />)
    await openReviewSheet()

    fireEvent.click(screen.getByRole('button', { name: 'Log it' }))
    await waitFor(() => expect(mocks.createFoodLogEntry).toHaveBeenCalledTimes(1))
    await settle()

    expect(screen.queryByRole('button', { name: 'Log it' })).toBeNull()
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(mocks.sendAiFeedback).toHaveBeenCalledWith('resp_1', 'accepted', expect.anything())
  })

  it('closes for good on Cancel too — the rejection report must not reopen it', async () => {
    render(<CaptureStackHarness />)
    await openReviewSheet()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await settle()

    expect(screen.queryByRole('button', { name: 'Log it' })).toBeNull()
    expect(mocks.createFoodLogEntry).not.toHaveBeenCalled()
    expect(mocks.sendAiFeedback).toHaveBeenCalledWith('resp_1', 'rejected')
  })
})

describe('nutrition search flow', () => {

  it('passes the current query into the always-visible manual fallback', () => {
    const onManual = vi.fn()
    render(<FoodSearchSheet onClose={() => {}} onPick={() => {}} onManual={onManual} />)
    fireEvent.change(screen.getByLabelText('Search by name'), {
      target: { value: '  My Toast  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Enter “My Toast” by hand' }))
    expect(onManual).toHaveBeenCalledWith('My Toast')
  })

  it('validates positive grams before opting a manual entry into reusable food', async () => {
    render(
      <FoodConfirmSheet
        title="Log manually"
        source="manual"
        allowSaveAsCustom
        initial={{
          name: 'Toast',
          grams: '',
          unit: 'g',
          amount: '',
          kcal: '100',
          proteinG: '3',
          carbsG: '18',
          fatG: '2',
          note: '',
        }}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    )
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Save this portion as one serving for next time.',
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Log it' }))
    expect(
      await screen.findByText('Enter a positive amount in grams to save this food for next time.'),
    ).toBeTruthy()
    expect(mocks.createFoodLogEntry).not.toHaveBeenCalled()
  })

  it('forwards saveAsUpc (and the reviewed macros) when logging an AI-read label', async () => {
    mocks.createFoodLogEntry.mockResolvedValue({})
    const onSaved = vi.fn()
    const saveAsUpc = {
      upc: '012345678905',
      token: 'contrib-token',
      brand: 'Store',
      servingGrams: 50,
      servingUnit: 'g' as const,
      isLiquid: false,
    }
    render(
      <FoodConfirmSheet
        title="Confirm & save"
        source="barcode"
        per100g={{ kcal: 400, proteinG: 40, carbsG: 40, fatG: 20 }}
        saveAsUpc={saveAsUpc}
        initial={{
          name: 'Store Granola',
          grams: '50',
          unit: 'g',
          amount: '50',
          kcal: '200',
          proteinG: '20',
          carbsG: '20',
          fatG: '10',
          note: '',
        }}
        onClose={() => {}}
        onSaved={onSaved}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Log it' }))
    await waitFor(() => expect(mocks.createFoodLogEntry).toHaveBeenCalledTimes(1))
    expect(mocks.createFoodLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'barcode', saveAsUpc, quantityGrams: 50, kcal: 200 }),
    )
  })

  it('renders "Incorrect?" only when a handler is provided and hands off on tap', () => {
    const initial = {
      name: 'Milk',
      grams: '240',
      unit: 'g' as const,
      amount: '240',
      kcal: '110',
      proteinG: '9',
      carbsG: '13',
      fatG: '2.5',
      note: '',
    }
    const onReportIncorrect = vi.fn()
    render(
      <FoodConfirmSheet
        title="Confirm & log"
        source="barcode"
        per100g={{ kcal: 110, proteinG: 9, carbsG: 13, fatG: 2.5 }}
        foodItemId="ff_milk"
        onReportIncorrect={onReportIncorrect}
        initial={initial}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Incorrect? Rescan the nutrition label to fix it' }),
    )
    expect(onReportIncorrect).toHaveBeenCalledTimes(1)
    cleanup()

    // Without the handler (photo/manual/edit paths) the link is absent.
    render(
      <FoodConfirmSheet
        title="Confirm & log"
        source="barcode"
        per100g={{ kcal: 110, proteinG: 9, carbsG: 13, fatG: 2.5 }}
        initial={initial}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    )
    expect(
      screen.queryByRole('button', { name: 'Incorrect? Rescan the nutrition label to fix it' }),
    ).toBeNull()
  })

  it('correction mode opens straight into the label capture with replacement copy', () => {
    render(<BarcodeSheetHarness correctUpc="842379147036" />)
    expect(screen.getByText(/replaces the incorrect saved nutrition/)).toBeTruthy()
    expect(screen.getByRole('group', { name: /Nutrition facts label/ })).toBeTruthy()
    // No manual-entry escape hatch — a manual entry can't fix the shared row.
    expect(screen.queryByRole('button', { name: 'Enter manually instead' })).toBeNull()
  })

  it('blocks a label save with no amount (needs grams to derive per-100g)', async () => {
    render(
      <FoodConfirmSheet
        title="Confirm & save"
        source="barcode"
        per100g={{ kcal: 400, proteinG: 40, carbsG: 40, fatG: 20 }}
        saveAsUpc={{
          upc: '012345678905',
          token: 'contrib-token',
          brand: 'Store',
          servingGrams: 50,
          servingUnit: 'g',
          isLiquid: false,
        }}
        initial={{
          name: 'Store Granola',
          grams: '',
          unit: 'g',
          amount: '',
          kcal: '200',
          proteinG: '20',
          carbsG: '20',
          fatG: '10',
          note: '',
        }}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Log it' }))
    expect(
      await screen.findByText('Enter a positive amount so we can save this product to our database.'),
    ).toBeTruthy()
    expect(mocks.createFoodLogEntry).not.toHaveBeenCalled()
  })
})
