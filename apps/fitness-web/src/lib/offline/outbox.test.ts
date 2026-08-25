import { describe, it, expect } from 'vitest'
import { buildSend, type FitnessApi } from './outbox.js'
import type { OutboxOp } from './outbox-ops.js'

// buildSend must forward each create op's stable tmpId as the server
// idempotency key (`ref`) so a create that timed out AFTER the server
// committed dedups on retry instead of duplicating the row.
function captureApi() {
  const calls: Record<string, { ref?: string }> = {}
  const api = {
    createWorkout: async (input: { ref?: string }) => {
      calls.workout = input
      return { id: 'fs_1' }
    },
    createMetric: async (input: { ref?: string }) => {
      calls.metric = input
      return { id: 'm_1' }
    },
    createExercise: async (input: { ref?: string }) => {
      calls.exercise = input
      return { id: 'ex_1' }
    },
    createWodTemplate: async (input: { ref?: string }) => {
      calls.template = input
      return { id: 'wt_1' }
    },
    createTrainingPlan: async (input: { ref?: string }) => {
      calls.plan = input
      return { trainingPlan: { id: 'tp_1' } }
    },
    addTrainingPlanItem: async (_planId: string, input: { ref?: string }) => {
      calls.planItem = input
      return { item: { id: 'ti_1' } }
    },
  } as unknown as FitnessApi
  return { api, calls }
}

describe('buildSend — ref idempotency threading', () => {
  const cases: { key: string; op: OutboxOp }[] = [
    { key: 'workout', op: { type: 'workout:create', tmpId: 'tmp_w', input: {} } as unknown as OutboxOp },
    { key: 'metric', op: { type: 'metric:create', tmpId: 'tmp_m', input: {} } as unknown as OutboxOp },
    { key: 'exercise', op: { type: 'exercise:create', tmpId: 'tmp_e', input: {} } as unknown as OutboxOp },
    { key: 'template', op: { type: 'template:create', tmpId: 'tmp_t', input: {} } as unknown as OutboxOp },
    { key: 'plan', op: { type: 'plan:create', tmpId: 'tmp_p', input: {} } as unknown as OutboxOp },
    {
      key: 'planItem',
      op: { type: 'planItem:create', tmpId: 'tmp_i', planId: 'tp_1', input: {} } as unknown as OutboxOp,
    },
  ]

  for (const { key, op } of cases) {
    it(`forwards tmpId as ref for ${key}:create`, async () => {
      const { api, calls } = captureApi()
      await buildSend(api)(op)
      expect(calls[key]?.ref).toBe((op as { tmpId: string }).tmpId)
    })
  }
})
