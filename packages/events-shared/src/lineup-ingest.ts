import { z } from 'zod'
import type { LineupChangeRowInput } from './lineup-plan.js'

// AI lineup extraction: the schema the model's JSON output must satisfy,
// plus pure normalization + hallucination guarding between the raw model
// object and the shared lineup planner (planLineupChanges). Everything
// here is deterministic and unit-tested; the model call itself lives in
// events-api's ingest core.

// Generous ceiling — the planner enforces the real 200-row apply cap;
// this only stops a runaway model response from ballooning the proposal.
const MAX_EXTRACTED_ARTISTS = 500

const trimmed = (max: number) => z.string().trim().max(max)

// Optional string fields tolerate null/undefined and normalize '' → null
// (models often emit empty strings for unknowns).
const optionalToken = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((s) => (s ? s : null))

export const ExtractedLineupSchema = z.object({
  artists: z
    .array(
      z.object({
        name: trimmed(200),
        day: optionalToken(100),
        stage: optionalToken(100),
        tier: optionalToken(40),
        genre: optionalToken(100),
        start: optionalToken(20),
        end: optionalToken(20),
      }),
    )
    .max(MAX_EXTRACTED_ARTISTS),
})

export type ExtractedLineup = z.infer<typeof ExtractedLineupSchema>
export type ExtractedLineupArtist = ExtractedLineup['artists'][number]

// vLLM guided_json mirror of ExtractedLineupSchema, passed to the model
// so decoding is constrained to this shape when the backend honors it
// (and harmless when it doesn't — see exercise-ai-review.ts's prompt
// comment; the JSON instruction must ALSO live in the prompt text).
// `dayLabels`/`stageNames` pin the enums to the event's real values so
// the model can't invent a day or stage.
export function buildLineupGuidedJson(
  dayLabels: string[],
  stageNames: string[],
): Record<string, unknown> {
  const dayField =
    dayLabels.length > 0 ? { type: 'string', enum: dayLabels } : { type: 'string' }
  const stageField =
    stageNames.length > 0 ? { type: 'string', enum: stageNames } : { type: 'string' }
  return {
    type: 'object',
    properties: {
      artists: {
        type: 'array',
        maxItems: MAX_EXTRACTED_ARTISTS,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            day: dayField,
            stage: stageField,
            tier: { type: 'string', enum: ['headliner', 'support', 'opener'] },
            genre: { type: 'string' },
            start: { type: 'string' },
            end: { type: 'string' },
          },
          required: ['name'],
        },
      },
    },
    required: ['artists'],
  }
}

export interface NormalizedExtraction {
  rows: LineupChangeRowInput[]
  // Extraction-level problems the planner can't see.
  errors: { line: number; message: string }[]
}

/** Map validated model output onto planner row inputs. Day-less artists
 * become unscheduled (TBA) rows — `day: null` — since migration 0008
 * made lineup slots' day optional; festivals announce artists before
 * day splits, and that state is now first-class rather than a warning.
 * Rows keep their 1-based position in the model's array as `line` so
 * errors point back at the extraction the admin reviews. */
export function normalizeExtractedLineup(extracted: ExtractedLineup): NormalizedExtraction {
  const rows: LineupChangeRowInput[] = []
  const errors: { line: number; message: string }[] = []
  extracted.artists.forEach((a, i) => {
    const line = i + 1
    if (!a.name) {
      errors.push({ line, message: 'Artist name is empty.' })
      return
    }
    rows.push({
      line,
      artist: a.name,
      day: a.day,
      stage: a.stage,
      tier: a.tier ? a.tier.toLowerCase() : null,
      genre: a.genre,
      start: a.start,
      end: a.end,
    })
  })
  return { rows, errors }
}

// Strip everything but letters/digits (any script) so punctuation/case
// differences don't defeat the match. The multiplication sign is mapped
// to a letter x first — "Chris Lake × Disclosure" on the page must match
// a model that writes "Chris Lake x Disclosure" (b2b billings flip
// between the two constantly).
const squash = (s: string) =>
  s.toLowerCase().replace(/[×✕✖]/g, 'x').replace(/[^\p{L}\p{N}]+/gu, '')

export interface HallucinationGuardResult {
  kept: LineupChangeRowInput[]
  dropped: { line: number; message: string }[]
}

/** Drop rows whose artist name does not literally occur in the source
 * text (case/punctuation-insensitive). A model can only hallucinate a
 * name that never appeared on the page; a name it merely mis-schedules
 * still passes and gets caught in review. Names that squash to nothing
 * (pure-symbol names) are kept — the guard can't say anything about
 * them. */
export function guardAgainstHallucination(
  rows: LineupChangeRowInput[],
  sourceText: string,
): HallucinationGuardResult {
  const haystack = squash(sourceText)
  const kept: LineupChangeRowInput[] = []
  const dropped: { line: number; message: string }[] = []
  for (const row of rows) {
    const needle = squash(row.artist)
    if (needle.length === 0 || haystack.includes(needle)) {
      kept.push(row)
    } else {
      dropped.push({
        line: row.line,
        message: `"${row.artist}" does not appear in the source text (possible hallucination).`,
      })
    }
  }
  return { kept, dropped }
}
