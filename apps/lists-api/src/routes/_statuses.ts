import { ulid } from 'ulid'
import {
  DEFAULT_STATUS_SEEDS,
  defaultStatusForCategory,
  type StatusCategory,
  type TaskStatus,
} from '@rallypoint/lists-shared'
import type { Context } from 'hono'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { ListStatusRecord } from '../repos/types.js'

const TENANT = 'rallypoint'

// Lazily seed the default status set the first time a list's statuses are
// needed (no migration backfill — D1 can't mint ULIDs in pure SQL).
// Returns the list's live statuses, seeding the three defaults when empty.
// A concurrent double-seed is benign: category resolution always takes the
// lowest-position match, so duplicates just sort after the originals.
export async function ensureStatuses(
  c: Context<HonoApp>,
  listId: string,
  actor: string,
): Promise<ListStatusRecord[]> {
  const existing = await c.var.repos.listStatuses.listForList(listId)
  if (existing.length > 0) return existing
  return c.var.repos.listStatuses.seedDefaults(
    listId,
    TENANT,
    actor,
    DEFAULT_STATUS_SEEDS.map((s) => ({
      id: `lst_${ulid()}`,
      name: s.name,
      color: s.color,
      category: s.category,
    })),
  )
}

// The dual-write pair the item repos persist: the new status_id linkage
// and the legacy `status` category text (which still drives the completed
// mirror). RPL v1.0.0 keeps both in lockstep through launch.
export interface ResolvedStatus {
  statusId: string | null
  status: TaskStatus | null
}

// Resolve a write's intended status against a list's (already-seeded)
// statuses. Precedence: an explicit statusId wins; otherwise a legacy
// category maps to that category's representative status; `fallback`
// (used on create) supplies the category when neither is given. Throws a
// validation error when a supplied statusId doesn't belong to the list.
export function resolveStatus(
  statuses: ListStatusRecord[],
  opts: {
    statusId?: string | null | undefined
    category?: TaskStatus | null | undefined
    fallbackCategory?: StatusCategory
  },
): ResolvedStatus {
  if (opts.statusId !== undefined) {
    if (opts.statusId === null) return { statusId: null, status: null }
    const found = statuses.find((s) => s.id === opts.statusId && s.deletedAt === null)
    if (!found) {
      throw errors.validation({
        issues: [{ code: 'custom', path: ['statusId'], message: 'Unknown status for this list.' }],
      })
    }
    return { statusId: found.id, status: found.category }
  }
  const category =
    opts.category !== undefined && opts.category !== null
      ? opts.category
      : (opts.fallbackCategory ?? null)
  if (category === null) return { statusId: null, status: null }
  const def = defaultStatusForCategory(statuses, category)
  return { statusId: def?.id ?? null, status: category }
}
