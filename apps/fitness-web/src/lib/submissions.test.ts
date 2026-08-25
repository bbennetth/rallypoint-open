import { describe, expect, it } from 'vitest'
import type { SubmissionDto } from '@rallypoint/fitness-shared'
import {
  eligibleMigrationOffers,
  latestSubmissionForExercise,
  nextMigrationOffers,
  submissionStatusChip,
} from './submissions.js'

function makeSubmission(overrides: Partial<SubmissionDto> = {}): SubmissionDto {
  return {
    id: 'fsub_1',
    exerciseId: 'ex_1',
    exerciseName: 'Sandbag carry',
    status: 'pending',
    adminNote: null,
    globalExerciseId: null,
    migrationStatus: 'none',
    createdAt: '2026-07-01T00:00:00.000Z',
    reviewedAt: null,
    migratedAt: null,
    ...overrides,
  }
}

describe('eligibleMigrationOffers', () => {
  it('includes only approved submissions with an offered migration', () => {
    const subs = [
      makeSubmission({ id: 'a', status: 'pending', migrationStatus: 'none' }),
      makeSubmission({ id: 'b', status: 'approved', migrationStatus: 'offered' }),
      makeSubmission({ id: 'c', status: 'approved', migrationStatus: 'accepted' }),
      makeSubmission({ id: 'd', status: 'approved', migrationStatus: 'declined' }),
      makeSubmission({ id: 'e', status: 'rejected', migrationStatus: 'none' }),
    ]
    expect(eligibleMigrationOffers(subs).map((s) => s.id)).toEqual(['b'])
  })

  it('returns an empty array when there are no submissions', () => {
    expect(eligibleMigrationOffers([])).toEqual([])
  })
})

describe('nextMigrationOffers', () => {
  it('applies the eligibility filter and drops session-dismissed offers', () => {
    const subs = [
      makeSubmission({ id: 'a', status: 'approved', migrationStatus: 'offered' }),
      makeSubmission({ id: 'b', status: 'approved', migrationStatus: 'offered' }),
      makeSubmission({ id: 'c', status: 'pending', migrationStatus: 'none' }),
    ]
    expect(nextMigrationOffers(subs, new Set(['a'])).map((s) => s.id)).toEqual(['b'])
  })

  it('returns all eligible offers when nothing was dismissed', () => {
    const subs = [makeSubmission({ id: 'a', status: 'approved', migrationStatus: 'offered' })]
    expect(nextMigrationOffers(subs, new Set()).map((s) => s.id)).toEqual(['a'])
  })

  it('returns empty for no submissions or when every offer was dismissed', () => {
    expect(nextMigrationOffers([], new Set())).toEqual([])
    const subs = [makeSubmission({ id: 'a', status: 'approved', migrationStatus: 'offered' })]
    expect(nextMigrationOffers(subs, new Set(['a']))).toEqual([])
  })
})

describe('latestSubmissionForExercise', () => {
  it('returns null when the exercise has no submissions', () => {
    const subs = [makeSubmission({ exerciseId: 'other' })]
    expect(latestSubmissionForExercise(subs, 'ex_1')).toBeNull()
  })

  it('picks the most recently created submission for that exercise', () => {
    const subs = [
      makeSubmission({ id: 'old', exerciseId: 'ex_1', createdAt: '2026-01-01T00:00:00.000Z' }),
      makeSubmission({ id: 'other-ex', exerciseId: 'ex_2', createdAt: '2026-06-01T00:00:00.000Z' }),
      makeSubmission({ id: 'new', exerciseId: 'ex_1', createdAt: '2026-05-01T00:00:00.000Z' }),
    ]
    expect(latestSubmissionForExercise(subs, 'ex_1')?.id).toBe('new')
  })
})

describe('submissionStatusChip', () => {
  it('returns null for no submission', () => {
    expect(submissionStatusChip(null)).toBeNull()
  })

  it('maps pending/approved/rejected to labels and tones', () => {
    expect(submissionStatusChip(makeSubmission({ status: 'pending' }))).toEqual({
      label: 'Pending review',
      tone: 'pending',
    })
    expect(submissionStatusChip(makeSubmission({ status: 'approved' }))).toEqual({
      label: 'Approved',
      tone: 'approved',
    })
    expect(submissionStatusChip(makeSubmission({ status: 'rejected' }))).toEqual({
      label: 'Rejected',
      tone: 'rejected',
    })
  })
})
