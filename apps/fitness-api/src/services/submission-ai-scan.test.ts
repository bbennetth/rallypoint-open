import { describe, it, expect } from 'vitest'
import {
  BACKSTOP_CAP,
  STALE_SCAN_MS,
  buildExerciseScanPrompt,
  buildFoodScanPrompt,
  normalizeScanOutput,
  selectScanBackstop,
} from './submission-ai-scan.js'
import type {
  ExerciseRecord,
  FoodItemRecord,
  FoodSubmissionRecord,
  SubmissionAdminRecord,
  SubmissionAiScanRecord,
} from '../repos/types.js'

// Pure-logic coverage for the submission AI triage pipeline: prompt
// building, output normalization (incl. the duplicate-id hallucination
// guard), and the lazy list-backstop selection rule.

function exerciseSubmission(): SubmissionAdminRecord {
  return {
    id: 'fsub_1',
    exerciseId: 'fex_1',
    userId: 'u_1',
    status: 'pending',
    adminNote: null,
    globalExerciseId: null,
    migrationStatus: 'none',
    createdAt: new Date('2026-08-01T00:00:00Z'),
    reviewedAt: null,
    migratedAt: null,
    exercise: {
      name: 'Cable Fly',
      discipline: 'strength',
      movementPattern: 'push',
      metricShape: 'reps_load',
      unilateral: false,
      muscles: [{ muscleId: 'chest', muscleName: 'Chest', groupName: 'Chest', role: 'primary' }],
    },
  }
}

function exerciseCandidate(id: string, name: string): ExerciseRecord {
  return {
    id,
    name,
    ownerUserId: null,
    discipline: 'strength',
    movementPattern: 'push',
    metricShape: 'reps_load',
    unilateral: false,
    muscles: [],
    ref: null,
  }
}

function foodSubmission(): FoodSubmissionRecord {
  return {
    id: 'fdsub_1',
    userId: 'u_1',
    upc: '0123456789012',
    privateFoodItemId: 'ff_1',
    name: 'Peanut Butter',
    brand: 'Acme',
    servingGrams: 32,
    servingQuantity: 2,
    servingUnit: 'tbsp',
    isLiquid: false,
    per100g: { kcal: 588, proteinG: 25, carbsG: 20, fatG: 50 },
    status: 'pending',
    adminNote: null,
    globalFoodItemId: null,
    migrationStatus: 'none',
    createdAt: new Date('2026-08-01T00:00:00Z'),
    reviewedAt: null,
    migratedAt: null,
  }
}

function foodCandidate(id: string, name: string, upc: string | null = null): FoodItemRecord {
  return {
    id,
    upc,
    source: 'off',
    name,
    brand: 'Acme',
    servingGrams: 30,
    servingQuantity: 2,
    servingUnit: 'tbsp',
    isLiquid: false,
    per100g: { kcal: 580, proteinG: 24, carbsG: 22, fatG: 49 },
    createdBy: null,
    ownerUserId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  }
}

function scanRow(over: Partial<SubmissionAiScanRecord>): SubmissionAiScanRecord {
  return {
    id: 'fscan_1',
    subjectType: 'exercise',
    subjectId: 'fsub_1',
    status: 'done',
    verdict: 'ok',
    findings: [],
    model: 'm',
    error: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    completedAt: new Date('2026-08-01T00:00:10Z'),
    ...over,
  }
}

describe('buildExerciseScanPrompt', () => {
  it('embeds submission fields and candidate lines', () => {
    const prompt = buildExerciseScanPrompt(exerciseSubmission(), [
      exerciseCandidate('fex_a', 'Chest Fly'),
      exerciseCandidate('fex_b', 'Pec Deck'),
    ])
    expect(prompt).toContain('Name: Cable Fly')
    expect(prompt).toContain('Chest (primary)')
    expect(prompt).toContain('- fex_a | Chest Fly')
    expect(prompt).toContain('- fex_b | Pec Deck')
  })

  it('renders (none) when there are no candidates', () => {
    expect(buildExerciseScanPrompt(exerciseSubmission(), [])).toContain('(none)')
  })
})

describe('buildFoodScanPrompt', () => {
  it('embeds macros, upc and candidate lines with brand/upc', () => {
    const prompt = buildFoodScanPrompt(foodSubmission(), [
      foodCandidate('ff_a', 'Peanut Butter Creamy', '0123456789012'),
    ])
    expect(prompt).toContain('UPC: 0123456789012')
    expect(prompt).toContain('kcal: 588')
    expect(prompt).toContain('- ff_a | Peanut Butter Creamy (Acme) upc:0123456789012')
  })
})

describe('normalizeScanOutput', () => {
  const allowed = new Set(['fex_a', 'fex_b'])

  it('keeps well-formed findings and derives the max-severity verdict', () => {
    const { verdict, findings } = normalizeScanOutput(
      {
        findings: [
          { dimension: 'quality', severity: 'info', message: 'Fine.' },
          { dimension: 'moderation', severity: 'warn', message: 'Odd name.' },
        ],
      },
      allowed,
    )
    expect(findings).toHaveLength(2)
    expect(verdict).toBe('warn')
  })

  it('reads info-only findings as ok, flag as flag', () => {
    expect(
      normalizeScanOutput(
        { findings: [{ dimension: 'quality', severity: 'info', message: 'x' }] },
        allowed,
      ).verdict,
    ).toBe('ok')
    expect(
      normalizeScanOutput(
        { findings: [{ dimension: 'moderation', severity: 'flag', message: 'x' }] },
        allowed,
      ).verdict,
    ).toBe('flag')
  })

  it('drops duplicate findings with unknown or missing duplicateId', () => {
    const { findings } = normalizeScanOutput(
      {
        findings: [
          { dimension: 'duplicate', severity: 'warn', message: 'dup', duplicateId: 'fex_a' },
          { dimension: 'duplicate', severity: 'warn', message: 'dup', duplicateId: 'made_up' },
          { dimension: 'duplicate', severity: 'warn', message: 'dup' },
        ],
      },
      allowed,
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.duplicateId).toBe('fex_a')
  })

  it('drops malformed entries and truncates long messages', () => {
    const { verdict, findings } = normalizeScanOutput(
      {
        findings: [
          'nope',
          { dimension: 'bogus', severity: 'warn', message: 'x' },
          { dimension: 'quality', severity: 'huge', message: 'x' },
          { dimension: 'quality', severity: 'warn', message: 'y'.repeat(500) },
        ],
      },
      allowed,
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.message).toHaveLength(300)
    expect(verdict).toBe('warn')
  })

  it('handles non-object and empty output as an ok verdict', () => {
    expect(normalizeScanOutput(null, allowed)).toEqual({ verdict: 'ok', findings: [] })
    expect(normalizeScanOutput({ findings: [] }, allowed).verdict).toBe('ok')
  })
})

describe('selectScanBackstop', () => {
  const now = new Date('2026-08-01T12:00:00Z')

  it('selects missing, failed and stale-pending scans; skips done and fresh-pending', () => {
    const latest = new Map<string, SubmissionAiScanRecord>([
      ['done', scanRow({ subjectId: 'done', status: 'done' })],
      ['failed', scanRow({ subjectId: 'failed', status: 'failed', verdict: null })],
      [
        'fresh',
        scanRow({
          subjectId: 'fresh',
          status: 'pending',
          verdict: null,
          createdAt: new Date(now.getTime() - 1000),
        }),
      ],
      [
        'stale',
        scanRow({
          subjectId: 'stale',
          status: 'pending',
          verdict: null,
          createdAt: new Date(now.getTime() - STALE_SCAN_MS - 1),
        }),
      ],
    ])
    expect(selectScanBackstop(['done', 'failed', 'fresh', 'stale', 'missing'], latest, now)).toEqual(
      ['failed', 'stale', 'missing'],
    )
  })

  it('caps the selection', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `s${i}`)
    expect(selectScanBackstop(ids, new Map(), now)).toHaveLength(BACKSTOP_CAP)
    expect(selectScanBackstop(ids, new Map(), now, 5)).toHaveLength(5)
  })
})
