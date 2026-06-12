import { describe, it, expect } from 'vitest'
import { resolveLabels, toggleLabelId } from './labels.js'
import type { LabelDto } from './api.js'

function label(id: string, position: number): LabelDto {
  return {
    id,
    list_id: 'lst_1',
    name: id,
    color: null,
    position,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

const LABELS = [label('bug', 0), label('feat', 1), label('urgent', 2)]

describe('resolveLabels', () => {
  it('returns the attached labels in list order', () => {
    expect(resolveLabels(['urgent', 'bug'], LABELS).map((l) => l.id)).toEqual(['bug', 'urgent'])
  })

  it('drops ids that no longer resolve', () => {
    expect(resolveLabels(['bug', 'gone'], LABELS).map((l) => l.id)).toEqual(['bug'])
  })

  it('is empty for an item with no labels', () => {
    expect(resolveLabels([], LABELS)).toEqual([])
  })
})

describe('toggleLabelId', () => {
  it('adds an absent id', () => {
    expect(toggleLabelId(['bug'], 'feat')).toEqual(['bug', 'feat'])
  })

  it('removes a present id', () => {
    expect(toggleLabelId(['bug', 'feat'], 'bug')).toEqual(['feat'])
  })

  it('does not mutate the input', () => {
    const input = ['bug']
    toggleLabelId(input, 'feat')
    expect(input).toEqual(['bug'])
  })
})
