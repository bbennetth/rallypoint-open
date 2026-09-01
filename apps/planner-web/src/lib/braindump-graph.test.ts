import { describe, expect, it } from 'vitest'
import { MAX_GRAPH_NODES, buildConceptGraph, layoutGraph } from './braindump-graph.js'
import type { AiAnalysis, StreamEntry } from './braindump-helpers.js'

function analysis(over: Partial<AiAnalysis> = {}): AiAnalysis {
  return { v: 1, themes: [], entities: [], summary: null, model: 'claude-x', ...over }
}

function entry(over: Partial<StreamEntry> & { key: string }): StreamEntry {
  return {
    id: over.key,
    source: 'braindump',
    listId: null,
    title: 't',
    body: null,
    day: '',
    timed: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    category: null,
    analysis: null,
    raw: null,
    ...over,
  }
}

describe('buildConceptGraph', () => {
  it('builds node weights and co-occurrence edge weights', () => {
    const e1 = entry({ key: 'e1', analysis: analysis({ themes: ['Focus', 'Rest'] }) })
    const e2 = entry({ key: 'e2', analysis: analysis({ themes: ['Focus'] }) })
    const graph = buildConceptGraph([e1, e2])
    const focus = graph.nodes.find((n) => n.label === 'Focus')
    const rest = graph.nodes.find((n) => n.label === 'Rest')
    expect(focus?.weight).toBe(2)
    expect(rest?.weight).toBe(1)
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]?.weight).toBe(1)
  })

  it('dedupes case-insensitively and displays the dominant casing', () => {
    const e1 = entry({ key: 'e1', analysis: analysis({ themes: ['Focus'] }) })
    const e2 = entry({ key: 'e2', analysis: analysis({ themes: ['FOCUS'] }) })
    const graph = buildConceptGraph([e1, e2])
    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]?.label).toBe('Focus')
    expect(graph.nodes[0]?.weight).toBe(2)
  })

  it('counts a repeated concept within one entry only once', () => {
    const e1 = entry({ key: 'e1', analysis: analysis({ themes: ['Focus', 'focus', 'FOCUS'] }) })
    const graph = buildConceptGraph([e1])
    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]?.weight).toBe(1)
  })

  it('tracks entryKeys per node', () => {
    const e1 = entry({ key: 'e1', analysis: analysis({ themes: ['Focus'] }) })
    const e2 = entry({ key: 'e2', analysis: analysis({ themes: ['Focus'] }) })
    const graph = buildConceptGraph([e1, e2])
    expect(graph.nodes[0]?.entryKeys).toEqual(['e1', 'e2'])
  })

  it('ignores entries without an analysis', () => {
    const withAnalysis = entry({ key: 'e1', analysis: analysis({ themes: ['Focus'] }) })
    const without = entry({ key: 'e2', analysis: null })
    const graph = buildConceptGraph([withAnalysis, without])
    expect(graph.nodes).toHaveLength(1)
  })

  it('produces a node for a non-Latin theme instead of dropping it', () => {
    const e1 = entry({ key: 'e1', analysis: analysis({ themes: ['東京'] }) })
    const graph = buildConceptGraph([e1])
    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]?.label).toBe('東京')
  })

  it('merges the same name across kinds into one node (id has no kind prefix)', () => {
    // The per-dump LLM classifies inconsistently: "Trump" tagged person in
    // one entry, topic in another, must render as ONE node, not two.
    const e1 = entry({
      key: 'e1',
      analysis: analysis({ entities: [{ name: 'Trump', kind: 'person' }] }),
    })
    const e2 = entry({
      key: 'e2',
      analysis: analysis({ entities: [{ name: 'Trump', kind: 'topic' }] }),
    })
    const graph = buildConceptGraph([e1, e2])
    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]?.id).toBe('trump')
    expect(graph.nodes[0]?.weight).toBe(2)
    expect(graph.nodes[0]?.entryKeys).toEqual(['e1', 'e2'])
    // Vote tie broken by precedence: person > topic.
    expect(graph.nodes[0]?.kind).toBe('person')
  })

  it('merges a theme with an entity of the same normalized label', () => {
    const e1 = entry({ key: 'e1', analysis: analysis({ themes: ['Skin'] }) })
    const e2 = entry({
      key: 'e2',
      analysis: analysis({ entities: [{ name: 'skins', kind: 'topic' }] }),
    })
    const graph = buildConceptGraph([e1, e2])
    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]?.weight).toBe(2)
  })

  it('caps nodes at MAX_GRAPH_NODES, keeping the highest-weight nodes', () => {
    // Build MAX_GRAPH_NODES + 5 distinct low-weight themes across separate
    // entries, then one heavy theme appearing in every entry so it always
    // survives the cap.
    const entries: StreamEntry[] = []
    const total = MAX_GRAPH_NODES + 5
    for (let i = 0; i < total; i++) {
      entries.push(
        entry({
          key: `e${i}`,
          analysis: analysis({ themes: [`theme-${i}`, 'heavy'] }),
        }),
      )
    }
    const graph = buildConceptGraph(entries)
    expect(graph.nodes).toHaveLength(MAX_GRAPH_NODES)
    const heavy = graph.nodes.find((n) => n.label === 'heavy')
    expect(heavy).toBeDefined()
    expect(heavy?.weight).toBe(total)
  })

  it('only includes edges between surviving nodes', () => {
    const entries: StreamEntry[] = []
    const total = MAX_GRAPH_NODES + 5
    for (let i = 0; i < total; i++) {
      entries.push(
        entry({
          key: `e${i}`,
          analysis: analysis({ themes: [`theme-${i}`, 'heavy'] }),
        }),
      )
    }
    const graph = buildConceptGraph(entries)
    const keptIds = new Set(graph.nodes.map((n) => n.id))
    for (const edge of graph.edges) {
      expect(keptIds.has(edge.a)).toBe(true)
      expect(keptIds.has(edge.b)).toBe(true)
    }
  })

  it('handles a normalized label containing "|" without corrupting edges', () => {
    const e1 = entry({
      key: 'e1',
      analysis: analysis({ themes: ['cost|benefit', 'Rest'] }),
    })
    const graph = buildConceptGraph([e1])
    const pipe = graph.nodes.find((n) => n.label === 'cost|benefit')
    const rest = graph.nodes.find((n) => n.label === 'Rest')
    expect(pipe).toBeDefined()
    expect(rest).toBeDefined()
    expect(graph.edges).toHaveLength(1)
    expect(new Set([graph.edges[0]?.a, graph.edges[0]?.b])).toEqual(
      new Set([pipe!.id, rest!.id]),
    )
  })

  it('returns an empty graph for an empty stream', () => {
    const graph = buildConceptGraph([])
    expect(graph.nodes).toEqual([])
    expect(graph.edges).toEqual([])
  })

  it('orders equal-weight edges deterministically by a then b', () => {
    // 'ab'+'c' vs 'a'+'bc' would collide under naive key concatenation —
    // the comparator must treat a and b as separate terms.
    const e1 = entry({ key: 'e1', analysis: analysis({ themes: ['ab', 'c'] }) })
    const e2 = entry({ key: 'e2', analysis: analysis({ themes: ['a', 'bc'] }) })
    const graph = buildConceptGraph([e1, e2])
    expect(graph.edges.map((e) => [e.a, e.b])).toEqual([
      ['a', 'bc'],
      ['ab', 'c'],
    ])
  })
})

describe('layoutGraph', () => {
  it('is deterministic for the same input and seed', () => {
    const e1 = entry({ key: 'e1', analysis: analysis({ themes: ['Focus', 'Rest'] }) })
    const e2 = entry({ key: 'e2', analysis: analysis({ themes: ['Focus'] }) })
    const graph = buildConceptGraph([e1, e2])
    const layout1 = layoutGraph(graph, 800, 600, 7)
    const layout2 = layoutGraph(graph, 800, 600, 7)
    expect(layout1).toEqual(layout2)
  })

  it('produces different layouts for different seeds', () => {
    const e1 = entry({ key: 'e1', analysis: analysis({ themes: ['Focus', 'Rest', 'Work'] }) })
    const graph = buildConceptGraph([e1])
    const layout1 = layoutGraph(graph, 800, 600, 1)
    const layout2 = layoutGraph(graph, 800, 600, 2)
    expect(layout1.nodes).not.toEqual(layout2.nodes)
  })

  it('clamps node positions within the margin bounds', () => {
    const entries: StreamEntry[] = []
    for (let i = 0; i < 20; i++) {
      entries.push(entry({ key: `e${i}`, analysis: analysis({ themes: [`theme-${i}`, 'hub'] }) }))
    }
    const graph = buildConceptGraph(entries)
    const width = 400
    const height = 300
    const layout = layoutGraph(graph, width, height, 3)
    const margin = 36
    for (const n of layout.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(margin)
      expect(n.x).toBeLessThanOrEqual(width - margin)
      expect(n.y).toBeGreaterThanOrEqual(margin)
      expect(n.y).toBeLessThanOrEqual(height - margin)
    }
  })

  it('returns an empty layout for an empty graph', () => {
    const layout = layoutGraph({ nodes: [], edges: [] }, 800, 600)
    expect(layout).toEqual({ nodes: [], edges: [], width: 800, height: 600 })
  })

  it('scales radius with weight (heavier nodes get a larger radius)', () => {
    const e1 = entry({ key: 'e1', analysis: analysis({ themes: ['Common'] }) })
    const e2 = entry({ key: 'e2', analysis: analysis({ themes: ['Common', 'Rare'] }) })
    const e3 = entry({ key: 'e3', analysis: analysis({ themes: ['Common'] }) })
    const graph = buildConceptGraph([e1, e2, e3])
    const layout = layoutGraph(graph, 800, 600, 5)
    const common = layout.nodes.find((n) => n.label === 'Common')!
    const rare = layout.nodes.find((n) => n.label === 'Rare')!
    expect(common.weight).toBe(3)
    expect(rare.weight).toBe(1)
    expect(common.r).toBeGreaterThan(rare.r)
  })
})
