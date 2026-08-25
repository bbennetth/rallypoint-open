import { describe, expect, it } from 'vitest'
import { aiGatewayOptions } from './ai-options.js'

describe('aiGatewayOptions', () => {
  it('returns the gateway block for a non-empty id', () => {
    expect(aiGatewayOptions('rallypoint-ai')).toEqual({ gateway: { id: 'rallypoint-ai' } })
  })

  it('returns undefined when no id is configured', () => {
    expect(aiGatewayOptions(undefined)).toBeUndefined()
  })

  it('treats blank / whitespace-only ids as unconfigured', () => {
    expect(aiGatewayOptions('')).toBeUndefined()
    expect(aiGatewayOptions('   ')).toBeUndefined()
  })

  it('trims surrounding whitespace off a real id', () => {
    expect(aiGatewayOptions('  rallypoint-ai  ')).toEqual({ gateway: { id: 'rallypoint-ai' } })
  })
})
