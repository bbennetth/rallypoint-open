import { paginationQuery, type PaginationParams } from '@rallypoint/api-kit'
import { errors } from '../errors.js'

const pageQuery = paginationQuery({ defaultLimit: 100, maxLimit: 200 })

// Opt-in pagination for the items-backed BFF routes. When the request carries a
// `limit` or `cursor` query param, the route switches to the unified paged
// shape (`{ items, next_cursor }`); otherwise it keeps its legacy whole-array
// response, so planner-web (which sends neither param) is unaffected. Returns
// null in legacy mode. Structurally typed on `c` to stay decoupled from each
// route's Hono generics.
export function parsePlannerPage(c: {
  req: { query(name: string): string | undefined }
}): PaginationParams | null {
  const rawLimit = c.req.query('limit')
  const rawCursor = c.req.query('cursor')
  if (rawLimit === undefined && rawCursor === undefined) return null
  const parsed = pageQuery.safeParse({ limit: rawLimit, cursor: rawCursor })
  if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
  return parsed.data
}
