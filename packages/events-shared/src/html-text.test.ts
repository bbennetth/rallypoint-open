import { describe, expect, it } from 'vitest'
import { htmlToText } from './html-text.js'

describe('htmlToText', () => {
  it('strips tags, keeps block boundaries as newlines', () => {
    const { text, truncated } = htmlToText(
      '<div class="artist"><h3>Mochakk</h3><p>Ocean View</p></div><div><h3>VTSS</h3></div>',
      10_000,
    )
    expect(truncated).toBe(false)
    expect(text).toBe('Mochakk\nOcean View\nVTSS')
  })

  it('drops script/style/noscript/head subtrees and comments', () => {
    const { text } = htmlToText(
      '<head><title>x</title></head><script>var lineup = ["Fake Act"];</script>' +
        '<style>.a{color:red}</style><!-- Hidden Act --><p>Ben UFO</p>',
      10_000,
    )
    expect(text).toBe('Ben UFO')
    expect(text).not.toContain('Fake Act')
    expect(text).not.toContain('Hidden Act')
  })

  it('decodes named, decimal, and hex entities', () => {
    const { text } = htmlToText('<p>Above &amp; Beyond</p><p>KAS&#58;ST</p><p>salute&#x21;</p>', 100)
    expect(text).toBe('Above & Beyond\nKAS:ST\nsalute!')
  })

  it('decodes Latin-1 accent entities case-sensitively (live-CRSSD regression)', () => {
    const { text } = htmlToText(
      '<li>S&eacute;bastien Tellier</li><li>SKEPTA M&Aacute;S TIEMPO</li><li>M&oslash;lln&auml;</li>',
      200,
    )
    expect(text).toBe('Sébastien Tellier\nSKEPTA MÁS TIEMPO\nMøllnä')
  })

  it('collapses whitespace runs and blank lines', () => {
    const { text } = htmlToText('<div>  A  </div>\n\n\n<div>\t B</div>', 100)
    expect(text).toBe('A\nB')
  })

  it('passes plain text through (whitespace-collapsed)', () => {
    const { text } = htmlToText('Mochakk\nVTSS   b2b   salute', 100)
    expect(text).toBe('Mochakk\nVTSS b2b salute')
  })

  it('truncates at maxChars and reports it', () => {
    const { text, truncated } = htmlToText('<p>abcdefghij</p>', 4)
    expect(text).toBe('abcd')
    expect(truncated).toBe(true)
  })
})
