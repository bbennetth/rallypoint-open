import { z } from 'zod'

// Single source of truth for the Rallypoint Lists MCP environment-variable
// contract. LISTS_MCP_API_KEY is the bearer this Worker presents to lists-api
// for both token resolution and SDK calls. Must match lists-api's MCP_API_KEY.

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Base origin of lists-api (e.g. https://lists.rallypt.app). Used for both
  // /api/v1/sdk/mcp/resolve-token and the ListsClient SDK calls.
  LISTS_API_URL: z.string().url().default('http://localhost:8082'),

  // Bearer key this Worker presents to lists-api. Must be ≥32 chars and
  // match the value lists-api parses as MCP_API_KEY. Required in production;
  // dev gets the same fixed stand-in as lists-api's DEV_MCP_API_KEY.
  LISTS_MCP_API_KEY: z.string().min(32).optional(),
})

type ParsedEnv = z.infer<typeof EnvSchema>

export type Env = Omit<ParsedEnv, 'LISTS_MCP_API_KEY'> & {
  LISTS_MCP_API_KEY: string
}

// Must match DEV_MCP_API_KEY in apps/lists-api/src/env.ts so the local dev
// stack resolves tokens without additional configuration.
const DEV_MCP_API_KEY = 'dev-mcp-api-key-do-not-use-in-production-32+chars-x'

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }
  const parsed = result.data
  const isProd = parsed.NODE_ENV === 'production'

  const mcpApiKey = parsed.LISTS_MCP_API_KEY ?? (isProd ? undefined : DEV_MCP_API_KEY)
  if (!mcpApiKey) {
    throw new Error(
      'Invalid environment configuration:\n  LISTS_MCP_API_KEY: required in production',
    )
  }

  return { ...parsed, LISTS_MCP_API_KEY: mcpApiKey }
}

let _env: Env | null = null
export function getEnv(): Env {
  _env ??= parseEnv()
  return _env
}
export function _resetEnvCacheForTests(): void {
  _env = null
}
