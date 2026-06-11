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
import { D1MoneySessionRepo } from './sessions.js'
import { D1RateLimitRepo } from './rate-limit.js'

export function buildD1Repos(db: Db): Repos {
  return {
    ledgers: new D1LedgerRepo(db),
    ledgerMembers: new D1LedgerMemberRepo(db),
    ledgerGroups: new D1LedgerGroupRepo(db),
    ledgerInvites: new D1LedgerInviteRepo(db),
    ledgerActivity: new D1LedgerActivityRepo(db),
    expenses: new D1ExpenseRepo(db),
    expenseCategories: new D1ExpenseCategoryRepo(db),
    settlements: new D1SettlementRepo(db),
    sessions: new D1MoneySessionRepo(db),
    rateLimit: new D1RateLimitRepo(db),
  }
}

export { createDb }
export type { Db }
