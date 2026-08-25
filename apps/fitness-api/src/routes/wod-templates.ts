import { Hono } from 'hono'
import { ulid } from 'ulid'
import {
  createStrengthTemplateSchema,
  createWodTemplateSchema,
  patchWodTemplateSchema,
  templateKindSchema,
  wodTypeSchema,
  type StrengthBody,
  type WodBody,
  type WodTemplateDto,
} from '@rallypoint/fitness-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { UniqueConstraintError } from '@rallypoint/api-kit'
import type { WodTemplateFilter, WodTemplateRecord } from '../repos/types.js'
import { idempotentCreate } from '../lib/idempotent-create.js'
import { readJsonBody } from './_body.js'

// The WOD-template UI surface (cookie + CSRF + session gated in build-app).
// Reads return the union of curated global (benchmark) rows and the actor's
// own custom rows; the write path creates a PRIVATE custom WOD via a
// race-safe find-or-create scoped to the owner (mirrors `exercises`).

function toDto(r: WodTemplateRecord): WodTemplateDto {
  if (r.kind === 'strength') {
    return {
      id: r.id,
      name: r.name,
      isCustom: r.ownerUserId !== null,
      isBenchmark: r.isBenchmark,
      kind: 'strength',
      wodType: null,
      timeCapS: null,
      description: r.description,
      body: r.body,
      ref: r.ref,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }
  }
  return {
    id: r.id,
    name: r.name,
    isCustom: r.ownerUserId !== null,
    isBenchmark: r.isBenchmark,
    kind: 'wod',
    wodType: r.wodType,
    timeCapS: r.timeCapS,
    description: r.description,
    body: r.body,
    ref: r.ref,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

export const wodTemplatesRoutes = new Hono<HonoApp>()
  // --- list / search -------------------------------------------------
  .get('/api/v1/ui/wod-templates', async (c) => {
    const userId = c.var.session!.userId
    const url = new URL(c.req.url)
    const filter: WodTemplateFilter = {}
    const q = url.searchParams.get('q')
    const type = url.searchParams.get('type')
    const kind = url.searchParams.get('kind')
    const benchmarkOnly = url.searchParams.get('benchmark_only')
    if (q) filter.q = q
    if (type) {
      // Same enum-at-the-boundary pattern the /exercises GET uses since the
      // pre-PR fix sweep: typos return 400 instead of a silent empty list.
      const parsed = wodTypeSchema.safeParse(type)
      if (!parsed.success) {
        throw errors.validation({
          issues: [{ code: 'custom', path: ['type'], message: 'Unknown WOD type.' }],
        })
      }
      filter.wodType = parsed.data
    }
    if (kind) {
      // Mirror the wodType enum-validation pattern: a typoed `?kind=wd`
      // is a client bug, not a request for "everything". Return 400 so
      // the caller sees it instead of getting an empty list (S8).
      const parsed = templateKindSchema.safeParse(kind)
      if (!parsed.success) {
        throw errors.validation({
          issues: [{ code: 'custom', path: ['kind'], message: 'Unknown template kind.' }],
        })
      }
      filter.kind = parsed.data
    }
    if (benchmarkOnly === '1' || benchmarkOnly === 'true') filter.benchmarkOnly = true
    const customOnly = url.searchParams.get('custom_only')
    if (customOnly === '1' || customOnly === 'true') filter.customOnly = true
    const rows = await c.var.repos.wodTemplates.listForActor(userId, filter)
    return c.json({ wodTemplates: rows.map(toDto) })
  })
  // --- get one -------------------------------------------------------
  .get('/api/v1/ui/wod-templates/:id', async (c) => {
    const userId = c.var.session!.userId
    const row = await c.var.repos.wodTemplates.getForActor(userId, c.req.param('id'))
    if (!row) throw errors.notFound('WOD template not found.')
    return c.json(toDto(row))
  })
  // --- create custom (find-or-create, per-owner) ---------------------
  // Body shape depends on `kind`. Default `'wod'` keeps the route
  // backward-compatible: old clients that never sent `kind` still
  // validate as WOD-shape via `createWodTemplateSchema`. The discriminator
  // lives inside `body.body.kind` for strength templates (the strength
  // body schema itself requires `kind: 'strength'`); WOD bodies don't
  // carry a kind because they use the wodType discriminator instead.
  .post('/api/v1/ui/wod-templates', async (c) => {
    const userId = c.var.session!.userId
    const raw = (await readJsonBody(c)) as Record<string, unknown>
    // Sniff the kind: explicit top-level `kind`, otherwise inferred
    // from whether the body's discriminator is 'strength'.
    const explicitKind = typeof raw['kind'] === 'string' ? raw['kind'] : null
    const bodyKindRaw = (raw['body'] as { kind?: unknown } | undefined)?.kind
    const bodyKind = typeof bodyKindRaw === 'string' ? bodyKindRaw : null
    // Reject explicitly contradictory inputs (e.g. `kind:'wod'` at the
    // top with `body.kind:'strength'` in the body) — silently picking
    // strength when the top-level says WOD was the bug behind code-
    // review F6. Two equal discriminators are fine; one absent is
    // fine; only an explicit disagreement errors.
    if (explicitKind != null && bodyKind != null && explicitKind !== bodyKind) {
      throw errors.validation({
        issues: [
          {
            code: 'custom',
            path: ['kind'],
            message: `top-level kind="${explicitKind}" disagrees with body.kind="${bodyKind}"`,
          },
        ],
      })
    }
    // Reject any kind value other than 'wod' / 'strength' early so a
    // typoed `kind:"strenght"` doesn't fall through into the wod branch.
    if (explicitKind != null && explicitKind !== 'wod' && explicitKind !== 'strength') {
      throw errors.validation({
        issues: [
          { code: 'custom', path: ['kind'], message: `unknown kind "${explicitKind}"` },
        ],
      })
    }
    const isStrength = explicitKind === 'strength' || bodyKind === 'strength'

    // ref layering note (mirrors exercises.ts): the offline-create `ref`
    // idempotency key is checked FIRST via idempotentCreate (authoritative
    // for a retried create); the pre-existing per-(owner, kind, name)
    // find-or-create runs unchanged inside its `create` callback. A name
    // collision can't be mistaken for a ref replay — see
    // apps/fitness-api/src/lib/idempotent-create.ts.
    if (isStrength) {
      const parsed = createStrengthTemplateSchema.safeParse(raw)
      if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
      const data = parsed.data
      const name = data.name.trim().replace(/\s+/g, ' ')
      const ref = data.ref ?? null

      let outcome: { record: WodTemplateRecord; viaNameMatch: boolean; idempotent: boolean }
      try {
        const result = await idempotentCreate<{
          record: WodTemplateRecord
          viaNameMatch: boolean
        }>({
          ref,
          findByRef: async () => {
            if (ref === null) return null
            const existing = await c.var.repos.wodTemplates.findByOwnerAndRef(userId, ref)
            return existing ? { record: existing, viaNameMatch: false } : null
          },
          create: async () => {
            const existingByName = await c.var.repos.wodTemplates.findCustomByName(
              userId,
              name,
              'strength',
            )
            if (existingByName) return { record: existingByName, viaNameMatch: true }
            const created = await c.var.repos.wodTemplates.createCustom({
              id: `wt_${ulid()}`,
              ownerUserId: userId,
              kind: 'strength',
              name,
              description: data.description ?? null,
              body: data.body,
              ref,
            })
            return { record: created, viaNameMatch: false }
          },
        })
        outcome = { ...result.row, idempotent: result.idempotent }
      } catch (err) {
        if (err instanceof UniqueConstraintError) {
          const raced = await c.var.repos.wodTemplates.findCustomByName(userId, name, 'strength')
          if (raced) return c.json(toDto(raced), 200)
          throw errors.conflict('wod_name_taken', 'You already have a WOD with that name.')
        }
        throw err
      }
      if (outcome.idempotent) return c.json({ ...toDto(outcome.record), idempotent: true }, 200)
      if (outcome.viaNameMatch) return c.json(toDto(outcome.record), 200)
      return c.json(toDto(outcome.record), 201)
    }

    const parsed = createWodTemplateSchema.safeParse(raw)
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data
    const name = body.name.trim().replace(/\s+/g, ' ')
    const ref = body.ref ?? null

    let outcome: { record: WodTemplateRecord; viaNameMatch: boolean; idempotent: boolean }
    try {
      const result = await idempotentCreate<{ record: WodTemplateRecord; viaNameMatch: boolean }>({
        ref,
        findByRef: async () => {
          if (ref === null) return null
          const existing = await c.var.repos.wodTemplates.findByOwnerAndRef(userId, ref)
          return existing ? { record: existing, viaNameMatch: false } : null
        },
        create: async () => {
          const existingByName = await c.var.repos.wodTemplates.findCustomByName(
            userId,
            name,
            'wod',
          )
          if (existingByName) return { record: existingByName, viaNameMatch: true }
          const created = await c.var.repos.wodTemplates.createCustom({
            id: `wt_${ulid()}`,
            ownerUserId: userId,
            kind: 'wod',
            name,
            wodType: body.wodType,
            timeCapS: body.timeCapS ?? null,
            description: body.description ?? null,
            body: body.body,
            ref,
          })
          return { record: created, viaNameMatch: false }
        },
      })
      outcome = { ...result.row, idempotent: result.idempotent }
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        const raced = await c.var.repos.wodTemplates.findCustomByName(userId, name, 'wod')
        if (raced) return c.json(toDto(raced), 200)
        throw errors.conflict('wod_name_taken', 'You already have a WOD with that name.')
      }
      throw err
    }
    if (outcome.idempotent) return c.json({ ...toDto(outcome.record), idempotent: true }, 200)
    if (outcome.viaNameMatch) return c.json(toDto(outcome.record), 200)
    return c.json(toDto(outcome.record), 201)
  })
  // --- patch (owner-only) --------------------------------------------
  .patch('/api/v1/ui/wod-templates/:id', async (c) => {
    const userId = c.var.session!.userId
    const parsed = patchWodTemplateSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    // Pre-fetch the existing row so we can validate kind-vs-fields
    // (code-review F-PATCH-timeCapS-on-strength). The repo's update()
    // previously silently swallowed timeCapS on strength rows — the
    // PATCH returned 200 with the field invisibly dropped. Surfacing
    // the validation at the route gives the client a real 400 instead.
    const existing = await c.var.repos.wodTemplates.getForActor(userId, c.req.param('id'))
    if (!existing || existing.ownerUserId !== userId) {
      // Not-found for strangers + globally-owned rows (no leak about admin rows).
      throw errors.notFound('WOD template not found.')
    }
    if (existing.kind === 'strength' && body.wodType !== undefined) {
      throw errors.validation({
        issues: [
          {
            code: 'custom',
            path: ['wodType'],
            message: 'Strength templates do not carry a wodType.',
          },
        ],
      })
    }
    if (existing.kind === 'strength' && 'timeCapS' in body) {
      throw errors.validation({
        issues: [
          {
            code: 'custom',
            path: ['timeCapS'],
            message: 'Strength templates do not carry a time cap.',
          },
        ],
      })
    }
    // Body edits: strength rows take a strength body; custom (non-
    // benchmark) wod rows take a wod body — the one-Builder composer
    // edits every kind structurally. Finished results are self-contained
    // snapshots (workouts.payload + workout_sets), so a body edit can't
    // corrupt history. Benchmarks stay immutable: they're shared rows and
    // their scheme IS their identity. (Benchmark rows are globally owned,
    // so the ownership check above already 404s them — the isBenchmark
    // guard is belt-and-braces for any future user-owned benchmark.)
    let strengthBodyPatch: StrengthBody | undefined
    let wodBodyPatch: WodBody | undefined
    if (body.body !== undefined) {
      if (existing.kind === 'strength') {
        if (!('kind' in body.body) || body.body.kind !== 'strength') {
          throw errors.validation({
            issues: [
              {
                code: 'custom',
                path: ['body'],
                message: 'A strength template takes a strength body.',
              },
            ],
          })
        }
        strengthBodyPatch = body.body
      } else {
        if (existing.isBenchmark) {
          throw errors.validation({
            issues: [
              { code: 'custom', path: ['body'], message: 'Benchmark WOD bodies are immutable.' },
            ],
          })
        }
        if ('kind' in body.body) {
          throw errors.validation({
            issues: [
              { code: 'custom', path: ['body'], message: 'A WOD template takes a WOD body.' },
            ],
          })
        }
        wodBodyPatch = body.body
        // The body's discriminator is authoritative; a top-level wodType,
        // when sent, must agree (mirrors createWodTemplateSchema's
        // bodyMatchesWodType cross-check).
        if (body.wodType !== undefined && body.wodType !== body.body.wodType) {
          throw errors.validation({
            issues: [
              {
                code: 'custom',
                path: ['body', 'wodType'],
                message: 'body.wodType must match the template wodType',
              },
            ],
          })
        }
      }
    } else if (body.wodType !== undefined) {
      // A type change without the matching body would desync the wod_type
      // column from the stored body's discriminator.
      throw errors.validation({
        issues: [
          { code: 'custom', path: ['wodType'], message: 'wodType requires a matching body.' },
        ],
      })
    }

    const updated = await c.var.repos.wodTemplates.update(userId, c.req.param('id'), {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...('description' in body ? { description: body.description ?? null } : {}),
      ...('timeCapS' in body ? { timeCapS: body.timeCapS ?? null } : {}),
      ...(strengthBodyPatch !== undefined ? { strengthBody: strengthBodyPatch } : {}),
      ...(wodBodyPatch !== undefined
        ? { wodBody: wodBodyPatch, wodType: wodBodyPatch.wodType }
        : {}),
    })
    if (!updated) throw errors.notFound('WOD template not found.')
    return c.json(toDto(updated))
  })
  // --- delete (owner-only) -------------------------------------------
  .delete('/api/v1/ui/wod-templates/:id', async (c) => {
    const userId = c.var.session!.userId
    const ok = await c.var.repos.wodTemplates.delete(userId, c.req.param('id'))
    if (!ok) throw errors.notFound('WOD template not found.')
    return c.json({ ok: true })
  })
