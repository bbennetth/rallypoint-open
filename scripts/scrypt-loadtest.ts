// scripts/scrypt-loadtest.ts — operator-run scrypt concurrency load test (#469).
//
// Drives ramping concurrency of real `POST /api/v1/ui/signin/start` requests
// against a TARGET the operator passes, to measure headroom of the scrypt KDF
// (~32 MiB resident per hash) against the Cloudflare 128 MB per-isolate limit
// (shared across concurrent requests — see docs/design/cf-spikes/argon2-worker.md
// and scrypt-concurrency-loadtest.md). `wrangler dev` does NOT enforce the
// limit, so only a deployed Worker (QA) is meaningful.
//
// This file is INERT on import — nothing runs until the CLI main() is invoked
// explicitly by the operator. It refuses prod hosts and requires `--yes`.
//
// Usage (operator only, against QA):
//   tsx scripts/scrypt-loadtest.ts --target https://id.rallypt.dev --yes
//   tsx scripts/scrypt-loadtest.ts --target https://id.rallypt.dev --yes \
//       --start 2 --max 8 --step 2 --per-level 24 --endpoint /api/v1/ui/signin/start
//
// Notes:
//   • signin/start runs scrypt even for unknown emails (dummyVerify equalizes
//     timing), so no real account is needed — but the per-IP rate limit
//     (10/10min on signin/start) throttles a single source. To truly stress
//     isolate concurrency, run from many IPs or temporarily raise the QA
//     bucket; otherwise expect 429s past ~10 requests (the harness reports
//     them separately so they don't masquerade as failures).
//   • Watch the Cloudflare dashboard for isolate restarts / 1102 (exceeded
//     resources) / elevated 5xx during the burst — that is the OOM signal a
//     latency number alone won't show.

import { fileURLToPath } from 'node:url'

export interface Sample {
  ms: number
  status: number
  // 'network' when the request threw before any HTTP status (timeout/refused).
  kind: StatusClass
}

export type StatusClass = '2xx' | '4xx-rate-limit' | '4xx' | '5xx' | 'network'

export interface LevelSummary {
  concurrency: number
  count: number
  ok2xx: number
  rateLimited: number
  client4xx: number
  server5xx: number
  network: number
  p50: number
  p95: number
  p99: number
}

const PROD_HOST_SUFFIX = '.rallypt.app'

// Refuse to point the load test at production. Allows QA (`*.rallypt.dev`),
// localhost, and 127.0.0.1; everything else must be an explicit opt-in host
// that is NOT the prod apex/subdomain. Throws with a clear message otherwise.
export function assertSafeTarget(target: string): URL {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    throw new Error(`--target must be an absolute http(s) URL, got: ${target}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`--target must be http(s), got protocol: ${url.protocol}`)
  }
  const host = url.hostname.toLowerCase()
  if (host === PROD_HOST_SUFFIX.slice(1) || host.endsWith(PROD_HOST_SUFFIX)) {
    throw new Error(
      `Refusing to load-test a production host (${host}). This is a QA-only tool; ` +
        `point it at id.rallypt.dev or a local stack.`,
    )
  }
  return url
}

// Classify an HTTP status into the buckets the summary tracks. 429 is split
// out from other 4xx because under a per-IP rate limit it is expected noise,
// not a headroom failure.
export function classifyStatus(status: number): StatusClass {
  if (status === 429) return '4xx-rate-limit'
  if (status >= 200 && status < 300) return '2xx'
  if (status >= 400 && status < 500) return '4xx'
  if (status >= 500) return '5xx'
  return '4xx' // 1xx/3xx unexpected here; treat as a non-success client issue
}

// The concurrency levels to ramp through, inclusive of `max` when it lands on
// a step boundary, otherwise capped at `max`. e.g. (2, 8, 2) → [2,4,6,8].
export function rampLevels(start: number, max: number, step: number): number[] {
  if (start < 1 || max < start || step < 1) {
    throw new Error(`invalid ramp: start=${start} max=${max} step=${step}`)
  }
  const levels: number[] = []
  for (let c = start; c < max; c += step) levels.push(c)
  levels.push(max)
  return levels
}

// Nearest-rank percentile over latency samples (ms). Returns 0 for an empty
// set. p is in [0,100].
export function percentile(samplesMs: number[], p: number): number {
  if (samplesMs.length === 0) return 0
  const sorted = [...samplesMs].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1))
  return sorted[idx]!
}

// Roll a batch of samples (all taken at one concurrency level) into a summary.
export function summarizeLevel(concurrency: number, samples: Sample[]): LevelSummary {
  const latencies = samples.map((s) => s.ms)
  const tally = (k: StatusClass) => samples.filter((s) => s.kind === k).length
  return {
    concurrency,
    count: samples.length,
    ok2xx: tally('2xx'),
    rateLimited: tally('4xx-rate-limit'),
    client4xx: tally('4xx'),
    server5xx: tally('5xx'),
    network: tally('network'),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
  }
}

// A 5xx or network error during the burst is the headroom red flag (an
// OOM-evicted isolate manifests as 500s/dropped connections exactly during a
// signup/signin burst). 429s and benign 4xx (invalid creds) are NOT failures.
export function isHeadroomFailure(s: LevelSummary): boolean {
  return s.server5xx > 0 || s.network > 0
}

// ---- CLI (operator-invoked only; nothing below runs on import) ----

interface CliArgs {
  target: string
  endpoint: string
  start: number
  max: number
  step: number
  perLevel: number
  yes: boolean
}

export function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const num = (flag: string, def: number): number => {
    const v = get(flag)
    if (v === undefined) return def
    const n = Number(v)
    // Catch `--per-level --max` (value is the next flag → NaN) and `--max abc`
    // so a typo can't silently collapse the ramp to zero requests.
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(`${flag} expects a positive number, got: ${v}`)
    }
    return n
  }
  return {
    target: get('--target') ?? '',
    endpoint: get('--endpoint') ?? '/api/v1/ui/signin/start',
    start: num('--start', 2),
    max: num('--max', 8),
    step: num('--step', 2),
    perLevel: num('--per-level', 24),
    yes: argv.includes('--yes'),
  }
}

// Fire `n` requests at the endpoint with at most `concurrency` in flight.
async function runLevel(
  base: URL,
  endpoint: string,
  concurrency: number,
  n: number,
): Promise<Sample[]> {
  const samples: Sample[] = []
  let dispatched = 0
  const fireOne = async (): Promise<void> => {
    // A unique unknown email each time → exercises the scrypt dummyVerify path
    // without touching a real account.
    const email = `loadtest+${Date.now()}_${Math.random().toString(36).slice(2)}@example.invalid`
    const url = new URL(endpoint, base)
    const t0 = performance.now()
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'load-test-not-a-real-password' }),
      })
      // Drain the body so the connection can be reused/closed.
      await res.text().catch(() => undefined)
      const ms = performance.now() - t0
      samples.push({ ms, status: res.status, kind: classifyStatus(res.status) })
    } catch {
      const ms = performance.now() - t0
      samples.push({ ms, status: 0, kind: 'network' })
    }
  }
  const worker = async (): Promise<void> => {
    while (dispatched < n) {
      dispatched += 1
      await fireOne()
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, n) }, () => worker()))
  return samples
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.target) {
    console.error('error: --target <url> is required (a QA host, e.g. https://id.rallypt.dev)')
    process.exit(2)
  }
  const base = assertSafeTarget(args.target)
  if (!args.yes) {
    console.error(
      'refusing to run without --yes. This sends real signin traffic to ' +
        `${base.origin} and must be explicitly authorized for that QA environment.`,
    )
    process.exit(2)
  }
  const levels = rampLevels(args.start, args.max, args.step)
  console.warn(
    `scrypt load test → ${base.origin}${args.endpoint}\n` +
      `ramp: concurrency ${levels.join(', ')} × ${args.perLevel} requests each\n` +
      'WATCH the Cloudflare dashboard for isolate restarts / 1102 / 5xx during the burst.\n',
  )
  for (const c of levels) {
    const samples = await runLevel(base, args.endpoint, c, args.perLevel)
    const s = summarizeLevel(c, samples)
    console.warn(
      `c=${String(s.concurrency).padStart(2)}  ` +
        `2xx=${s.ok2xx} 429=${s.rateLimited} 4xx=${s.client4xx} 5xx=${s.server5xx} net=${s.network}  ` +
        `p50=${s.p50.toFixed(0)}ms p95=${s.p95.toFixed(0)}ms p99=${s.p99.toFixed(0)}ms  ` +
        `${isHeadroomFailure(s) ? '⚠ HEADROOM FAILURE (5xx/network during burst)' : 'ok'}`,
    )
  }
  console.warn(
    '\nInterpretation: any 5xx/network during the burst (not 429) is the OOM signal. ' +
      'If headroom is thin, see docs/design/cf-spikes/scrypt-concurrency-loadtest.md ' +
      'for the mitigation ladder (tighten buckets / lower N via key_version).',
  )
}

// Only run when executed directly (`tsx scripts/scrypt-loadtest.ts ...`), never
// on import — so the unit tests can import the pure helpers without side effects.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main()
}
