// Convert fetched festival-page HTML into plain text suitable as an AI
// extraction input. Regex-based on purpose: Workers have no DOM parser,
// the output only feeds a model prompt (never rendered), and lossy
// whitespace handling is fine. Block-level tags become newlines so
// artist grids don't collapse into one run-on line.

const BLOCK_TAG_RE =
  /<\/?(?:p|div|section|article|header|footer|main|nav|aside|ul|ol|li|table|thead|tbody|tr|th|td|h[1-6]|br|hr|figure|figcaption|blockquote)\b[^>]*>/gi

// Structural + punctuation entities, plus the full Latin-1 accent set —
// artist names are full of them (S&eacute;bastien Tellier, SKEPTA
// M&Aacute;S TIEMPO leaked through as raw entities on the first live
// CRSSD ingestion). Entity names are case-sensitive per the HTML spec
// (eacute=é vs Eacute=É), so the lookup below must NOT lowercase.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  // Latin-1 accents (HTML 4 named set), lowercase + uppercase.
  aacute: 'á', Aacute: 'Á',
  agrave: 'à', Agrave: 'À',
  acirc: 'â', Acirc: 'Â',
  atilde: 'ã', Atilde: 'Ã',
  auml: 'ä', Auml: 'Ä',
  aring: 'å', Aring: 'Å',
  aelig: 'æ', AElig: 'Æ',
  ccedil: 'ç', Ccedil: 'Ç',
  eacute: 'é', Eacute: 'É',
  egrave: 'è', Egrave: 'È',
  ecirc: 'ê', Ecirc: 'Ê',
  euml: 'ë', Euml: 'Ë',
  iacute: 'í', Iacute: 'Í',
  igrave: 'ì', Igrave: 'Ì',
  icirc: 'î', Icirc: 'Î',
  iuml: 'ï', Iuml: 'Ï',
  ntilde: 'ñ', Ntilde: 'Ñ',
  oacute: 'ó', Oacute: 'Ó',
  ograve: 'ò', Ograve: 'Ò',
  ocirc: 'ô', Ocirc: 'Ô',
  otilde: 'õ', Otilde: 'Õ',
  ouml: 'ö', Ouml: 'Ö',
  oslash: 'ø', Oslash: 'Ø',
  uacute: 'ú', Uacute: 'Ú',
  ugrave: 'ù', Ugrave: 'Ù',
  ucirc: 'û', Ucirc: 'Û',
  uuml: 'ü', Uuml: 'Ü',
  yacute: 'ý', Yacute: 'Ý',
  yuml: 'ÿ',
  szlig: 'ß',
  eth: 'ð', ETH: 'Ð',
  thorn: 'þ', THORN: 'Þ',
  oelig: 'œ', OElig: 'Œ',
  scaron: 'š', Scaron: 'Š',
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => {
      const n = Number(code)
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      const n = Number.parseInt(hex, 16)
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''
    })
    // Exact (case-sensitive) match first — accents differ by case; fall
    // back to lowercase so shouty structural entities (&AMP;) still decode.
    .replace(
      /&([a-zA-Z]+);/g,
      (m, name: string) => NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()] ?? m,
    )
}

export interface HtmlToTextResult {
  text: string
  truncated: boolean
}

/** Strip an HTML document down to its visible text. `maxChars` caps the
 * output (post-collapse) and reports truncation so callers can surface
 * "the page was cut off" instead of silently extracting from half a
 * lineup. Plain text passes through (minus whitespace collapse), so
 * pasted non-HTML sources ride the same path. */
export function htmlToText(html: string, maxChars: number): HtmlToTextResult {
  let s = html
    // Drop invisible subtrees wholesale before tag-stripping.
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(BLOCK_TAG_RE, '\n')
    .replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
    // Collapse runs of spaces/tabs, then squeeze blank lines; trim edges.
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
  if (s.length <= maxChars) return { text: s, truncated: false }
  return { text: s.slice(0, maxChars), truncated: true }
}
