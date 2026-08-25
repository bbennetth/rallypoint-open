import { describe, it, expect } from 'vitest'
import {
  DEFAULT_THEME_COLOR,
  SHORT_NAME_MAX,
  buildEventManifest,
  parseStartSurface,
  surfacePaths,
  toShortName,
  readIconKey,
  hasAppIcon,
  readAccentColor,
} from './pwa-manifest.js'

describe('parseStartSurface', () => {
  it('defaults to solo when absent', () => {
    expect(parseStartSurface(undefined)).toEqual({ kind: 'solo' })
  })

  it('parses an explicit solo', () => {
    expect(parseStartSurface('solo')).toEqual({ kind: 'solo' })
  })

  it('parses a group surface', () => {
    expect(parseStartSurface('group:grp_123')).toEqual({
      kind: 'group',
      groupId: 'grp_123',
    })
  })

  // A stale bookmark should still install a working app rather than 400.
  it.each(['', 'group:', 'nonsense', 'GROUP:grp_1', '../../etc/passwd'])(
    'falls back to solo for %s',
    (raw) => {
      expect(parseStartSurface(raw)).toEqual({ kind: 'solo' })
    },
  )
})

describe('toShortName', () => {
  it('passes short names through untouched', () => {
    expect(toShortName('Harvest')).toBe('Harvest')
  })

  it('trims surrounding whitespace', () => {
    expect(toShortName('  Harvest  ')).toBe('Harvest')
  })

  it('clips on a word boundary when one is available', () => {
    expect(toShortName('Harvest Moon Festival')).toBe('Harvest')
  })

  // No usable word boundary — a mid-word cut beats a 2-char label.
  it('clips mid-word when the first word is very long', () => {
    expect(toShortName('Supercalifragilistic Fest')).toBe('Supercalifra')
  })

  it('never exceeds the cap', () => {
    const long = 'A'.repeat(200)
    expect(toShortName(long).length).toBeLessThanOrEqual(SHORT_NAME_MAX)
  })
})

describe('surfacePaths', () => {
  it('points solo installs at the attendee now view', () => {
    expect(surfacePaths({ kind: 'solo' }, 'harvest-moon-demo')).toEqual({
      startUrl: '/events/harvest-moon-demo/attending/now',
      scope: '/events/harvest-moon-demo/attending/',
    })
  })

  it('points group installs at the group now view', () => {
    expect(surfacePaths({ kind: 'group', groupId: 'grp_9' }, 'harvest-moon-demo')).toEqual({
      startUrl: '/groups/grp_9/now',
      scope: '/groups/grp_9/',
    })
  })

  // Scope must contain start_url, else the launch URL is out-of-scope
  // and the browser opens it in a plain tab.
  it.each([
    { kind: 'solo' as const },
    { kind: 'group' as const, groupId: 'grp_9' },
  ])('keeps start_url inside scope (%o)', (surface) => {
    const { startUrl, scope } = surfacePaths(surface, 'slug-abcd')
    expect(startUrl.startsWith(scope)).toBe(true)
  })
})

describe('buildEventManifest', () => {
  const base = {
    eventId: 'event_01JABCDEF',
    slug: 'harvest-moon-demo',
    name: 'Harvest Moon Festival',
    surface: { kind: 'solo' as const },
  }

  it('identifies the app by event id, not start_url', () => {
    const m = buildEventManifest(base)
    expect(m.id).toBe('/events/event_01JABCDEF')
  })

  // The whole point: installing from a specific event must not collide
  // with the stock app (id '/') declared in events-web/vite.config.ts.
  it('does not collide with the stock app id', () => {
    expect(buildEventManifest(base).id).not.toBe('/')
  })

  // Solo and group installs of the SAME event share an id, so the second
  // install updates the first rather than adding a duplicate icon.
  it('uses the same id across surfaces of one event', () => {
    const solo = buildEventManifest(base)
    const group = buildEventManifest({
      ...base,
      surface: { kind: 'group', groupId: 'grp_9' },
    })
    expect(group.id).toBe(solo.id)
    expect(group.start_url).not.toBe(solo.start_url)
  })

  it('gives different events different ids', () => {
    const a = buildEventManifest(base)
    const b = buildEventManifest({ ...base, eventId: 'event_01JZZZZZZ' })
    expect(a.id).not.toBe(b.id)
  })

  it('launches into the attendee surface', () => {
    expect(buildEventManifest(base).start_url).toBe(
      '/events/harvest-moon-demo/attending/now',
    )
  })

  it('carries the event name and a clipped short name', () => {
    const m = buildEventManifest(base)
    expect(m.name).toBe('Harvest Moon Festival')
    expect(m.short_name).toBe('Harvest')
  })

  it('falls back to the stock icon set when no icon is uploaded', () => {
    const m = buildEventManifest(base)
    expect(m.icons.map((i) => i.src)).toEqual([
      '/icons/rallypt-192.png',
      '/icons/rallypt-512.png',
      '/icons/rallypt-maskable-512.png',
    ])
  })

  it.each([null, undefined])('treats %s iconUrl as no icon', (iconUrl) => {
    const m = buildEventManifest({ ...base, iconUrl })
    expect(m.icons[0]!.src).toBe('/icons/rallypt-192.png')
  })

  it('uses the uploaded icon at every size when present', () => {
    const url = 'https://events.rallypt.dev/api/v1/sdk/events/event_01JABCDEF/app-icon'
    const m = buildEventManifest({ ...base, iconUrl: url })
    expect(m.icons).toHaveLength(3)
    expect(m.icons.every((i) => i.src === url)).toBe(true)
    // Android needs a maskable entry or it letterboxes the icon.
    expect(m.icons.some((i) => i.purpose === 'maskable')).toBe(true)
  })

  it('defaults the theme colour to the dark chassis', () => {
    const m = buildEventManifest(base)
    expect(m.theme_color).toBe(DEFAULT_THEME_COLOR)
    expect(m.background_color).toBe(DEFAULT_THEME_COLOR)
  })

  it('honours the event accent colour when set', () => {
    const m = buildEventManifest({ ...base, accentColor: '#1abc9c' })
    expect(m.theme_color).toBe('#1abc9c')
    expect(m.background_color).toBe('#1abc9c')
  })

  it('is standalone so it launches without browser chrome', () => {
    expect(buildEventManifest(base).display).toBe('standalone')
  })
})

describe('readIconKey / hasAppIcon', () => {
  it('reads the key from a well-formed config', () => {
    const cfg = { enabled: true, theme: { icon_image_key: 'events/e1/app-icon/x.png' } }
    expect(readIconKey(cfg)).toBe('events/e1/app-icon/x.png')
    expect(hasAppIcon(cfg)).toBe(true)
  })

  // The whole point of the structural read: the icon backs the INSTALLED
  // app, so one bad sibling field must not vanish it from every home
  // screen. A zod parse of the whole object would return null here.
  it('still finds the key when a sibling field is malformed', () => {
    const cfg = {
      enabled: 'not-a-boolean',
      sections: [{ kind: 'not-a-real-kind' }],
      theme: { icon_image_key: 'events/e1/app-icon/x.png' },
    }
    expect(readIconKey(cfg)).toBe('events/e1/app-icon/x.png')
    expect(hasAppIcon(cfg)).toBe(true)
  })

  it.each([null, undefined, 'str', 42, {}, { theme: null }, { theme: {} }])(
    'returns null / false for %s',
    (input) => {
      expect(readIconKey(input)).toBeNull()
      expect(hasAppIcon(input)).toBe(false)
    },
  )

  it('rejects a non-string or empty key', () => {
    expect(readIconKey({ theme: { icon_image_key: '' } })).toBeNull()
    expect(readIconKey({ theme: { icon_image_key: 123 } })).toBeNull()
    expect(hasAppIcon({ theme: { icon_image_key: '' } })).toBe(false)
  })
})

describe('readAccentColor', () => {
  it('reads a valid hex accent', () => {
    expect(readAccentColor({ theme: { accent_color: '#1abc9c' } })).toBe('#1abc9c')
  })

  it('normalises case and whitespace', () => {
    expect(readAccentColor({ theme: { accent_color: '  #1ABC9C ' } })).toBe('#1abc9c')
  })

  it('survives a malformed sibling field', () => {
    expect(
      readAccentColor({ sections: [{ kind: 'bogus' }], theme: { accent_color: '#1abc9c' } }),
    ).toBe('#1abc9c')
  })

  // accent_color IS user-supplied and lands in the manifest theme_color,
  // so the value itself still gets validated.
  it.each(['red', '#fff', '#12345g', 'javascript:alert(1)', '', '#1abc9c9'])(
    'rejects the invalid value %s',
    (accent_color) => {
      expect(readAccentColor({ theme: { accent_color } })).toBeNull()
    },
  )

  it.each([null, undefined, 'str', {}, { theme: null }])('returns null for %s', (input) => {
    expect(readAccentColor(input)).toBeNull()
  })
})
