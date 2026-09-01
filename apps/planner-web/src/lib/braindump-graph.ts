// Pure concept-map builder for the Brain Dump map view. Builds a
// co-occurrence graph from the per-entry AI analyses (themes + entities) and
// lays it out deterministically for an inline-SVG render — no graph library,
// no randomness (seeded), no DOM. Unit-tested in braindump-graph.test.ts.

import { dominantKind, dominantLabel, normalizeConceptLabel } from './braindump-concepts.js'
import type { ConceptKind } from './braindump-concepts.js'
import type { StreamEntry } from './braindump-helpers.js'

export interface GraphNode {
  /** normalizeConceptLabel(label) — stable across renders, no kind prefix
   *  (a label merges across kinds, since the per-dump LLM classifies kind
   *  inconsistently entry to entry). */
  id: string
  label: string
  kind: ConceptKind
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

// Build the co-occurrence graph across the analyzed entries. Concepts merge
// on normalizeConceptLabel(label) alone — NOT kind — since the per-dump LLM
// classifies kind inconsistently entry to entry (the same label can show up
// as a person in one entry and a topic in another). Each node accumulates
// every spelling and every kind vote seen across entries; the displayed
// label/kind are resolved once at the end via dominantLabel/dominantKind so
// the result never depends on entry iteration order. Nodes are ranked by
// weight (then label) and capped at MAX_GRAPH_NODES; edges reference only
// surviving nodes. Entries without an analysis, or concepts that normalize
// to '', contribute nothing.
export function buildConceptGraph(entries: readonly StreamEntry[]): ConceptGraph {
  const acc = new Map<
    string,
    { labels: string[]; kinds: GraphNode['kind'][]; weight: number; entryKeys: string[] }
  >()
  // Keyed by the pair of node ids directly (nested map) rather than a
  // joined string — normalizeConceptLabel keys can contain arbitrary
  // characters, including '|' or a literal space, so no delimiter is safe
  // to join+split on.
  const edgeCounts = new Map<string, Map<string, number>>()

  for (const entry of entries) {
    if (!entry.analysis) continue
    // Distinct concepts within one entry (a theme repeated in the analysis
    // counts once per entry, one kind vote per entry).
    const seen = new Map<string, { label: string; kind: GraphNode['kind'] }>()
    for (const t of entry.analysis.themes) {
      const label = t.trim()
      if (label === '') continue
      const key = normalizeConceptLabel(label)
      if (key === '') continue
      seen.set(key, { label, kind: 'theme' })
    }
    for (const e of entry.analysis.entities) {
      const label = e.name.trim()
      if (label === '') continue
      const key = normalizeConceptLabel(label)
      if (key === '') continue
      seen.set(key, { label, kind: e.kind })
    }
    const keyList = [...seen.keys()].sort()
    for (const key of keyList) {
      const meta = seen.get(key)!
      const existing = acc.get(key)
      if (existing) {
        existing.labels.push(meta.label)
        existing.kinds.push(meta.kind)
        existing.weight += 1
        existing.entryKeys.push(entry.key)
      } else {
        acc.set(key, {
          labels: [meta.label],
          kinds: [meta.kind],
          weight: 1,
          entryKeys: [entry.key],
        })
      }
    }
    for (let i = 0; i < keyList.length; i++) {
      for (let j = i + 1; j < keyList.length; j++) {
        const a = keyList[i]!
        const b = keyList[j]!
        let inner = edgeCounts.get(a)
        if (!inner) {
          inner = new Map()
          edgeCounts.set(a, inner)
        }
        inner.set(b, (inner.get(b) ?? 0) + 1)
      }
    }
  }

  const nodes = new Map<string, GraphNode>()
  for (const [id, v] of acc) {
    nodes.set(id, {
      id,
      label: dominantLabel(v.labels),
      kind: dominantKind(v.kinds),
      weight: v.weight,
      entryKeys: v.entryKeys,
    })
  }

  const ranked = [...nodes.values()].sort(
    (a, b) =>
      b.weight - a.weight ||
      (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  const kept = ranked.slice(0, MAX_GRAPH_NODES)
  const keptIds = new Set(kept.map((n) => n.id))

  const edges: GraphEdge[] = []
  for (const [a, inner] of edgeCounts) {
    if (!keptIds.has(a)) continue
    for (const [b, weight] of inner) {
      if (!keptIds.has(b)) continue
      edges.push({ a, b, weight })
    }
  }
  edges.sort(
    (x, y) =>
      y.weight - x.weight ||
      (x.a < y.a ? -1 : x.a > y.a ? 1 : 0) ||
      (x.b < y.b ? -1 : x.b > y.b ? 1 : 0),
  )

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
