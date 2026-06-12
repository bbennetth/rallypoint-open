import type { Repos } from '../types.js'
import { type Db, createDb } from './db.js'
import { D1ListRepo } from './lists.js'
import { D1ListItemRepo } from './list-items.js'
import { D1FieldDefRepo } from './field-defs.js'
import { D1ListStatusRepo } from './list-statuses.js'
import { D1ListViewRepo } from './list-views.js'
import { D1GroupRepo } from './groups.js'
import { D1ListShareRepo } from './list-shares.js'
import { D1ListInviteRepo } from './list-invites.js'
import { D1ListsSessionRepo } from './sessions.js'
import { D1ListItemSeriesRepo } from './list-item-series.js'
import { D1RateLimitRepo } from './rate-limit.js'
import { D1ListItemCommentRepo } from './list-item-comments.js'
import { D1ListLabelRepo } from './list-labels.js'
import { D1McpTokenRepo } from './mcp-tokens.js'

export function buildD1Repos(db: Db): Repos {
  return {
    lists: new D1ListRepo(db),
    listItems: new D1ListItemRepo(db),
    fieldDefs: new D1FieldDefRepo(db),
    listStatuses: new D1ListStatusRepo(db),
    listViews: new D1ListViewRepo(db),
    groups: new D1GroupRepo(db),
    listShares: new D1ListShareRepo(db),
    listInvites: new D1ListInviteRepo(db),
    sessions: new D1ListsSessionRepo(db),
    series: new D1ListItemSeriesRepo(db),
    listItemComments: new D1ListItemCommentRepo(db),
    listLabels: new D1ListLabelRepo(db),
    mcpTokens: new D1McpTokenRepo(db),
    rateLimit: new D1RateLimitRepo(db),
  }
}

export { createDb }
export type { Db }
