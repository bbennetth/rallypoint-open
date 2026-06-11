import { Hono } from 'hono'
import { ulid } from 'ulid'
import {
  CreateFieldDefSchema,
  UpdateFieldDefSchema,
  buildCreateOptions,
  mergeUpdateOptions,
  isSelectFieldType,
  isUnsatisfiableRequiredSelect,
  uniqueFieldKey,
} from '@rallypoint/lists-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { FieldDefRecord, UpdateFieldDefInput } from '../repos/types.js'
import { readJsonBody } from './_body.js'
import { envelope, listChannel } from '../realtime/channels.js'
import { publish } from '../realtime/publish.js'
import { loadListForRead, loadListForWrite } from './_list-access.js'

// Custom field-definition CRUD for a list (Lists v2, slice 1). Mounted
// under /api/v1/ui/lists/:listId/fields. Reads require list read access;
// writes require the list creator (loadListForWrite). A field def is the
// schema for a per-item custom value — slice 3 wires the values
// themselves onto list_items.custom_fields.

const TENANT = 'rallypoint'

function mintOptionId(): string {
  return `opt_${ulid()}`
}

function serializeFieldDef(d: FieldDefRecord): Record<string, unknown> {
  return {
    id: d.id,
    list_id: d.listId,
    key: d.key,
    label: d.label,
    field_type: d.fieldType,
    options: d.options,
    required: d.required,
    default_value: d.defaultValue,
    position: d.position,
    created_by: d.createdBy,
    created_at: d.createdAt.toISOString(),
    updated_at: d.updatedAt.toISOString(),
  }
}

export const fieldDefsRoutes = new Hono<HonoApp>()
  // --- define a field (creator only) -------------------------------
  .post('/api/v1/ui/lists/:listId/fields', async (c) => {
    const userId = c.var.session!.userId
    const listId = c.req.param('listId')
    await loadListForWrite(c, listId)
    const parsed = CreateFieldDefSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    // Derive a per-list-unique slug from the label (live fields only).
    const existing = await c.var.repos.fieldDefs.listForList(listId)
    const key = uniqueFieldKey(
      body.label,
      existing.map((d) => d.key),
    )
    const options = buildCreateOptions(
      body.fieldType,
      { choices: body.choices, multiline: body.multiline },
      mintOptionId,
    )

    // Block the unsatisfiable state at creation too (#258): the schema only
    // rejects an EMPTY choices array, so a required select whose sole choice
    // is created already-archived would otherwise strand the Add form.
    if (isUnsatisfiableRequiredSelect(body.fieldType, body.required, options)) {
      throw errors.validation({
        issues: [
          {
            code: 'custom',
            path: ['choices'],
            message: 'A required select field must have at least one active choice.',
          },
        ],
      })
    }

    const def = await c.var.repos.fieldDefs.create({
      id: `lfd_${ulid()}`,
      tenantId: TENANT,
      listId,
      key,
      label: body.label,
      fieldType: body.fieldType,
      options,
      required: body.required,
      ...(body.position !== undefined ? { position: body.position } : {}),
      createdBy: userId,
    })
    publish(c, listChannel(listId), envelope('list_field_defs', 'create', def.id, userId))
    return c.json(serializeFieldDef(def), 201)
  })

  // --- list a list's fields (read access) --------------------------
  .get('/api/v1/ui/lists/:listId/fields', async (c) => {
    const listId = c.req.param('listId')
    await loadListForRead(c, listId)
    const defs = await c.var.repos.fieldDefs.listForList(listId)
    return c.json({ items: defs.map(serializeFieldDef) })
  })

  // --- update a field (creator only) -------------------------------
  .patch('/api/v1/ui/lists/:listId/fields/:fieldId', async (c) => {
    const userId = c.var.session!.userId
    const listId = c.req.param('listId')
    await loadListForWrite(c, listId)
    const parsed = UpdateFieldDefSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    const def = await c.var.repos.fieldDefs.findById(c.req.param('fieldId'))
    if (!def || def.deletedAt || def.listId !== listId) throw errors.fieldDefNotFound()

    // fieldType is immutable, so the type-dependent rules the create
    // schema enforces inline must be checked here against the stored def.
    const issues: Array<{ code: string; path: string[]; message: string }> = []
    if (body.choices !== undefined && !isSelectFieldType(def.fieldType)) {
      issues.push({ code: 'custom', path: ['choices'], message: 'Only select fields accept choices.' })
    }
    if (body.multiline !== undefined && def.fieldType !== 'text') {
      issues.push({
        code: 'custom',
        path: ['multiline'],
        message: 'Only text fields accept the multiline flag.',
      })
    }
    if (issues.length > 0) throw errors.validation({ issues })

    const patch: UpdateFieldDefInput = {}
    if (body.label !== undefined) patch.label = body.label
    if (body.required !== undefined) patch.required = body.required
    if (body.position !== undefined) patch.position = body.position
    if (body.choices !== undefined || body.multiline !== undefined) {
      patch.options = mergeUpdateOptions(
        def.fieldType,
        def.options,
        { choices: body.choices, multiline: body.multiline },
        mintOptionId,
      )
    }

    // Block the unsatisfiable state (#258): a required select with zero
    // active choices can never be given a value, permanently disabling the
    // item Add form. Check the RESULTING def — a PATCH may flip `required`
    // or archive the last choice independently, so resolve both against the
    // stored def before deciding.
    const resultOptions = patch.options ?? def.options
    const resultRequired = patch.required ?? def.required
    if (isUnsatisfiableRequiredSelect(def.fieldType, resultRequired, resultOptions)) {
      throw errors.validation({
        issues: [
          {
            code: 'custom',
            path: ['choices'],
            message: 'A required select field must keep at least one active choice.',
          },
        ],
      })
    }

    const updated = await c.var.repos.fieldDefs.update(def.id, patch)
    if (!updated) throw errors.fieldDefNotFound()
    publish(c, listChannel(listId), envelope('list_field_defs', 'update', updated.id, userId))
    return c.json(serializeFieldDef(updated))
  })

  // --- soft-delete a field (creator only) --------------------------
  .delete('/api/v1/ui/lists/:listId/fields/:fieldId', async (c) => {
    const userId = c.var.session!.userId
    const listId = c.req.param('listId')
    await loadListForWrite(c, listId)
    const def = await c.var.repos.fieldDefs.findById(c.req.param('fieldId'))
    if (!def || def.deletedAt || def.listId !== listId) throw errors.fieldDefNotFound()
    await c.var.repos.fieldDefs.softDelete(def.id, new Date())
    publish(c, listChannel(listId), envelope('list_field_defs', 'delete', def.id, userId))
    return c.body(null, 204)
  })
