// Benchmark argon2 parameters on the current host. Run this on
// the smallest deployment target (1 vCPU container) to confirm
// the chosen params fit comfortably under the per-request budget.
//
// Usage:
//   npm run bench:argon2
//
// Optional env overrides:
//   ARGON2_M=65536    # memoryCost (KiB)  default 65536 (64 MiB)
//   ARGON2_T=3        # timeCost          default 3
//   ARGON2_P=2        # parallelism       default 2
//   ARGON2_N=10       # samples to take   default 10

import { performance } from 'node:perf_hooks'

interface Argon2Lib {
  hash: (
    plain: string | Buffer,
    options: { memoryCost: number; timeCost: number; parallelism: number; type?: number },
  ) => Promise<string>
  verify: (hash: string, plain: string | Buffer) => Promise<boolean>
}

async function main(): Promise<void> {
  let argon2: Argon2Lib
  try {
    argon2 = (await import('@node-rs/argon2')) as unknown as Argon2Lib
  } catch {
    console.error(
      '@node-rs/argon2 not installed yet — slice 2 adds it as a dep. ' +
        'Run `npm install @node-rs/argon2 -w @rallypoint/id-api` then re-run this bench.',
    )
    process.exit(2)
  }

  const memoryCost = Number(process.env.ARGON2_M ?? 65536)
  const timeCost = Number(process.env.ARGON2_T ?? 3)
  const parallelism = Number(process.env.ARGON2_P ?? 2)
  const samples = Number(process.env.ARGON2_N ?? 10)

  console.warn(
    `argon2id bench: m=${memoryCost}KiB (${(memoryCost / 1024).toFixed(0)} MiB), t=${timeCost}, p=${parallelism}, samples=${samples}`,
  )

  const samplesMs: number[] = []
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now()
    await argon2.hash('correct horse battery staple', {
      memoryCost,
      timeCost,
      parallelism,
    })
    const dt = performance.now() - t0
    samplesMs.push(dt)
    console.warn(`  sample ${(i + 1).toString().padStart(2)}: ${dt.toFixed(1)} ms`)
  }

  samplesMs.sort((a, b) => a - b)
  const min = samplesMs[0]!
  const max = samplesMs[samplesMs.length - 1]!
  const median = samplesMs[Math.floor(samplesMs.length / 2)]!
  const mean = samplesMs.reduce((a, b) => a + b, 0) / samplesMs.length

  console.warn(
    `\n  min=${min.toFixed(1)} ms  median=${median.toFixed(1)} ms  ` +
      `mean=${mean.toFixed(1)} ms  max=${max.toFixed(1)} ms`,
  )
  console.warn(
    '\n  Target: median below 250ms on a 1 vCPU container so /signin fits in budget.\n',
  )
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
