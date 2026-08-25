// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { FoodItemDto, FoodScanResult } from '@rallypoint/fitness-shared'

const saved = vi.fn()

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

// The real decoder needs zxing wasm / a camera; the hook's orchestration
// is what's under test, not the decode itself.
const decode = vi.hoisted(() => ({ decodeBarcodeFromFile: vi.fn() }))
vi.mock('../lib/barcode.js', () => decode)

import { useFoodCapture, type FoodCaptureAction } from './use-food-capture.js'

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  decode.decodeBarcodeFromFile.mockReset()
  // Module-level, so it accumulates across tests unless reset — an
  // unreset spy makes every "was not called" assertion vacuous.
  saved.mockReset()
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

// A host driving the hook the way both real hosts do: trigger buttons +
// one unconditional mount of `node`. Nothing else — the point is that a
// host needs nothing else.
function Host({ date = '2026-07-27', today = '2026-07-27' } = {}) {
  const capture = useFoodCapture({ date, today, onSaved: saved })
  const actions: FoodCaptureAction[] = ['barcode', 'text', 'manual']
  return (
    <>
      {actions.map((a) => (
        <button key={a} type="button" onClick={() => capture.openAction(a)}>
          open {a}
        </button>
      ))}
      <input
        aria-label="host photo"
        type="file"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) capture.onPhoto(f)
        }}
      />
      {capture.notice && <p>notice: {capture.notice}</p>}
      {capture.node}
    </>
  )
}

const PEANUT: FoodItemDto = {
  id: 'ff_1',
  upc: '012345678905',
  source: 'off',
  name: 'Peanut Butter',
  brand: 'Acme',
  servingGrams: 32,
  servingQuantity: 2,
  servingUnit: 'tbsp',
  isLiquid: false,
  per100g: { kcal: 588, proteinG: 25, carbsG: 20, fatG: 50 },
} as unknown as FoodItemDto

const PASTA: FoodScanResult = {
  mealName: 'Pasta dinner',
  estimatedServings: 1.5,
  items: [{ name: 'Pasta', estimatedGrams: 450, kcal: 700, proteinG: 24, carbsG: 110, fatG: 18 }],
  questions: [],
}

const photo = () => new File(['food'], 'food.jpg', { type: 'image/jpeg' })

describe('useFoodCapture', () => {
  it('mounts no sheets until a host asks for one', () => {
    render(<Host />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens each capture path on its own sheet', () => {
    render(<Host />)

    fireEvent.click(screen.getByRole('button', { name: 'open barcode' }))
    expect(screen.getByText('Scan a barcode')).toBeTruthy()
  })

  it('opens the describe-it sheet', () => {
    render(<Host />)
    fireEvent.click(screen.getByRole('button', { name: 'open text' }))
    expect(screen.getByText('Describe your food')).toBeTruthy()
  })

  it('stages a photo without spending a scan, then analyzes on demand', async () => {
    mocks.scanFoodPhoto.mockResolvedValue({ scan: PASTA, portionBias: 1.0, responseId: null })
    render(<Host />)

    const file = photo()
    fireEvent.change(screen.getByLabelText('host photo'), { target: { files: [file] } })

    // Confirm-before-analyze: handing the hook a file must not call the AI.
    expect(mocks.scanFoodPhoto).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Analyze meal' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Analyze meal' }))
    await waitFor(() =>
      expect(mocks.scanFoodPhoto).toHaveBeenCalledWith(file, null, undefined, null),
    )
    // The estimate lands on the editable review sheet, not a read-only one.
    expect(await screen.findByRole('button', { name: 'Log it' })).toBeTruthy()
  })

  it('runs search → pick → confirm → save and tells the host to refresh', async () => {
    mocks.searchFood.mockResolvedValue({ items: [PEANUT] })
    mocks.createFoodLogEntry.mockResolvedValue({ id: 'fl_1' })
    render(<Host />)

    fireEvent.click(screen.getByRole('button', { name: 'open manual' }))
    fireEvent.change(screen.getByLabelText('Search by name'), { target: { value: 'peanut' } })

    fireEvent.click(await screen.findByRole('button', { name: /Peanut Butter/ }))
    expect(await screen.findByRole('button', { name: 'Log it' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Log it' }))
    await waitFor(() => expect(mocks.createFoodLogEntry).toHaveBeenCalled())
    // A hand-picked search result logs as a manual entry, not a barcode scan.
    expect(mocks.createFoodLogEntry.mock.calls[0]![0]).toMatchObject({ source: 'manual' })
    await waitFor(() => expect(saved).toHaveBeenCalled())
  })

  it('surfaces the shared-cache contribution notice after a save', async () => {
    mocks.searchFood.mockResolvedValue({ items: [PEANUT] })
    mocks.createFoodLogEntry.mockResolvedValue({ id: 'fl_1', contributionStatus: 'submitted' })
    render(<Host />)

    fireEvent.click(screen.getByRole('button', { name: 'open manual' }))
    fireEvent.change(screen.getByLabelText('Search by name'), { target: { value: 'peanut' } })
    fireEvent.click(await screen.findByRole('button', { name: /Peanut Butter/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Log it' }))

    expect(await screen.findByText(/Submitted for review/)).toBeTruthy()
  })

  it('hands a barcode candidate off to the label re-scan when the user says it is wrong', async () => {
    // The "Incorrect?" round trip: confirm sheet -> label capture pinned
    // to the SAME upc. This orchestration moved out of FoodPage into the
    // hook, so it needs coverage through the hook itself.
    decode.decodeBarcodeFromFile.mockResolvedValue(PEANUT.upc)
    mocks.lookupFoodBarcode.mockResolvedValue({ item: PEANUT })
    render(<Host />)

    fireEvent.click(screen.getByRole('button', { name: 'open barcode' }))
    fireEvent.change(screen.getByLabelText('Barcode photo: add a photo'), {
      target: { files: [new File(['b'], 'b.jpg', { type: 'image/jpeg' })] },
    })

    fireEvent.click(await screen.findByRole('button', { name: /Incorrect\?/ }))

    // The label sub-flow opens pinned to that product, and the confirm
    // sheet it came from is gone.
    expect(await screen.findByText('Fix this product')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Log it' })).toBeNull()
  })

  it('keeps the estimate alive when the capture sheet closes, so a refine can land', async () => {
    // The scan session is deliberately held above the sheet: closing the
    // capture step must not discard an estimate the review sheet is
    // still showing.
    mocks.scanFoodPhoto.mockResolvedValue({ scan: PASTA, portionBias: 1.0, responseId: 'r1' })
    render(<Host />)

    fireEvent.change(screen.getByLabelText('host photo'), { target: { files: [photo()] } })
    fireEvent.click(screen.getByRole('button', { name: 'Analyze meal' }))
    expect(await screen.findByRole('button', { name: 'Log it' })).toBeTruthy()

    // The capture sheet is gone but the review sheet still holds the meal.
    expect(screen.queryByRole('button', { name: 'Analyze meal' })).toBeNull()
    expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('1.5')
  })

  it('reports an abandoned estimate when the review sheet is closed unsaved', async () => {
    mocks.scanFoodPhoto.mockResolvedValue({ scan: PASTA, portionBias: 1.0, responseId: 'r1' })
    render(<Host />)

    fireEvent.change(screen.getByLabelText('host photo'), { target: { files: [photo()] } })
    fireEvent.click(screen.getByRole('button', { name: 'Analyze meal' }))
    await screen.findByRole('button', { name: 'Log it' })

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(mocks.sendAiFeedback).toHaveBeenCalled())
    // Closing without logging is the rejection signal, not an acceptance.
    expect(mocks.createFoodLogEntry).not.toHaveBeenCalled()
    expect(saved).not.toHaveBeenCalled()
  })

  it('logs onto the viewed day, not "now", when the host is browsing a past day', async () => {
    mocks.searchFood.mockResolvedValue({ items: [PEANUT] })
    mocks.createFoodLogEntry.mockResolvedValue({ id: 'fl_1' })
    render(<Host date="2026-07-20" today="2026-07-27" />)

    fireEvent.click(screen.getByRole('button', { name: 'open manual' }))
    fireEvent.change(screen.getByLabelText('Search by name'), { target: { value: 'peanut' } })
    fireEvent.click(await screen.findByRole('button', { name: /Peanut Butter/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Log it' }))

    await waitFor(() => expect(mocks.createFoodLogEntry).toHaveBeenCalled())
    // Noon local of the viewed day, so the row lands inside that window.
    const at = new Date(mocks.createFoodLogEntry.mock.calls[0]![0].loggedAt as string)
    expect(at.getFullYear()).toBe(2026)
    expect(at.getMonth()).toBe(6)
    expect(at.getDate()).toBe(20)
    expect(at.getHours()).toBe(12)
  })
})
