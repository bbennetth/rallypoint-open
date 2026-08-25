import type { Service } from '@cloudflare/workers-types'
import type { FitnessRPC } from '@rallypoint/fitness-api'
import type { FitnessClient } from '@rallypoint/fitness-client'

// planner-api → fitness-api `Service<FitnessRPC>` proxy. Implements the
// existing `FitnessClient` interface (preserves the my-day call site)
// but dispatches to the binding's RPC method — no FITNESS_API_URL, no
// PLANNER_API_KEY bearer. Errors propagate as-is: the only consumer
// (My Day's "today's training" fold-in) wraps the call in bestEffort(),
// so a fitness outage degrades to an empty training list.

export function createFitnessClientFromBinding(binding: Service<FitnessRPC>): FitnessClient {
  return {
    async listWorkouts(opts) {
      return binding.listWorkouts(opts.actor, {
        ...(opts.from !== undefined ? { from: opts.from } : {}),
        ...(opts.to !== undefined ? { to: opts.to } : {}),
      })
    },
    // Food-diary write + Undo behind the AI Assist `food` category. The
    // consumer (routes/fitness-food.ts) pre-validates the entry, so an
    // error here is an outage, not bad input — it maps to a 503.
    async createFoodLogEntry(opts) {
      return binding.createFoodLogEntry(opts.actor, opts.entry)
    },
    async deleteFoodLogEntry(opts) {
      return binding.deleteFoodLogEntry(opts.actor, opts.id)
    },
  }
}
