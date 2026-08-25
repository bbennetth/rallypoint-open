import { ulid } from 'ulid'
import type {
  ListBundle,
  ListImportResult,
  ListItemBundle,
  ScopeType,
} from '@rallypoint/lists-shared'
import {
  createCommentCore,
  createFieldDefCore,
  createListCore,
  createListItemCore,
  createSeriesCore,
  listListsCore,
  type ListsNotFound,
  type ListsRpcDeps,
  type Forbidden,
  type Ok,
} from './rpc-core.js'

// Generic per-list export/import, the capability Planner's backup–restore is
// built on. It lives in lists-api because Planner is a thin BFF: the rules for
// what a list contains, and what it means to write one back, belong next to the
// tables that enforce them.
//
// The import path deliberately COMPOSES the existing *Core create functions
// rather than bulk-inserting rows. Those functions already carry the access
// gate, custom-field validation, parent-depth and position rules, and — for
// items and series — ref-based idempotent create, which is exactly the dedupe
// semantics an import needs. A parallel bulk path would be faster but would be
// a second, unvalidated way to write a list, free to drift from the real one.
// The cost is one D1 round trip per row, which is fine at the scale this is
// used for (a personal scope is tens to hundreds of items per list).

const TENANT = 'rallypoint'

/** Every list in a scope, as bundles. */
export async function exportListBundleCore(
  actor: string,
  listId: string,
  deps: ListsRpcDeps,
): Promise<Ok<ListBundle> | ListsNotFound> {
  const list = await deps.repos.lists.findById(listId)
  if (!list || list.deletedAt) return { kind: 'list_not_found' }
  // Reuse the read gate the rest of the surface uses: an actor who cannot see
  // the list gets the same opaque not-found the other reads return.
  const visible = await listListsCore(actor, list.scopeType as ScopeType, list.scopeId, deps)
  if (!visible.some((l) => l.id === list.id)) return { kind: 'list_not_found' }

  const [fieldDefs, statuses, labels, series, allItems] = await Promise.all([
    deps.repos.fieldDefs.listForList(list.id),
    deps.repos.listStatuses.listForList(list.id),
    deps.repos.listLabels.listForList(list.id),
    deps.repos.series.list(list.id),
    deps.repos.listItems.listForList(list.id),
  ])

  // Occurrences are left out on purpose: importing the series regenerates
  // them, so carrying them here would double every recurring item.
  const items = allItems.filter((i) => i.seriesId === null)

  const statusNameById = new Map(statuses.map((s) => [s.id, s.name]))
  const refById = new Map(items.map((i) => [i.id, i.ref ?? i.id]))
  const labelsByItem = await deps.repos.listLabels.labelsForItems(items.map((i) => i.id))
  const labelNamesById = new Map(labels.map((l) => [l.id, l.name]))

  const comments = await Promise.all(
    items.map((i) => deps.repos.listItemComments.listForItem(i.id)),
  )

  return {
    kind: 'ok',
    data: {
      listType: list.listType,
      name: list.name,
      visibility: list.visibility,
      color: list.color,
      fieldDefs: fieldDefs.map((d) => ({
        sourceId: d.id,
        key: d.key,
        label: d.label,
        fieldType: d.fieldType,
        options: d.options,
        required: d.required,
        defaultValue: d.defaultValue,
        position: d.position,
      })),
      statuses: statuses.map((s) => ({
        name: s.name,
        color: s.color,
        category: s.category,
        position: s.position,
      })),
      labels: labels.map((l) => ({ name: l.name, color: l.color, position: l.position })),
      series: series.map((s) => ({
        ref: s.ref ?? s.id,
        title: s.title,
        notes: s.notes,
        assignedTo: s.assignedTo,
        priority: s.priority,
        freq: s.freq,
        interval: s.interval,
        byDay: s.byDay,
        dtstart: s.dtstart,
        until: s.until,
        count: s.count,
        timeOfDay: s.timeOfDay,
      })),
      items: items.map((i, idx) => ({
        ref: i.ref ?? i.id,
        title: i.title,
        notes: i.notes,
        assignedTo: i.assignedTo,
        priority: i.priority,
        dueDate: i.dueDate ? i.dueDate.toISOString() : null,
        completed: i.completed,
        completedAt: i.completedAt ? i.completedAt.toISOString() : null,
        position: i.position,
        parentRef: i.parentId ? (refById.get(i.parentId) ?? null) : null,
        statusName: i.statusId ? (statusNameById.get(i.statusId) ?? null) : null,
        labelNames: (labelsByItem.get(i.id) ?? [])
          .map((id) => labelNamesById.get(id))
          .filter((n): n is string => typeof n === 'string'),
        customFields: i.customFields,
        comments: (comments[idx] ?? []).map((c) => ({ body: c.body })),
      })),
    },
  }
}

export interface ImportScope {
  scopeType: ScopeType
  scopeId: string
}

export async function importListBundleCore(
  actor: string,
  scope: ImportScope,
  bundle: ListBundle,
  deps: ListsRpcDeps,
): Promise<Ok<ListImportResult> | ListsNotFound | Forbidden> {
  const result: ListImportResult = {
    listId: '',
    listCreated: false,
    fieldDefs: { created: 0, skipped: 0 },
    statuses: { created: 0, skipped: 0 },
    labels: { created: 0, skipped: 0 },
    series: { created: 0, skipped: 0 },
    items: { created: 0, skipped: 0 },
    comments: { created: 0, skipped: 0 },
    warnings: [],
  }

  // --- the list itself ------------------------------------------------
  // Lists have no ref column; (scope, name) is the key the DB already
  // enforces, so that is what dedupe uses. Re-importing therefore lands back
  // in the SAME list rather than creating "Groceries (2)".
  const existing = await listListsCore(actor, scope.scopeType, scope.scopeId, deps)
  const match = existing.find((l) => l.name === bundle.name && l.listType === bundle.listType)

  let listId: string
  if (match) {
    listId = match.id
  } else {
    const created = await createListCore(
      actor,
      {
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        listType: bundle.listType as never,
        name: bundle.name,
        visibility: bundle.visibility as never,
        color: bundle.color ?? null,
      },
      deps,
    )
    if (created.kind === 'list_not_found') return created
    if (created.kind === 'list_name_conflict') {
      // A list with this name exists but of a different type, or is
      // soft-deleted and still holding the unique name. Neither is safe to
      // merge into, so report rather than guess.
      result.warnings.push({
        code: 'list_name_conflict',
        message: `A different list named "${bundle.name}" already exists, so it was not imported.`,
      })
      return { kind: 'ok', data: result }
    }
    listId = created.data.id
    result.listCreated = true
  }
  result.listId = listId

  // --- field defs (matched by key) ------------------------------------
  const defs = await deps.repos.fieldDefs.listForList(listId)
  const defIdByKey = new Map(defs.map((d) => [d.key, d.id]))
  for (const def of bundle.fieldDefs) {
    if (defIdByKey.has(def.key)) {
      result.fieldDefs.skipped++
      continue
    }
    const created = await createFieldDefCore(
      actor,
      listId,
      {
        label: def.label,
        fieldType: def.fieldType as never,
        ...(def.options != null ? { options: def.options as never } : {}),
        required: def.required ?? false,
        ...(def.defaultValue != null ? { defaultValue: def.defaultValue as never } : {}),
      },
      deps,
    )
    if (created.kind !== 'ok') {
      result.warnings.push({
        code: 'field_def_failed',
        message: `Custom field "${def.label}" could not be restored.`,
      })
      continue
    }
    // createFieldDefCore derives its own unique key from the label, so map the
    // SOURCE key onto whatever key/id it actually minted.
    defIdByKey.set(def.key, created.data.id)
    result.fieldDefs.created++
  }

  // --- statuses + labels (matched by name) ----------------------------
  // Both are per-list rows written straight through the repos, the same way
  // the HTTP routes do — there is no Core create for them.
  //
  // Check-then-insert, not an upsert: list_statuses/list_labels carry no
  // unique index on (list_id, name), so two imports racing on the same list
  // could each insert. Left as-is deliberately — adding the constraint is an
  // RPL-wide change (existing rows may already hold duplicates, which would
  // fail the migration), and the damage here is a duplicate status chip the
  // user can delete, not lost or mis-attributed data.
  const liveStatuses = await deps.repos.listStatuses.listForList(listId)
  const statusIdByName = new Map(liveStatuses.map((s) => [s.name, s.id]))
  for (const status of bundle.statuses) {
    if (statusIdByName.has(status.name)) {
      result.statuses.skipped++
      continue
    }
    const created = await deps.repos.listStatuses.create({
      id: `lsts_${ulid()}`,
      tenantId: TENANT,
      listId,
      name: status.name,
      color: status.color ?? null,
      category: status.category as never,
      createdBy: actor,
    })
    statusIdByName.set(created.name, created.id)
    result.statuses.created++
  }

  const liveLabels = await deps.repos.listLabels.listForList(listId)
  const labelIdByName = new Map(liveLabels.map((l) => [l.name, l.id]))
  for (const label of bundle.labels) {
    if (labelIdByName.has(label.name)) {
      result.labels.skipped++
      continue
    }
    const created = await deps.repos.listLabels.create({
      id: `llb_${ulid()}`,
      tenantId: TENANT,
      listId,
      name: label.name,
      color: label.color ?? null,
    })
    labelIdByName.set(created.name, created.id)
    result.labels.created++
  }

  // --- series (ref-deduped by createSeriesCore) -----------------------
  const seriesIdByRef = new Map<string, string>()
  const liveSeries = await deps.repos.series.list(listId)
  for (const s of liveSeries) if (s.ref) seriesIdByRef.set(s.ref, s.id)

  for (const s of bundle.series) {
    const already = seriesIdByRef.get(s.ref)
    if (already) {
      result.series.skipped++
      continue
    }
    const created = await createSeriesCore(
      actor,
      listId,
      {
        title: s.title,
        notes: s.notes ?? null,
        assignedTo: s.assignedTo ?? null,
        priority: (s.priority ?? null) as never,
        freq: s.freq as never,
        interval: s.interval,
        byDay: (s.byDay ?? null) as never,
        dtstart: s.dtstart,
        until: s.until ?? null,
        count: s.count ?? null,
        timeOfDay: s.timeOfDay ?? null,
        ref: s.ref,
      } as never,
      deps,
    )
    if (created.kind !== 'ok') {
      result.warnings.push({
        code: 'series_failed',
        ref: s.ref,
        message: `Recurring "${s.title}" could not be restored.`,
      })
      continue
    }
    seriesIdByRef.set(s.ref, created.data.id)
    result.series.created++
  }

  // --- items (two passes: create, then re-link parents) ---------------
  // createListItemCore replays the existing row for a known ref instead of
  // reporting that it did so, so "was this created or skipped?" is answered
  // from a snapshot of the refs already on the list, taken before any writes.
  const preExistingRefs = new Set(
    (await deps.repos.listItems.listForList(listId))
      .map((i) => i.ref)
      .filter((r): r is string => typeof r === 'string'),
  )
  const itemIdByRef = new Map<string, string>()
  const created: { bundle: ListItemBundle; id: string; isNew: boolean }[] = []

  for (const item of bundle.items) {
    const res = await createListItemCore(
      actor,
      listId,
      {
        title: item.title,
        notes: item.notes ?? null,
        assignedTo: item.assignedTo ?? null,
        priority: (item.priority ?? null) as never,
        dueDate: (item.dueDate ?? null) as never,
        ref: item.ref,
        ...(item.statusName && statusIdByName.has(item.statusName)
          ? { statusId: statusIdByName.get(item.statusName)! }
          : {}),
        ...(item.labelNames?.length
          ? {
              labelIds: item.labelNames
                .map((n) => labelIdByName.get(n))
                .filter((id): id is string => typeof id === 'string'),
            }
          : {}),
        // Re-key the custom-field map from the SOURCE list's def ids onto this
        // list's. A value whose def did not come across is dropped rather than
        // written under an id that means something else here.
        ...(item.customFields
          ? { customFields: rekeyCustomFields(item.customFields, bundle.fieldDefs, defIdByKey) }
          : {}),
      } as never,
      deps,
    )
    if (res.kind !== 'ok') {
      result.warnings.push({
        code: 'item_failed',
        ref: item.ref,
        message: `"${item.title}" could not be restored.`,
      })
      continue
    }
    // A ref repeated within the SAME bundle resolves to one row (the create
    // path replays it), so only the first occurrence counts as new — otherwise
    // its comments would be written once per occurrence.
    const isNew = !preExistingRefs.has(item.ref) && !itemIdByRef.has(item.ref)
    itemIdByRef.set(item.ref, res.data.id)
    created.push({ bundle: item, id: res.data.id, isNew })
  }

  // Second pass: parents, completion and position — all of which reference
  // rows that only exist once the first pass finished.
  for (const entry of created) {
    const patch: Record<string, unknown> = {}
    const parentRef = entry.bundle.parentRef
    if (parentRef) {
      const parentId = itemIdByRef.get(parentRef)
      if (parentId && parentId !== entry.id) patch['parentId'] = parentId
      else if (!parentId) {
        result.warnings.push({
          code: 'missing_parent',
          ref: entry.bundle.ref,
          message: `"${entry.bundle.title}" was restored without its parent item.`,
        })
      }
    }
    if (entry.bundle.completed) patch['completed'] = true
    if (typeof entry.bundle.position === 'number') patch['position'] = entry.bundle.position
    if (!Object.keys(patch).length) continue
    await deps.repos.listItems.update(entry.id, patch as never).catch(() => {
      result.warnings.push({
        code: 'item_relink_failed',
        ref: entry.bundle.ref,
        message: `"${entry.bundle.title}" was restored with some details missing.`,
      })
    })
  }

  // --- comments -------------------------------------------------------
  // Comments have no natural key, so they are written only for items this run
  // actually created. Re-importing therefore does not stack duplicates onto an
  // item that was already here.
  for (const entry of created) {
    if (!entry.isNew || !entry.bundle.comments?.length) {
      result.comments.skipped += entry.bundle.comments?.length ?? 0
      continue
    }
    for (const comment of entry.bundle.comments) {
      const res = await createCommentCore(actor, listId, entry.id, comment.body, deps)
      if (res.kind === 'ok') result.comments.created++
      else result.comments.skipped++
    }
  }

  result.items.created += created.filter((c) => c.isNew).length
  result.items.skipped += created.filter((c) => !c.isNew).length

  return { kind: 'ok', data: result }
}

/** Move a custom-field value map from the source list's def ids to this list's,
 *  matching on the def KEY that both sides carry. */
function rekeyCustomFields(
  values: Record<string, unknown>,
  sourceDefs: ListBundle['fieldDefs'],
  defIdByKey: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const keyBySourceId = new Map<string, string>()
  for (const def of sourceDefs) keyBySourceId.set(def.sourceId, def.key)

  const out: Record<string, unknown> = {}
  for (const [sourceId, value] of Object.entries(values)) {
    // System keys (the `rp:` namespace, e.g. the shopping category) are not
    // field-def ids and travel unchanged.
    if (sourceId.startsWith('rp:')) {
      out[sourceId] = value
      continue
    }
    const key = keyBySourceId.get(sourceId)
    const targetId = key ? defIdByKey.get(key) : undefined
    if (targetId) out[targetId] = value
  }
  return out
}
