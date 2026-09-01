import { describe, it, expect } from 'vitest'
import { brandMarkSvg } from './brand-svg.js'

describe('brandMarkSvg', () => {
  const svg = brandMarkSvg({ ink: '#0A0A0A', acid: '#0EA5E9', bg: '#0B1B2B' })

  it('resolves all CSS custom properties to literal hex values', () => {
    expect(svg).not.toMatch(/var\(/)
    expect(svg).not.toMatch(/currentColor/)
  })

  it('includes each passed hex value', () => {
    expect(svg).toContain('#0A0A0A')
    expect(svg).toContain('#0EA5E9')
    expect(svg).toContain('#0B1B2B')
  })

  it('is a standalone SVG document usable for off-DOM rendering', () => {
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('viewBox="0 0 512 512"')
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain('width="512"')
    expect(svg).toContain('height="512"')
  })
})
