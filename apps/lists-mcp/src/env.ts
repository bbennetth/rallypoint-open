import { z } from 'zod'

// Single source of truth for the Rallypoint Lists MCP environment-variable
// contract. After PR 3 of feat/rpc-bindings the only Worker-level
// configuration is `NODE_ENV` — token resolution + every list-data
// access dispatches through the `Service<ListsRPC>` binding declared in
// wrangler.toml; LISTS_MCP_API_KEY and the `LISTS_API_URL` HTTP origin
// are gone.

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
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

let _env: Env | null = null
export function getEnv(): Env {
  _env ??= parseEnv()
  return _env
}
export function _resetEnvCacheForTests(): void {
  _env = null
}
