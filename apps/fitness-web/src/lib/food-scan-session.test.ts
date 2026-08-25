import { describe, expect, it } from 'vitest'
import { FOOD_SCAN_CONTEXT_MAX, type FoodScanResult } from '@rallypoint/fitness-shared'
import {
  acceptTarget,
  emptyScanMessage,
  estimateOf,
  foodScanReducer,
  hasEstimate,
  openQuestions,
  rejectTarget,
  retryTarget,
  scanContextFor,
  INITIAL_FOOD_SCAN,
  type FoodScanAction,
  type FoodScanSession,
} from './food-scan-session.js'

function scanResult(over: Partial<FoodScanResult> = {}): FoodScanResult {
  return {
    mealName: 'Chili bowl',
    estimatedServings: 1,
    items: [
      {
        name: 'Chili',
        estimatedGrams: 400,
        kcal: 500,
        proteinG: 30,
        carbsG: 40,
        fatG: 20,
      },
    ],
    questions: [],
    ...over,
  } as FoodScanResult
}

function reduce(state: FoodScanSession, ...actions: FoodScanAction[]): FoodScanSession {
  return actions.reduce(foodScanReducer, state)
}

const started = reduce(INITIAL_FOOD_SCAN, { type: 'start', kind: 'photo' })

describe('foodScanReducer — AI-trace bookkeeping', () => {
  it('latches firstResponseId once while lastResponseId follows every pass', () => {
    const first = reduce(started, { type: 'run' }, {
      type: 'run:ok',
      scan: scanResult(),
      portionBias: 1,
      responseId: 'r1',
    })
    expect(first.firstResponseId).toBe('r1')
    expect(first.lastResponseId).toBe('r1')

    const second = reduce(first, { type: 'run' }, {
      type: 'run:ok',
      scan: scanResult(),
      portionBias: 1,
      responseId: 'r2',
    })
    // The chain anchor never moves — later passes echo it as
    // parentResponseId, so re-anchoring would fork the trace.
    expect(second.firstResponseId).toBe('r1')
    expect(second.lastResponseId).toBe('r2')
    expect(second.revision).toBe(2)
  })

  it('leaves both ids untouched when tracing is off (null responseId)', () => {
    const s = reduce(started, { type: 'run' }, {
      type: 'run:ok',
      scan: scanResult(),
      portionBias: 1,
      responseId: null,
    })
    expect(s.firstResponseId).toBeNull()
    expect(s.lastResponseId).toBeNull()
  })

  it('a null responseId on a later pass does not erase an earlier one', () => {
    const s = reduce(
      started,
      { type: 'run' },
      { type: 'run:ok', scan: scanResult(), portionBias: 1, responseId: 'r1' },
      { type: 'run' },
      { type: 'run:ok', scan: scanResult(), portionBias: 1, responseId: null },
    )
    expect(s.lastResponseId).toBe('r1')
  })

  it('starting a fresh subject clears the chain but keeps revision monotonic', () => {
    const s = reduce(
      started,
      { type: 'run' },
      { type: 'run:ok', scan: scanResult(), portionBias: 1.4, responseId: 'r1' },
      { type: 'start', kind: 'photo' },
    )
    expect(s.firstResponseId).toBeNull()
    expect(s.scan).toBeNull()
    expect(s.portionBias).toBe(1)
    // Monotonic so the review sheet's re-seed check can't miss an edge.
    expect(s.revision).toBe(1)
  })
})

describe('foodScanReducer — refine', () => {
  it('drops blank answers, keeps order, and appends the correction', () => {
    const s = reduce(
      started,
      {
        type: 'refine',
        answers: [
          { question: 'Oil used?', answer: ' olive ' },
          { question: 'Rice type?', answer: '   ' },
        ],
        correction: ' no beans ',
      },
      {
        type: 'refine',
        answers: [{ question: 'Portion?', answer: 'half' }],
        correction: 'more cheese',
      },
    )
    expect(s.qaPairs).toEqual([
      { question: 'Oil used?', answer: 'olive' },
      { question: 'Portion?', answer: 'half' },
    ])
    expect(s.corrections).toEqual(['no beans', 'more cheese'])
  })

  it('a blank correction adds nothing', () => {
    const s = reduce(started, { type: 'refine', answers: [], correction: '   ' })
    expect(s.corrections).toEqual([])
  })

  it('a rerun clears the feedback latch so a later abandon still reports', () => {
    const s = reduce(
      started,
      { type: 'run' },
      { type: 'run:ok', scan: scanResult(), portionBias: 1, responseId: 'r1' },
      { type: 'feedback:sent' },
      { type: 'run' },
      { type: 'run:ok', scan: scanResult(), portionBias: 1, responseId: 'r2' },
    )
    expect(s.feedbackSent).toBe(false)
    expect(rejectTarget(s)).toBe('r2')
  })
})

describe('feedback targets', () => {
  const ready = reduce(started, { type: 'run' }, {
    type: 'run:ok',
    scan: scanResult(),
    portionBias: 1,
    responseId: 'r1',
  })

  it('retryTarget is null on the first pass and the prior id afterwards', () => {
    expect(retryTarget(started)).toBeNull()
    expect(retryTarget(ready)).toBe('r1')
  })

  it('acceptTarget needs an estimate', () => {
    expect(acceptTarget(started)).toBeNull()
    expect(acceptTarget(ready)).toBe('r1')
  })

  it('acceptTarget goes quiet once feedback has been reported', () => {
    // Symmetric with rejectTarget. Without this, saving anything after
    // abandoning an estimate re-reports that already-REJECTED trace as
    // accepted — the pages share one session across every capture kind.
    const latched = foodScanReducer(ready, { type: 'feedback:sent' })
    expect(acceptTarget(latched)).toBeNull()
    expect(rejectTarget(latched)).toBeNull()
  })

  it('a refine re-arms both targets', () => {
    const again = reduce(
      foodScanReducer(ready, { type: 'feedback:sent' }),
      { type: 'run' },
      { type: 'run:ok', scan: scanResult(), portionBias: 1, responseId: 'r2' },
    )
    expect(acceptTarget(again)).toBe('r2')
    expect(rejectTarget(again)).toBe('r2')
  })

  it('rejectTarget is null without an estimate and once accept has latched', () => {
    expect(rejectTarget(started)).toBeNull()
    expect(rejectTarget(ready)).toBe('r1')
    expect(rejectTarget(foodScanReducer(ready, { type: 'feedback:sent' }))).toBeNull()
  })

  it('an item-less result is not an estimate', () => {
    const empty = foodScanReducer(ready, {
      type: 'run:ok',
      scan: scanResult({ items: [], mealName: null, estimatedServings: null }),
      portionBias: 1,
      responseId: 'r2',
    })
    expect(hasEstimate(empty)).toBe(false)
    expect(acceptTarget(empty)).toBeNull()
  })

  it('items without a named, sized meal are not an estimate either', () => {
    // Matches aggregateFoodScanResult: items alone don't make a loggable
    // meal, so the review sheet must not offer to save one.
    const unnamed = foodScanReducer(ready, {
      type: 'run:ok',
      scan: scanResult({ mealName: null }),
      portionBias: 1,
      responseId: 'r2',
    })
    expect(hasEstimate(unnamed)).toBe(false)
    expect(estimateOf(unnamed)).toBeNull()
  })
})

describe('feedback:sent is terminal for a ready estimate', () => {
  const ready = reduce(started, { type: 'run' }, {
    type: 'run:ok',
    scan: scanResult(),
    portionBias: 1,
    responseId: 'r1',
  })

  it('leaves the ready phase so the open-on-ready effect cannot reopen the sheet', () => {
    // The bug this pins down: saving from the review sheet reported
    // acceptance but stayed 'ready', so the capture hook's effect reopened
    // the sheet and every further "Log it" logged a duplicate entry.
    const latched = foodScanReducer(ready, { type: 'feedback:sent' })
    expect(latched.phase).toBe('idle')
    expect(latched.feedbackSent).toBe(true)
    // The chain itself survives — the latch predicates still need it.
    expect(latched.scan).not.toBeNull()
    expect(latched.lastResponseId).toBe('r1')
  })

  it('passes other phases through untouched', () => {
    const working = foodScanReducer(reduce(ready, { type: 'run' }), { type: 'feedback:sent' })
    expect(working.phase).toBe('working')

    const errored = foodScanReducer(
      foodScanReducer(ready, { type: 'run:error', message: 'nope' }),
      { type: 'feedback:sent' },
    )
    expect(errored.phase).toBe('error')
  })
})

describe('openQuestions', () => {
  it('hides questions the user already answered when the model re-asks', () => {
    const asked = reduce(started, { type: 'run' }, {
      type: 'run:ok',
      scan: scanResult({ questions: ['Oil used?', 'Portion size?'] }),
      portionBias: 1,
      responseId: 'r1',
    })
    expect(openQuestions(asked)).toEqual(['Oil used?', 'Portion size?'])

    const answered = reduce(asked, {
      type: 'refine',
      answers: [{ question: 'Oil used?', answer: 'olive' }],
      correction: '',
    })
    expect(openQuestions(answered)).toEqual(['Portion size?'])
  })

  it('is empty with no scan', () => {
    expect(openQuestions(started)).toEqual([])
  })
})

describe('scanContextFor', () => {
  it('composes answers then corrections', () => {
    const s = reduce(started, {
      type: 'refine',
      answers: [{ question: 'Oil?', answer: 'olive' }],
      correction: 'no beans',
    })
    expect(scanContextFor(s)).toBe('Oil? → olive\nCorrection: no beans')
  })

  it('leads with the context typed on the confirm step', () => {
    const s = reduce(
      started,
      { type: 'run', base: '  total weight 300g  ' },
      { type: 'refine', answers: [], correction: 'no beans' },
    )
    expect(s.base).toBe('total weight 300g')
    expect(scanContextFor(s)).toBe('total weight 300g\nCorrection: no beans')
  })

  it('keeps that context across refine passes', () => {
    // Refines omit `base`, so the stored one has to survive — it's the
    // portion hint the whole estimate hangs on.
    const s = reduce(
      started,
      { type: 'run', base: 'total weight 300g' },
      { type: 'run:ok', scan: scanResult(), portionBias: 1, responseId: 'r1' },
      { type: 'refine', answers: [], correction: 'no beans' },
      { type: 'run' },
    )
    expect(s.base).toBe('total weight 300g')
    expect(scanContextFor(s)).toContain('total weight 300g')
  })

  it('a fresh subject drops it', () => {
    const s = reduce(started, { type: 'run', base: 'stale' }, { type: 'start', kind: 'photo' })
    expect(s.base).toBe('')
  })

  it('stays under the server cap after a long refine chain, keeping the newest', () => {
    let s = started
    for (let i = 0; i < 50; i += 1) {
      s = foodScanReducer(s, {
        type: 'refine',
        answers: [],
        correction: `correction number ${i} `.padEnd(120, 'x'),
      })
    }
    const ctx = scanContextFor(s)
    expect(ctx.length).toBeLessThanOrEqual(FOOD_SCAN_CONTEXT_MAX)
    expect(ctx).toContain('correction number 49')
    expect(ctx).not.toContain('correction number 0 ')
  })
})

describe('empty + error phases', () => {
  it('uses kind-specific copy for an empty result', () => {
    const photo = foodScanReducer(started, { type: 'run:empty' })
    expect(photo.phase).toBe('error')
    expect(photo.error).toBe(emptyScanMessage('photo'))
    expect(photo.error).toContain('photo')

    const text = foodScanReducer(reduce(INITIAL_FOOD_SCAN, { type: 'start', kind: 'text' }), {
      type: 'run:empty',
    })
    expect(text.error).toBe(emptyScanMessage('text'))
    expect(text.error).toContain('cherries')
  })

  it('surfaces the transport message on failure', () => {
    const s = foodScanReducer(started, { type: 'run:error', message: 'Load failed' })
    expect(s).toMatchObject({ phase: 'error', error: 'Load failed' })
  })

  it('a run clears a previous error', () => {
    const s = reduce(started, { type: 'run:error', message: 'nope' }, { type: 'run' })
    expect(s).toMatchObject({ phase: 'working', error: null })
  })
})
