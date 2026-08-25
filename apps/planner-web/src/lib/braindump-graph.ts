// Pure concept-map builder for the Brain Dump map view. Builds a
// co-occurrence graph from the per-entry AI analyses (themes + entities) and
// lays it out deterministically for an inline-SVG render — no graph library,
// no randomness (seeded), no DOM. Unit-tested in braindump-graph.test.ts.

import type { StreamEntry } from './braindump-helpers.js'

export interface GraphNode {
  /** `${kind}:${lowercased label}` — stable across renders. */
  id: string
  label: string
  kind: 'theme' | 'person' | 'place' | 'topic'
  /** Number of entries the concept appears in. */
  weight: number
  /** Entry keys the concept appears in (drives tap-to-filter). */
  entryKeys: string[]
}

export interface GraphEdge {
  a: string
  b: string
  /** Number of entries where both concepts co-occur. */
  weight: number
}

export interface ConceptGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export const MAX_GRAPH_NODES = 60

// Build the co-occurrence graph across the analyzed entries. Concepts are
// case-insensitive on their label (first-seen casing wins); nodes are ranked
// by weight (then label) and capped at MAX_GRAPH_NODES; edges reference only
// surviving nodes. Entries without an analysis contribute nothing.
export function buildConceptGraph(entries: readonly StreamEntry[]): ConceptGraph {
  const nodes = new Map<string, GraphNode>()
  const edgeCounts = new Map<string, number>()

  for (const entry of entries) {
    if (!entry.analysis) continue
    // Distinct concepts within one entry (a theme repeated in the analysis
    // counts once per entry).
    const ids = new Map<string, { label: string; kind: GraphNode['kind'] }>()
    for (const t of entry.analysis.themes) {
      const label = t.trim()
      if (label === '') continue
      ids.set(`theme:${label.toLowerCase()}`, { label, kind: 'theme' })
    }
    for (const e of entry.analysis.entities) {
      const label = e.name.trim()
      if (label === '') continue
      ids.set(`${e.kind}:${label.toLowerCase()}`, { label, kind: e.kind })
    }
    const idList = [...ids.keys()].sort()
    for (const id of idList) {
      const meta = ids.get(id)!
      const existing = nodes.get(id)
      if (existing) {
        existing.weight += 1
        existing.entryKeys.push(entry.key)
      } else {
        nodes.set(id, { id, label: meta.label, kind: meta.kind, weight: 1, entryKeys: [entry.key] })
      }
    }
    for (let i = 0; i < idList.length; i++) {
      for (let j = i + 1; j < idList.length; j++) {
        const key = `${idList[i]}|${idList[j]}`
        edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1)
      }
    }
  }

  const ranked = [...nodes.values()].sort(
    (a, b) => b.weight - a.weight || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
  )
  const kept = ranked.slice(0, MAX_GRAPH_NODES)
  const keptIds = new Set(kept.map((n) => n.id))

  const edges: GraphEdge[] = []
  for (const [key, weight] of edgeCounts) {
    const [a, b] = key.split('|') as [string, string]
    if (!keptIds.has(a) || !keptIds.has(b)) continue
    edges.push({ a, b, weight })
  }
  edges.sort((x, y) => y.weight - x.weight || (x.a + x.b < y.a + y.b ? -1 : 1))

  return { nodes: kept, edges }
}

export interface LaidOutNode extends GraphNode {
  x: number
  y: number
  /** Circle radius scaled by weight. */
  r: number
}

export interface LaidOutGraph {
  nodes: LaidOutNode[]
  edges: GraphEdge[]
  width: number
  height: number
}

// Deterministic seeded PRNG (mulberry32) — layout must not jitter between
// renders of the same data.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Small fixed-iteration force layout: seeded ring start, spring toward edge
// partners, pairwise repulsion, clamped into the viewport with a margin.
// Deterministic for a given (graph, width, height, seed).
export function layoutGraph(
  graph: ConceptGraph,
  width: number,
  height: number,
  seed = 1,
): LaidOutGraph {
  const n = graph.nodes.length
  if (n === 0) return { nodes: [], edges: [], width, height }

  const rand = mulberry32(seed)
  const cx = width / 2
  const cy = height / 2
  const ringR = Math.min(width, height) * 0.38
  const maxWeight = Math.max(...graph.nodes.map((d) => d.weight))

  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  const index = new Map<string, number>()
  graph.nodes.forEach((node, i) => {
    index.set(node.id, i)
    const angle = (i / n) * Math.PI * 2 + rand() * 0.5
    const jitter = 0.7 + rand() * 0.5
    xs[i] = cx + Math.cos(angle) * ringR * jitter
    ys[i] = cy + Math.sin(angle) * ringR * jitter
  })

  const ITERATIONS = 120
  const REPULSE = (width * height) / Math.max(24, n * 6)
  for (let it = 0; it < ITERATIONS; it++) {
    const cool = 1 - it / ITERATIONS
    const fx = new Float64Array(n)
    const fy = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = xs[i]! - xs[j]!
        const dy = ys[i]! - ys[j]!
        const d2 = Math.max(64, dx * dx + dy * dy)
        const f = REPULSE / d2
        const d = Math.sqrt(d2)
        fx[i]! += (dx / d) * f
        fy[i]! += (dy / d) * f
        fx[j]! -= (dx / d) * f
        fy[j]! -= (dy / d) * f
      }
    }
    for (const edge of graph.edges) {
      const i = index.get(edge.a)
      const j = index.get(edge.b)
      if (i === undefined || j === undefined) continue
      const dx = xs[j]! - xs[i]!
      const dy = ys[j]! - ys[i]!
      const d = Math.max(8, Math.sqrt(dx * dx + dy * dy))
      const pull = 0.002 * Math.min(edge.weight, 6) * d
      fx[i]! += (dx / d) * pull
      fy[i]! += (dy / d) * pull
      fx[j]! -= (dx / d) * pull
      fy[j]! -= (dy / d) * pull
    }
    // Gentle centering so disconnected nodes don't drift off.
    for (let i = 0; i < n; i++) {
      fx[i]! += (cx - xs[i]!) * 0.005
      fy[i]! += (cy - ys[i]!) * 0.005
      xs[i]! += fx[i]! * cool
      ys[i]! += fy[i]! * cool
    }
  }

  const margin = 36
  const nodes: LaidOutNode[] = graph.nodes.map((node, i) => ({
    ...node,
    x: Math.min(width - margin, Math.max(margin, xs[i]!)),
    y: Math.min(height - margin, Math.max(margin, ys[i]!)),
    r: 8 + 14 * (maxWeight > 1 ? (node.weight - 1) / (maxWeight - 1) : 0),
  }))

  return { nodes, edges: graph.edges, width, height }
}
