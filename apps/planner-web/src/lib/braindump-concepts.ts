// Pure concept normalization + cross-entry aggregation shared by the Brain
// Dump map (braindump-graph.ts) and Insights (braindump-analytics.ts). The
// per-dump LLM classifies kind (person/place/topic/theme) and casing
// inconsistently entry to entry, so both consumers merge on a normalized
// label key and vote for the display kind/casing — see buildConceptGraph and
// topThemes. No DOM. Unit-tested in braindump-concepts.test.ts.

import type { StreamEntry } from './braindump-helpers.js'

export type ConceptKind = 'theme' | 'person' | 'place' | 'topic'

// Kind precedence when votes tie (used by dominantKind).
const KIND_PRECEDENCE: readonly ConceptKind[] = ['person', 'place', 'topic', 'theme']

// Merge key only — NEVER displayed. Collapses casing, accents, punctuation,
// a leading article and simple plurals so e.g. "The Trumps'" and "trump"
// land on the same key. The punctuation strip is Unicode-aware
// (\p{L}/\p{N}) so non-Latin labels ("Москва", "東京") survive instead of
// being stripped to ''. The singularizer is deliberately conservative (last
// word only, length-gated, ASCII-only — see singularize) and can merge
// unrelated words that happen to share a plural-looking tail ("news" ->
// "new"); that's fine for a merge key since it only ever causes two
// concepts to merge, and the merged node's *displayed* label always comes
// from dominantLabel (real spellings the LLM produced), never from this
// function's output.
export function normalizeConceptLabel(label: string): string {
  let s = label
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining accents (post NFKD)
  if (s === '') return ''
  s = s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '') // strip surrounding punctuation (Unicode-aware)
  s = s.replace(/['’]s$/, '') // strip trailing possessive 's / 's
  s = s.replace(/^(the|a|an) /, '') // drop a leading article
  if (s === '') return ''

  const words = s.split(' ')
  const last = words[words.length - 1]!
  words[words.length - 1] = singularize(last)
  return words.join(' ')
}

// ASCII-only: only touches words ending in a plain a-z letter, so non-Latin
// scripts (which never match /[a-z]$/) pass through untouched rather than
// being mangled by an English-plural heuristic that doesn't apply to them.
function singularize(word: string): string {
  if (!/[a-z]$/.test(word)) return word
  if (word.length >= 5 && /ies$/.test(word)) return word.slice(0, -3) + 'y'
  if (/(xes|ches|shes|sses)$/.test(word)) return word.slice(0, -2)
  if (word.length >= 4 && /s$/.test(word) && !/(ss|us|is|as)$/.test(word)) return word.slice(0, -1)
  return word
}

// Most-voted kind; ties broken by fixed precedence (person > place > topic >
// theme) so the result never depends on vote order.
export function dominantKind(kinds: readonly ConceptKind[]): ConceptKind {
  const counts = new Map<ConceptKind, number>()
  for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1)
  let best: ConceptKind = KIND_PRECEDENCE[KIND_PRECEDENCE.length - 1]!
  let bestCount = -1
  for (const k of KIND_PRECEDENCE) {
    const count = counts.get(k) ?? 0
    if (count > bestCount) {
      bestCount = count
      best = k
    }
  }
  return best
}

// Most-frequent exact spelling; ties broken by shortest, then
// case-insensitive lexicographic, then fewest capitals ("Focus" beats
// "FOCUS"), then plain codepoint order as a final tie-break (e.g. "AbC" vs
// "ABc", same length/casefold/capital-count) — deterministic regardless of
// input order.
export function dominantLabel(labels: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1)
  let best: string | null = null
  let bestCount = -1
  for (const [label, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && labelBeats(label, best))) {
      best = label
      bestCount = count
    }
  }
  return best ?? ''
}

function labelBeats(a: string, b: string): boolean {
  if (a.length !== b.length) return a.length < b.length
  const al = a.toLowerCase()
  const bl = b.toLowerCase()
  if (al !== bl) return al < bl
  const ca = capitals(a)
  const cb = capitals(b)
  if (ca !== cb) return ca < cb
  return a < b
}

function capitals(s: string): number {
  let n = 0
  for (const ch of s) if (ch !== ch.toLowerCase()) n++
  return n
}

// Normalized-label keys worth surfacing as suggestion chips, ranked by the
// number of DISTINCT entries each appears in (not raw mention count), most
// common first then label asc, capped at `limit`.
export function knownConceptLabels(entries: readonly StreamEntry[], limit = 40): string[] {
  const entryCounts = new Map<string, number>()
  const labelsByKey = new Map<string, string[]>()

  for (const entry of entries) {
    if (!entry.analysis) continue
    // Entry-weight counts each key once per entry, but every raw spelling
    // still votes for the display label (a twice-mentioned casing should
    // win even when both mentions sit in one entry).
    const keysInEntry = new Set<string>()
    const mentions = [
      ...entry.analysis.themes,
      ...entry.analysis.entities.map((e) => e.name),
    ]
    for (const raw of mentions) {
      const key = normalizeConceptLabel(raw)
      if (key === '') continue
      keysInEntry.add(key)
      const labels = labelsByKey.get(key)
      if (labels) labels.push(raw.trim())
      else labelsByKey.set(key, [raw.trim()])
    }
    for (const key of keysInEntry) {
      entryCounts.set(key, (entryCounts.get(key) ?? 0) + 1)
    }
  }

  // Final mapping must stay in lockstep with EnrichRequestSchema.knownConcepts
  // in apps/planner-api/src/lib/braindump.ts (z.string().trim().min(1).max(40)):
  // collapse internal whitespace (a stored label can carry an embedded
  // newline) and drop anything over 40 chars — entity names allow up to 80,
  // so a long entity label would otherwise 400 every enrich call.
  // No label dedupe is needed: the merge key is a pure function of the
  // collapsed display label, so two distinct keys can never resolve to the
  // same output string.
  return [...entryCounts.entries()]
    .map(([key, count]) => ({
      key,
      label: dominantLabel(labelsByKey.get(key)!).replace(/\s+/g, ' '),
      count,
    }))
    .filter((r) => r.label.length <= 40)
    .sort(
      (a, b) =>
        b.count - a.count ||
        (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) ||
        (a.key < b.key ? -1 : 1),
    )
    .slice(0, limit)
    .map((r) => r.label)
}
