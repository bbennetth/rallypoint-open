import type { Context } from 'hono'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { ListRecord } from '../repos/types.js'

// Shared read-authorization helper for the Lists UI surface (#128).
//
// The rule, in three layers:
//
// 1. **Scope ownership** — lists-api UI only serves scopes Lists owns.
//    A list with `scope_type='group'` is owned by Events; the
//    legitimate cross-app read path goes events-web → events-api BFF
//    → Lists SDK (key-gated), NOT through this UI surface. Any future
//    non-Lists scope is denied here the same way. Returns 404 so the
//    existence of the list is never leaked through the error code.
//
// 2. **Scope membership** — for the `'list_group'` scope (the only
//    Lists-owned scope today), require a row in `list_group_members`.
//    Non-members 404.
//
// 3. **Visibility** — per-list overlay on top of membership:
//      - `'all'`     → any scope member passes.
//      - `'private'` → require `userId === list.createdBy` OR a row in
//                      `list_shares` for the (list, user) pair.
//
// All read endpoints route through `loadListForRead`. The SSE stream
// endpoints use it directly; the by-scope listing uses
// `assertScopeReadable` for the cheap upfront check and filters per
// list with `canRead` for the per-row visibility.

const LISTS_OWNED_SCOPES = new Set(['list_group'])

// Cheap upfront check on a scope_type/scope_id pair without loading a
// specific list — used by `/lists?scope=`, the scope-stream route, and
// list creation. Throws notFound on non-Lists scope, soft-deleted
// group, or non-membership.
export async function assertScopeReadable(
  c: Context<HonoApp>,
  scopeType: string,
  scopeId: string,
): Promise<void> {
  if (!LISTS_OWNED_SCOPES.has(scopeType)) throw errors.listNotFound()
  const userId = c.var.session!.userId
  // Soft-deleted groups freeze: a stale membership row on a deleted
  // list_group must not grant access. groups.findById returns the row
  // regardless of soft-delete state so we check deletedAt here.
  const group = await c.var.repos.groups.findById(scopeId)
  if (!group || group.deletedAt) throw errors.listNotFound()
  const membership = await c.var.repos.groups.findMembership(scopeId, userId)
  if (!membership) throw errors.listNotFound()
}

// Returns true iff this user can read this list (visibility-aware).
// Used by listing endpoints to filter results; raise behaviour stays at
// the route boundary.
//
// Visibility model (#128):
//   'all'     → must be an active member of the list's list_group.
//   'private' → creator always passes; otherwise must have a row in
//               list_shares for this list. A share grants access
//               WITHOUT requiring scope membership, so a list owner
//               can share across group boundaries (matches the
//               share-by-email product flow that creates an RPID
//               account on accept). The scope-ownership gate still
//               applies — events-group lists never reach the UI.
export async function canRead(c: Context<HonoApp>, list: ListRecord): Promise<boolean> {
  if (!LISTS_OWNED_SCOPES.has(list.scopeType)) return false
  const userId = c.var.session!.userId
  // A soft-deleted parent list_group freezes EVERY downstream surface —
  // private lists (owner + shares) and 'all' lists alike. Otherwise a
  // creator could keep editing/inviting against a group their org has
  // deleted. Check liveness before the visibility branch.
  const group = await c.var.repos.groups.findById(list.scopeId)
  if (!group || group.deletedAt) return false
  if (list.visibility === 'private') {
    if (list.createdBy === userId) return true
    const share = await c.var.repos.listShares.findByListAndUser(list.id, userId)
    return share !== null
  }
  if (list.visibility === 'all') {
    const membership = await c.var.repos.groups.findMembership(list.scopeId, userId)
    return membership !== null
  }
  // Any unexpected value (post-migration drift) is treated as denied.
  return false
}

// Load + authorize a single list. Throws listNotFound for any failure
// mode (missing, soft-deleted, wrong scope, non-member, visibility
// denial). Existence is never leaked.
export async function loadListForRead(
  c: Context<HonoApp>,
  listId: string,
): Promise<ListRecord> {
  const list = await c.var.repos.lists.findById(listId)
  if (!list || list.deletedAt) throw errors.listNotFound()
  if (!(await canRead(c, list))) throw errors.listNotFound()
  return list
}

// Planner-origin scopes are read-only on the Lists UI surface (#531):
// the Planner BFF owns their lifecycle via the SDK surface, and RPL-only
// features (custom statuses, kanban, recurrence views) must never be
// attached to a Planner-managed list from here. 403, not 404 — the
// caller legitimately reads the list; only mutation is denied.
export async function assertScopeMutable(
  c: Context<HonoApp>,
  scopeId: string,
): Promise<void> {
  const group = await c.var.repos.groups.findById(scopeId)
  if (group?.origin === 'planner') {
    throw errors.forbidden('This list is managed in Planner and is read-only in Lists.')
  }
}

// Load + authorize a list for an item-level mutation (create / edit /
// delete items, comments). Read access is the floor; planner-origin
// scopes are additionally denied (read-only on this surface).
export async function loadListForItemWrite(
  c: Context<HonoApp>,
  listId: string,
): Promise<ListRecord> {
  const list = await loadListForRead(c, listId)
  await assertScopeMutable(c, list.scopeId)
  return list
}

// Load + authorize a list for a structural mutation (custom-field defs,
// saved views — Lists v2). Read access is the floor (404 leaks nothing);
// on top of it only the list creator may reshape the list, so a plain
// member who can read gets a 403. Distinct from per-item edits, which any
// reader may make. As scopes grow richer roles (sidekick, etc.) this is
// the single chokepoint to widen.
export async function loadListForWrite(
  c: Context<HonoApp>,
  listId: string,
): Promise<ListRecord> {
  const list = await loadListForRead(c, listId)
  await assertScopeMutable(c, list.scopeId)
  if (list.createdBy !== c.var.session!.userId) {
    throw errors.forbidden('Only the list creator can change its fields.')
  }
  return list
}
