import { z } from 'zod'

// Environment contract for ai-api — the AI trace-corpus owner. Much
// leaner than the BFFs: no sessions, no cookies, no UI origin. The D1
// database (env.DB), R2 bucket (env.AI_STORE) and the RPID service
// binding are Worker bindings, not env vars.

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Trace rows older than this are drained to a JSONL export in R2
  // (exports/{yyyy-mm}/...) and deleted from D1 by the daily cron. R2 is
  // the unlimited-retention archive; D1 holds the hot window.
  RETENTION_DAYS: z.coerce.number().int().min(30).default(365),

  // PostHog server-side error tracking (public phc_ write key, plaintext
  // var). Unset → capture no-ops.
  POSTHOG_KEY: z.string().min(1).optional(),
  POSTHOG_HOST: z.string().url().optional(),
  // Deploy target (qa/prod) — becomes the OTel
  // `deployment.environment` resource attribute on forwarded logs.
  // QA and prod share one PostHog project, so without it their logs
  // are indistinguishable. Unset locally.
  DEPLOY_ENV: z.enum(['qa', 'prod']).optional(),
})

export type Env = z.infer<typeof EnvSchema>

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }
  return result.data
}
