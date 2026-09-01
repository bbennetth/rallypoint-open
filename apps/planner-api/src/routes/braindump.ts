import { Hono } from 'hono'
import type { ListsClient } from '@rallypoint/lists-client'
import type { AiTracesRpc } from '@rallypoint/ai'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { applyPerUserRateLimit } from '../middleware/rate-limit.js'
import { proxyLists } from '../lib/sdk-error.js'
import { readJsonBody } from './_body.js'
import { resolveBraindumpList } from '../lib/personal-scope.js'
import {
  BRAINDUMP_CATEGORIES,
  BRAINDUMP_MODEL,
  EnrichRequestSchema,
  SummaryRequestSchema,
  buildEnrichInput,
  buildSummaryInput,
  coerceEnrichment,
  coerceSummary,
  parseEnrichOutput,
  parseSummaryOutput,
  type EnrichResponse,
  type SummaryResponse,
} from '../lib/braindump.js'
import { buildAssistTrace } from './assist.js'
import { runAssist, type AiBinding } from '../services/assist.js'

// Brain Dump BFF — one free-text capture surface replacing the separate
// Diary/Notes tools. A single system-managed `braindump`-type list per user
// holds the captures; AI-derived metadata (category + themes/entities/
// summary) rides the generic custom-fields machinery, seeded on first
// provision. Entry CRUD reuses the generic /api/v1/ui/lists/:listId/
// {items,fields} routes — this file adds only the provision route and the
// STATELESS AI compositions (enrich + range summary), which save nothing:
// planner-web writes results through the existing create/update paths, so
// the offline outbox stays intact and no domain rule lands in this thin BFF
// (assist.ts pattern).

export const CATEGORY_FIELD_LABEL = 'Category'
export const AI_ANALYSIS_FIELD_LABEL = 'AI Analysis'

// Enrich shares assist's per-user budget family; summary is a heavier prompt
// so it gets a tighter cap.
const ENRICH_RATE_LIMIT = { route: 'ai-braindump', limit: 15, windowSeconds: 60 } as const
const SUMMARY_RATE_LIMIT = { route: 'ai-braindump-summary', limit: 5, windowSeconds: 60 } as const

function unavailable(): ApiError {
  return new ApiError({
    code: 'braindump_ai_unavailable',
    message: 'AI analysis is not available right now.',
    status: 503,
  })
}

function unparsable(): ApiError {
  return new ApiError({
    code: 'braindump_ai_unparsable',
    message: 'Could not analyze that. The dump is saved — try Analyze again later.',
    status: 422,
  })
}

// Same code as enrich's 422 (the client branches on code, not text) but the
// enrich wording — "the dump is saved, try Analyze" — is wrong for a range
// summary, which saves nothing and has no per-entry Analyze.
function unparsableSummary(): ApiError {
  return new ApiError({
    code: 'braindump_ai_unparsable',
    message: 'Could not summarize those entries. Try again, or narrow the date range.',
    status: 422,
  })
}

// Seed the default fields once. Idempotent by label (guards the first-access
// create race, mirroring diary's seedMoodField): Category as a single_select
// over the fixed vocabulary (server-minted stable choice ids, rename-safe),
// AI Analysis as a text field holding the versioned JSON codec value.
async function seedBraindumpFields(
  lists: ListsClient,
  listId: string,
  actor: string,
): Promise<void> {
  const defs = await lists.listFieldDefs(listId, actor)
  if (!defs.some((d) => d.label === CATEGORY_FIELD_LABEL)) {
    await lists.createFieldDef(
      listId,
      {
        label: CATEGORY_FIELD_LABEL,
        fieldType: 'single_select',
        required: false,
        choices: BRAINDUMP_CATEGORIES.map((label) => ({ label })),
      },
      actor,
    )
  }
  if (!defs.some((d) => d.label === AI_ANALYSIS_FIELD_LABEL)) {
    await lists.createFieldDef(
      listId,
      { label: AI_ANALYSIS_FIELD_LABEL, fieldType: 'text', required: false },
      actor,
    )
  }
}

export const braindumpRoutes = new Hono<HonoApp>()
  // --- get THE caller's brain-dump list (auto-provision + seed fields) ---
  .get('/api/v1/ui/braindump/list', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const lists = c.var.services.listsClient
    const list = await proxyLists(async () => {
      const { list } = await resolveBraindumpList(lists, actor)
      // Seed on every GET, not just on create: idempotent by label, and it
      // heals a list whose first-access seeding half-completed (e.g. the
      // AI Analysis create failed after Category succeeded) — otherwise
      // analyze stays disabled behind a "still loading" that never clears.
      await seedBraindumpFields(lists, list.id, actor)
      return list
    })
    return c.json(list)
  })

  // --- analyze one dump: category + themes/entities/summary + suggestions ---
  .post('/api/v1/ui/braindump/enrich', requireSession(), async (c) => {
    const ai = c.env.AI as AiBinding | undefined
    if (!ai) throw unavailable()
    await applyPerUserRateLimit(c, { userId: c.var.session!.userId, ...ENRICH_RATE_LIMIT })

    const parsed = EnrichRequestSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const { text, clientNow, tz, knownConcepts } = parsed.data

    const aiRpc = (c.env.AI_TRACES as AiTracesRpc | undefined) ?? null
    const trace = await buildAssistTrace(c, aiRpc)
    const input = buildEnrichInput(text, clientNow, tz, knownConcepts)

    let run
    try {
      const model = c.var.env.ASSIST_MODEL ?? BRAINDUMP_MODEL
      run = await runAssist(ai, model, input, c.var.env.AI_GATEWAY_ID, trace, c.var.logger, 'braindump')
    } catch (err) {
      c.var.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'braindump enrich model call failed',
      )
      throw unavailable()
    }

    if (!run.ok) throw unparsable()
    const raw = parseEnrichOutput(run.object)
    if (raw === null) throw unparsable()

    const body: EnrichResponse = {
      ...coerceEnrichment(raw, tz),
      traceId: run.traceId ?? run.responseId ?? '',
      responseId: run.responseId ?? '',
    }
    return c.json(body)
  })

  // --- summarize a date range of entries (client sends the capped corpus) ---
  .post('/api/v1/ui/braindump/summary', requireSession(), async (c) => {
    const ai = c.env.AI as AiBinding | undefined
    if (!ai) throw unavailable()
    await applyPerUserRateLimit(c, { userId: c.var.session!.userId, ...SUMMARY_RATE_LIMIT })

    const parsed = SummaryRequestSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })

    const aiRpc = (c.env.AI_TRACES as AiTracesRpc | undefined) ?? null
    const trace = await buildAssistTrace(c, aiRpc)
    const input = buildSummaryInput(parsed.data.entries)

    let run
    try {
      const model = c.var.env.ASSIST_MODEL ?? BRAINDUMP_MODEL
      run = await runAssist(ai, model, input, c.var.env.AI_GATEWAY_ID, trace, c.var.logger, 'braindump-summary')
    } catch (err) {
      c.var.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'braindump summary model call failed',
      )
      throw unavailable()
    }

    if (!run.ok) throw unparsableSummary()
    const raw = parseSummaryOutput(run.object)
    if (raw === null) throw unparsableSummary()
    const summary = coerceSummary(raw)
    if (summary === null) throw unparsableSummary()

    const body: SummaryResponse = {
      ...summary,
      traceId: run.traceId ?? run.responseId ?? '',
      responseId: run.responseId ?? '',
    }
    return c.json(body)
  })
