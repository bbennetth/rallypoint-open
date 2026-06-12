import { describe, it, expect } from 'vitest'
import { buildItemTree, flattenVisible, progressPercent, type TreeItem } from './hierarchy-view.js'

function node(id: string, parent_id: string | null): TreeItem {
  return { id, parent_id }
}

describe('buildItemTree', () => {
  it('nests children under their parent, preserving input order', () => {
    const tree = buildItemTree([node('a', null), node('a1', 'a'), node('a2', 'a'), node('b', null)])
    expect(tree.map((n) => n.item.id)).toEqual(['a', 'b'])
    expect(tree[0]!.children.map((n) => n.item.id)).toEqual(['a1', 'a2'])
    expect(tree[0]!.depth).toBe(0)
    expect(tree[0]!.children[0]!.depth).toBe(1)
  })

  it('nests recursively with increasing depth', () => {
    const tree = buildItemTree([node('a', null), node('a1', 'a'), node('a1x', 'a1')])
    expect(tree[0]!.children[0]!.children[0]!.item.id).toBe('a1x')
    expect(tree[0]!.children[0]!.children[0]!.depth).toBe(2)
  })

  it('promotes an orphan (parent not in the set) to a root so it is never hidden', () => {
    const tree = buildItemTree([node('child', 'gone')])
    expect(tree.map((n) => n.item.id)).toEqual(['child'])
    expect(tree[0]!.depth).toBe(0)
  })

  it('does not loop on a corrupt stored cycle', () => {
    const tree = buildItemTree([node('x', 'y'), node('y', 'x')])
    // Both reference each other; neither parent is "null" but the cycle guard
    // keeps the build finite. Every node still appears exactly once.
    const ids = new Set<string>()
    function collect(nodes: ReturnType<typeof buildItemTree>) {
      for (const n of nodes) {
        ids.add(n.item.id)
        collect(n.children)
      }
    }
    collect(tree)
    expect(ids).toEqual(new Set(['x', 'y']))
  })
})

describe('flattenVisible', () => {
  const tree = buildItemTree([node('a', null), node('a1', 'a'), node('a2', 'a'), node('b', null)])

  it('flattens depth-first in order with hasChildren flags', () => {
    const rows = flattenVisible(tree, new Set())
    expect(rows.map((r) => r.item.id)).toEqual(['a', 'a1', 'a2', 'b'])
    expect(rows[0]).toMatchObject({ depth: 0, hasChildren: true })
    expect(rows[1]).toMatchObject({ depth: 1, hasChildren: false })
  })

  it('hides the children of a collapsed node', () => {
    const rows = flattenVisible(tree, new Set(['a']))
    expect(rows.map((r) => r.item.id)).toEqual(['a', 'b'])
  })
})

describe('progressPercent', () => {
  it('is 0 when there are no children', () => {
    expect(progressPercent(0, 0)).toBe(0)
  })

  it('rounds to a whole percent', () => {
    expect(progressPercent(1, 3)).toBe(33)
    expect(progressPercent(2, 3)).toBe(67)
    expect(progressPercent(3, 3)).toBe(100)
  })

  it('clamps out-of-range inputs', () => {
    expect(progressPercent(5, 3)).toBe(100)
    expect(progressPercent(-1, 3)).toBe(0)
  })
})
