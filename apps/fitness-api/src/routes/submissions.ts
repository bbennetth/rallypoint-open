import { Hono, type Context } from 'hono'
import { ulid } from 'ulid'
import { migrateSubmissionSchema, type SubmissionDto } from '@rallypoint/fitness-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { UniqueConstraintError } from '@rallypoint/api-kit'
import type { SubmissionWithExerciseName } from '../repos/types.js'
import { readJsonBody } from './_body.js'

// Exercise submissions — a user promoting one of their private custom
// exercises into the curated global catalog for admin review. Cookie +
// CSRF + session gated in build-app (mirrors exercises.ts/favorites.ts).

function toDto(r: SubmissionWithExerciseName): SubmissionDto {
  return {
    id: r.id,
    exerciseId: r.exerciseId,
    exerciseName: r.exerciseName,
    status: r.status,
    adminNote: r.adminNote,
    globalExerciseId: r.globalExerciseId,
    migrationStatus: r.migrationStatus,
    createdAt: r.createdAt.toISOString(),
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    migratedAt: r.migratedAt?.toISOString() ?? null,
  }
}

// Fire the automatic AI triage scan for a just-created submission —
// fully fire-and-forget (the service catch-logs), so the 201 is never
// blocked or failed by the scan. No-op when the AI binding is absent.
export function fireSubmissionScan(
  c: Context<HonoApp>,
  subjectType: 'exercise' | 'food',
  submissionId: string,
): void {
  const scans = c.var.services.submissionScans
  if (!scans) return
  scans.fire(c.var.repos, subjectType, submissionId, {
    userId: c.var.session!.userId,
    logger: c.var.logger,
    aiTraces: c.var.services.aiTraces,
    waitUntil: (p) => {
      try {
        c.executionCtx.waitUntil(p)
      } catch {
        // No execution context (some test harnesses) — fire and forget.
        void p
      }
    },
  })
}

export const submissionsRoutes = new Hono<HonoApp>()
  // --- submit a custom exercise for review ----------------------------
  .post('/api/v1/ui/exercises/:id/submit', async (c) => {
    const userId = c.var.session!.userId
    const exerciseId = c.req.param('id')

    // Must be OWNED by the actor — global rows and other users' customs
    // resolve to null in getForActor, so this doubles as the ownership
    // check (404, not 403, matching the catalog-route contract).
    const exercise = await c.var.repos.exercises.getForActor(userId, exerciseId)
    if (!exercise || exercise.ownerUserId !== userId) {
      throw errors.notFound('Exercise not found.')
    }

    const hasPrimaryMuscle = exercise.muscles.some((m) => m.role === 'primary')
    if (!hasPrimaryMuscle) {
      throw errors.validation({
        issues: [
          {
            code: 'custom',
            path: ['muscles'],
            message: 'Add at least one primary muscle before submitting for review.',
          },
        ],
      })
    }

    const existingPending = await c.var.repos.submissions.getPendingByExercise(exerciseId)
    if (existingPending) {
      throw errors.conflict(
        'submission_pending',
        'This exercise already has a submission pending review.',
      )
    }

    try {
      const created = await c.var.repos.submissions.create({
        id: `fsub_${ulid()}`,
        exerciseId,
        userId,
      })
      fireSubmissionScan(c, 'exercise', created.id)
      return c.json(toDto({ ...created, exerciseName: exercise.name }), 201)
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        // Lost a concurrent submit race against the partial unique index.
        throw errors.conflict(
          'submission_pending',
          'This exercise already has a submission pending review.',
        )
      }
      throw err
    }
  })
  // --- list the actor's own submissions -------------------------------
  .get('/api/v1/ui/submissions', async (c) => {
    const userId = c.var.session!.userId
    const rows = await c.var.repos.submissions.listByUser(userId)
    return c.json({ submissions: rows.map(toDto) })
  })
  // --- accept/decline the offered migration ---------------------------
  .post('/api/v1/ui/submissions/:id/migrate', async (c) => {
    const userId = c.var.session!.userId
    const id = c.req.param('id')
    const parsed = migrateSubmissionSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })

    const submission = await c.var.repos.submissions.getById(id)
    if (!submission || submission.userId !== userId) {
      throw errors.notFound('Submission not found.')
    }
    if (submission.status !== 'approved' || submission.migrationStatus !== 'offered') {
      throw errors.conflict(
        'migration_not_offered',
        'This submission has no pending migration offer.',
      )
    }

    if (!parsed.data.accept) {
      const declined = await c.var.repos.submissions.declineMigration(id)
      if (!declined) throw errors.notFound('Submission not found.')
      // The guarded UPDATE is a no-op when an accept won the race — don't
      // report "declined" for a migration that already ran.
      if (declined.migrationStatus !== 'declined') {
        throw errors.conflict(
          'migration_already_resolved',
          'This migration offer was already resolved.',
        )
      }
      const exercises = await c.var.repos.submissions.listByUser(userId)
      const withName = exercises.find((s) => s.id === id)
      return c.json(toDto(withName ?? { ...declined, exerciseName: '' }))
    }

    // globalExerciseId is guaranteed non-null once status === 'approved'
    // (setReviewed always sets it alongside migrationStatus 'offered').
    if (!submission.globalExerciseId) {
      throw errors.conflict('migration_not_offered', 'This submission has no global exercise linked.')
    }

    const accepted = await c.var.repos.submissions.acceptMigration({
      submissionId: id,
      userId,
      customExerciseId: submission.exerciseId,
      globalExerciseId: submission.globalExerciseId,
    })
    if (!accepted) throw errors.notFound('Submission not found.')
    // The custom exercise is deleted by the migration, so look up the
    // now-global exercise's name for the response DTO.
    const globalExercise = await c.var.repos.exercises.getForActor(userId, accepted.globalExerciseId!)
    return c.json(toDto({ ...accepted, exerciseName: globalExercise?.name ?? '' }))
  })
