import { describe, it, expect } from 'vitest'
import {
  diaryDueDate,
  editVerdict,
  eventCreateFields,
  foodEditAllowed,
  foodLogEntries,
  foodToastLabel,
  moodChoiceId,
  rescaleFoodItem,
  taskCreateOpts,
  type EditedFields,
} from './assist-helpers.js'
import type { AssistSuggestion, FieldDefDto } from './api.js'

function suggestion(overrides: Partial<AssistSuggestion>): AssistSuggestion {
  return {
    category: 'note',
    title: 'Something',
    notes: null,
    startAt: null,
    endAt: null,
    allDay: false,
    dueDate: null,
    mood: null,
    items: null,
    confidence: 'high',
    traceId: 't1',
    responseId: 'r1',
    ...overrides,
  }
}

const moodField: FieldDefDto = {
  id: 'lfd_mood',
  listId: 'lst_diary',
  key: 'mood',
  label: 'Mood',
  fieldType: 'single_select',
  options: {
    choices: [
      { id: 'c1', label: '😞 Rough' },
      { id: 'c2', label: '😕 Low' },
      { id: 'c3', label: '😐 Okay' },
      { id: 'c4', label: '🙂 Good' },
      { id: 'c5', label: '😄 Great' },
    ],
  },
  required: false,
  defaultValue: null,
  position: 0,
  createdAt: '2026-01-01T00:00:00Z',
}

describe('moodChoiceId', () => {
  it('maps 1..5 to the ordered choice ids', () => {
    expect(moodChoiceId(moodField, 1)).toBe('c1')
    expect(moodChoiceId(moodField, 3)).toBe('c3')
    expect(moodChoiceId(moodField, 5)).toBe('c5')
  })

  it('clamps out-of-range moods', () => {
    expect(moodChoiceId(moodField, 0)).toBe('c1')
    expect(moodChoiceId(moodField, 9)).toBe('c5')
    expect(moodChoiceId(moodField, 4.6)).toBe('c5')
  })

  it('returns null with no field or no mood', () => {
    expect(moodChoiceId(null, 3)).toBeNull()
    expect(moodChoiceId(moodField, null)).toBeNull()
  })
})

describe('diaryDueDate', () => {
  it('uses the suggestion dueDate when present', () => {
    expect(diaryDueDate({ dueDate: '2027-03-05' }, '2026-07-20')).toBe('2027-03-05')
  })
  it('falls back to today when absent', () => {
    expect(diaryDueDate({ dueDate: null }, '2026-07-20')).toBe('2026-07-20')
  })
})

describe('taskCreateOpts', () => {
  it('forwards dueDate and notes when present', () => {
    expect(
      taskCreateOpts(suggestion({ category: 'task', dueDate: '2027-03-05', notes: 'ask about coverage' })),
    ).toEqual({ dueDate: '2027-03-05', notes: 'ask about coverage' })
  })
  it('omits each when absent (so the server keeps its defaults)', () => {
    expect(taskCreateOpts(suggestion({ category: 'task', dueDate: null, notes: null }))).toEqual({})
  })
})

describe('eventCreateFields', () => {
  it('carries name, all-day flag, times, and notes → description', () => {
    const f = eventCreateFields(
      suggestion({
        category: 'event',
        title: 'Dental cleaning',
        allDay: false,
        startAt: '2027-03-05T15:00:00.000Z',
        endAt: '2027-03-05T15:30:00.000Z',
        notes: 'bring insurance card',
      }),
    )
    expect(f).toEqual({
      name: 'Dental cleaning',
      allDay: false,
      startAt: '2027-03-05T15:00:00.000Z',
      endAt: '2027-03-05T15:30:00.000Z',
      description: 'bring insurance card',
    })
  })

  it('omits absent optional fields', () => {
    const f = eventCreateFields(suggestion({ category: 'event', title: 'Trip', allDay: true }))
    expect(f).toEqual({ name: 'Trip', allDay: true })
  })
})

describe('editVerdict', () => {
  const original = suggestion({
    category: 'task',
    title: 'Call dentist',
    dueDate: '2027-03-05',
  })
  const unchanged: EditedFields = {
    category: 'task',
    title: 'Call dentist',
    notes: null,
    dueDate: '2027-03-05',
    startAt: null,
    mood: null,
    items: null,
  }

  it('is accepted when nothing changed', () => {
    expect(editVerdict(original, unchanged)).toBe('accepted')
  })

  it('is edited when the category changed', () => {
    expect(editVerdict(original, { ...unchanged, category: 'note' })).toBe('edited')
  })

  it('is edited when a field changed', () => {
    expect(editVerdict(original, { ...unchanged, title: 'Call the dentist office' })).toBe('edited')
    expect(editVerdict(original, { ...unchanged, dueDate: null })).toBe('edited')
  })

  it('is edited when a food item changed', () => {
    const foodOrig = suggestion({
      category: 'food',
      title: 'cherries',
      items: [{ name: 'Cherries', grams: 40, kcal: 25, proteinG: 0.4, carbsG: 6, fatG: 0.1 }],
    })
    const base: EditedFields = {
      category: 'food',
      title: 'cherries',
      notes: null,
      dueDate: null,
      startAt: null,
      mood: null,
      items: [{ name: 'Cherries', grams: 40, kcal: 25, proteinG: 0.4, carbsG: 6, fatG: 0.1 }],
    }
    expect(editVerdict(foodOrig, base)).toBe('accepted')
    expect(
      editVerdict(foodOrig, {
        ...base,
        items: [{ name: 'Cherries', grams: 80, kcal: 50, proteinG: 0.8, carbsG: 12, fatG: 0.2 }],
      }),
    ).toBe('edited')
  })
})

describe('food helpers', () => {
  const item = { name: 'Cherries', grams: 40, kcal: 25, proteinG: 0.4, carbsG: 6, fatG: 0.1 }

  it('maps items to one fitness food-log body each, sharing loggedAt + responseId', () => {
    const bodies = foodLogEntries(
      [item, { name: 'Banana', grams: 118, kcal: 105, proteinG: 1.3, carbsG: 27, fatG: 0.4 }],
      '2026-07-20T18:00:00.000Z',
      'resp_9',
    )
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toEqual({
      loggedAt: '2026-07-20T18:00:00.000Z',
      name: 'Cherries',
      quantityGrams: 40,
      kcal: 25,
      proteinG: 0.4,
      carbsG: 6,
      fatG: 0.1,
      source: 'text',
      scanResponseId: 'resp_9',
    })
    expect(bodies[1]?.name).toBe('Banana')
  })

  it('omits scanResponseId when there is no responseId', () => {
    const [body] = foodLogEntries([item], '2026-07-20T18:00:00.000Z', '')
    expect(body).not.toHaveProperty('scanResponseId')
  })

  it('rescales macros linearly when grams change', () => {
    const doubled = rescaleFoodItem(item, 80)
    expect(doubled.grams).toBe(80)
    expect(doubled.kcal).toBe(50)
    expect(doubled.carbsG).toBe(12)
  })

  it('leaves the item unchanged for absurd grams', () => {
    expect(rescaleFoodItem(item, 0)).toEqual(item)
    expect(rescaleFoodItem(item, 99999)).toEqual(item)
  })

  it('is stable and preserves small macros when always scaled from a fixed baseline', () => {
    // The drawer rescales every grams edit from a pristine baseline, not the
    // current rounded item — so a down-then-back-to-original returns exactly
    // the baseline (no compounding) and a tiny macro never locks at 0.
    const down = rescaleFoodItem(item, 4)
    expect(down.fatG).toBe(0) // rounds to 0 at this scale
    // Scaling BACK UP from the pristine baseline (not from `down`) restores it.
    expect(rescaleFoodItem(item, 40)).toEqual(item)
    expect(rescaleFoodItem(item, 400).fatG).toBeGreaterThan(0)
  })

  it('builds a toast label from item names + total kcal', () => {
    expect(foodToastLabel([item])).toBe('Cherries, ~25 kcal')
    expect(
      foodToastLabel([item, { name: 'Banana', grams: 118, kcal: 105, proteinG: 1.3, carbsG: 27, fatG: 0.4 }]),
    ).toBe('2 foods, ~130 kcal')
  })

  it('allows a food edit only when items are present', () => {
    expect(foodEditAllowed({ items: [item] })).toBe(true)
    expect(foodEditAllowed({ items: null })).toBe(false)
    expect(foodEditAllowed({ items: [] })).toBe(false)
  })
})
