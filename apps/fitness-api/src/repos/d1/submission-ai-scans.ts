import { and, desc, eq, inArray } from 'drizzle-orm'
import { submissionAiScans, type DbSubmissionAiScan } from '@rallypoint/fitness-db'
import { scanFindingsSchema, type ScanFinding } from '@rallypoint/fitness-shared'
import type {
  NewSubmissionAiScan,
  SubmissionAiScanRecord,
  SubmissionAiScanRepo,
  ScanSubjectType,
} from '../types.js'
import type { Db } from './db.js'
import { mapUniqueViolation } from './_errors.js'
import { chunkForBoundParams } from '@rallypoint/api-kit'

// D1 repo for submission_ai_scans — the automatic AI triage queue over
// incoming exercise/food submissions. findings is stored as JSON text;
// parse defensively so a hand-edited row can't take down the admin list.

function parseFindings(raw: string | null): ScanFinding[] {
  if (!raw) return []
  try {
    const parsed = scanFindingsSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

function toRecord(row: DbSubmissionAiScan): SubmissionAiScanRecord {
  return {
    id: row.id,
    subjectType: row.subjectType as ScanSubjectType,
    subjectId: row.subjectId,
    status: row.status as SubmissionAiScanRecord['status'],
    verdict: (row.verdict as SubmissionAiScanRecord['verdict']) ?? null,
    findings: parseFindings(row.findings),
    model: row.model,
    error: row.error ?? null,
    createdAt: row.createdAt,
    completedAt: row.completedAt ?? null,
  }
}

export class D1SubmissionAiScanRepo implements SubmissionAiScanRepo {
  constructor(private readonly db: Db) {}

  async create(input: NewSubmissionAiScan): Promise<SubmissionAiScanRecord> {
    try {
      await this.db.insert(submissionAiScans).values({
        id: input.id,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        model: input.model,
      })
    } catch (err) {
      throw mapUniqueViolation(err)
    }
    const created = await this.getById(input.id)
    if (!created) throw new Error('submission_ai_scan insert readback failed')
    return created
  }

  async getById(id: string): Promise<SubmissionAiScanRecord | null> {
    const rows = await this.db
      .select()
      .from(submissionAiScans)
      .where(eq(submissionAiScans.id, id))
      .limit(1)
    return rows[0] ? toRecord(rows[0]) : null
  }

  async complete(
    id: string,
    fields: { verdict: SubmissionAiScanRecord['verdict']; findings: ScanFinding[] },
  ): Promise<SubmissionAiScanRecord | null> {
    await this.db
      .update(submissionAiScans)
      .set({
        status: 'done',
        verdict: fields.verdict,
        findings: JSON.stringify(fields.findings),
        completedAt: new Date(),
      })
      .where(and(eq(submissionAiScans.id, id), eq(submissionAiScans.status, 'pending')))
    const row = await this.getById(id)
    return row && row.status === 'done' ? row : null
  }

  async fail(id: string, error: string): Promise<SubmissionAiScanRecord | null> {
    await this.db
      .update(submissionAiScans)
      .set({ status: 'failed', error: error.slice(0, 500), completedAt: new Date() })
      .where(and(eq(submissionAiScans.id, id), eq(submissionAiScans.status, 'pending')))
    const row = await this.getById(id)
    return row && row.status === 'failed' ? row : null
  }

  async getLatestBySubject(
    subjectType: ScanSubjectType,
    subjectId: string,
  ): Promise<SubmissionAiScanRecord | null> {
    const rows = await this.db
      .select()
      .from(submissionAiScans)
      .where(
        and(
          eq(submissionAiScans.subjectType, subjectType),
          eq(submissionAiScans.subjectId, subjectId),
        ),
      )
      .orderBy(desc(submissionAiScans.createdAt), desc(submissionAiScans.id))
      .limit(1)
    return rows[0] ? toRecord(rows[0]) : null
  }

  async getLatestForSubjects(
    subjectType: ScanSubjectType,
    subjectIds: string[],
  ): Promise<Map<string, SubmissionAiScanRecord>> {
    const out = new Map<string, SubmissionAiScanRecord>()
    if (subjectIds.length === 0) return out
    for (const chunk of chunkForBoundParams(subjectIds, 1, 1)) {
      const rows = await this.db
        .select()
        .from(submissionAiScans)
        .where(
          and(
            eq(submissionAiScans.subjectType, subjectType),
            inArray(submissionAiScans.subjectId, chunk),
          ),
        )
        // Newest-first + first-write-wins below = latest row per subject.
        // Id is the ULID tiebreak for rows sharing a created_at ms.
        .orderBy(desc(submissionAiScans.createdAt), desc(submissionAiScans.id))
      for (const row of rows) {
        if (!out.has(row.subjectId)) out.set(row.subjectId, toRecord(row))
      }
    }
    return out
  }
}
