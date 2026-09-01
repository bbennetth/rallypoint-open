import type { RateLimitCounterNamespace } from '@rallypoint/rate-limit'
import type { Repos } from '../types.js'
import { type Db, createDb } from './db.js'
import { D1LedgerRepo } from './ledgers.js'
import { D1LedgerMemberRepo } from './ledger-members.js'
import { D1LedgerGroupRepo } from './ledger-groups.js'
import { D1LedgerInviteRepo } from './ledger-invites.js'
import { D1LedgerActivityRepo } from './ledger-activity.js'
import { D1ExpenseRepo } from './expenses.js'
import { D1ExpenseCategoryRepo } from './expense-categories.js'
import { D1SettlementRepo } from './settlements.js'
import { createSessionsRepo } from './sessions.js'
import { createRateLimitRepo } from './rate-limit.js'

// `rateLimitNamespace` is optional so the existing buildD1Repos(db) call
// sites (every *.d1.test.ts) keep exercising the D1 rate-limit path
// unchanged; only production ensureDeps passes the RATE_LIMITS DO
// namespace (#881).
export function buildD1Repos(db: Db, rateLimitNamespace?: RateLimitCounterNamespace): Repos {
  return {
    ledgers: new D1LedgerRepo(db),
    ledgerMembers: new D1LedgerMemberRepo(db),
    ledgerGroups: new D1LedgerGroupRepo(db),
    ledgerInvites: new D1LedgerInviteRepo(db),
    ledgerActivity: new D1LedgerActivityRepo(db),
    expenses: new D1ExpenseRepo(db),
    expenseCategories: new D1ExpenseCategoryRepo(db),
    settlements: new D1SettlementRepo(db),
    sessions: createSessionsRepo(db),
    rateLimit: createRateLimitRepo(db, rateLimitNamespace),
  }
}

export { createDb }
export type { Db }
