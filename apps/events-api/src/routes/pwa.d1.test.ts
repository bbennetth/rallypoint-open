import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import type { RealtimeBus, RealtimeEnvelope, Subscription } from '@rallypoint/realtime'
import { createBindingObjectStore } from '@rallypoint/object-store'
import { APP_ICON_MAX_BYTES } from '@rallypoint/events-shared'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { EVENTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// Integration tests for the per-event PWA surface against real D1 +
// real Miniflare R2. The manifest route is what makes "save THIS event
// to my home screen" work, so the invariants under test are: a distinct
// manifest id per event, a start_url pointing at the attendee surface,
// and public reachability WITHOUT a session (browsers fetch manifests
// and icons uncredentialed).

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

// Minimal valid PNG signature — the upload route magic-byte checks it.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function makeBus(): RealtimeBus {
  return {
    async publish(_channel: string, _env: RealtimeEnvelope) {},
    subscribe(): Subscription {
      return { unsubscribe() {} }
    },
    async close() {},
  }
}

interface Manifest {
  id: string
  name: string
  short_name: string
  start_url: string
  scope: string
  display: string
  theme_color: string
  icons: { src: string; sizes: string; purpose: string }[]
}

describe('D1 integration — per-event PWA manifest + app icon', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })

    const services = {
      idClient: {
        verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
        signoutRpidBearer: async () => {},
        batchLookupUsers: async () => [],
      },
      rpidSso: { exchange: async () => ({ ok: false as const, reason: 'invalid' as const }) },
      rpidReauth: { verify: async () => ({ ok: true as const }) },
      objectStore: createBindingObjectStore(env.OBJECT_STORE),
      weather: {
        getEventWeather: async () => ({
          forecast: null,
          airQuality: null,
          issuedAt: new Date().toISOString(),
        }),
      },
      settings: { get: async () => ({}), patch: async (_u: unknown, _n: unknown, patch: unknown) => patch },
    } as unknown as Services

    app = buildApp({ env: envVars, logger: undefined, repos, services, realtime: makeBus() })
  })

  async function loginAs(userId: string): Promise<string> {
    const rawBearer = generateRawToken(EVENTS_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { EVENTS_SESSION_KEY_V1: envVars.EVENTS_SESSION_KEY_V1 },
      keyVersion: envVars.EVENTS_SESSION_KEY_VERSION,
    })
    await repos.sessions.create({
      idHash,
      userId,
      rpidBearerCiphertext: sealed.ciphertext,
      rpidBearerNonce: sealed.nonce,
      rpidBearerKeyVersion: sealed.keyVersion,
      absoluteExpiresAt: new Date(Date.now() + 3_600_000),
      ipHash: '',
      uaHash: '',
    })
    return rawBearer
  }

  function headers(bearer: string): Record<string, string> {
    return {
      cookie: `${envVars.EVENTS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.EVENTS_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      origin: envVars.EVENTS_UI_ORIGIN,
    }
  }

  async function createEvent(bearer: string, name: string): Promise<{ id: string; slug: string }> {
    const res = await app.request('http://localhost/api/v1/ui/events', {
      method: 'POST',
      headers: { ...headers(bearer), 'content-type': 'application/json' },
      body: JSON.stringify({ name, timezone: 'UTC' }),
    })
    expect(res.status).toBe(201)
    return (await res.json()) as { id: string; slug: string }
  }

  async function uploadIcon(
    bearer: string,
    eventId: string,
    bytes: Uint8Array = PNG_BYTES,
    type = 'image/png',
  ): Promise<Response> {
    const form = new FormData()
    form.append('file', new File([bytes], 'icon.png', { type }))
    return app.request(`http://localhost/api/v1/ui/events/${eventId}/app-icon`, {
      method: 'POST',
      headers: headers(bearer),
      body: form,
    })
  }

  function manifestUrl(eventId: string, start?: string): string {
    const q = start ? `?start=${encodeURIComponent(start)}` : ''
    return `http://localhost/api/v1/sdk/events/${eventId}/manifest.webmanifest${q}`
  }

  // --- manifest ------------------------------------------------------

  it('serves a manifest whose id is the event and whose start_url is the attendee view', async () => {
    const bearer = await loginAs(`user_${Date.now()}_mf1`)
    const ev = await createEvent(bearer, 'Harvest Moon Festival')

    const res = await app.request(manifestUrl(ev.id))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/manifest+json')

    const m = (await res.json()) as Manifest
    expect(m.id).toBe(`/events/${ev.id}`)
    expect(m.start_url).toBe(`/events/${ev.slug}/attending/now`)
    expect(m.name).toBe('Harvest Moon Festival')
    expect(m.short_name).toBe('Harvest')
    expect(m.display).toBe('standalone')
  })

  // Browsers fetch manifests and icons WITHOUT credentials — a session
  // requirement here would break installation outright.
  it('serves the manifest with no session cookie at all', async () => {
    const bearer = await loginAs(`user_${Date.now()}_mf2`)
    const ev = await createEvent(bearer, 'Cookieless Fest')

    const res = await app.request(manifestUrl(ev.id))
    expect(res.status).toBe(200)
  })

  // The core "save a SPECIFIC event" guarantee: two events must not
  // resolve to the same installed app.
  it('gives two events distinct manifest ids', async () => {
    const bearer = await loginAs(`user_${Date.now()}_mf3`)
    const a = await createEvent(bearer, 'Alpha Fest')
    const b = await createEvent(bearer, 'Beta Fest')

    const [ma, mb] = (await Promise.all([
      app.request(manifestUrl(a.id)).then((r) => r.json()),
      app.request(manifestUrl(b.id)).then((r) => r.json()),
    ])) as Manifest[]

    expect(ma.id).not.toBe(mb.id)
    expect(ma.start_url).not.toBe(mb.start_url)
    // ...and neither collides with the stock app manifest (id '/').
    expect(ma.id).not.toBe('/')
    expect(mb.id).not.toBe('/')
  })

  // A private event still needs an installable attendee app, so the
  // manifest must NOT apply the public_page_config gate.
  it('serves a manifest for an event with no public page enabled', async () => {
    const bearer = await loginAs(`user_${Date.now()}_mf4`)
    const ev = await createEvent(bearer, 'Invite Only Fest')

    const res = await app.request(manifestUrl(ev.id))
    expect(res.status).toBe(200)
    expect(((await res.json()) as Manifest).id).toBe(`/events/${ev.id}`)
  })

  it('404s for an unknown event id', async () => {
    const res = await app.request(manifestUrl('event_does_not_exist'))
    expect(res.status).toBe(404)
  })

  it('falls back to the solo surface for a group that belongs to another event', async () => {
    const bearer = await loginAs(`user_${Date.now()}_mf5`)
    const ev = await createEvent(bearer, 'Group Guard Fest')

    const res = await app.request(manifestUrl(ev.id, 'group:grp_not_a_real_group'))
    expect(res.status).toBe(200)
    const m = (await res.json()) as Manifest
    expect(m.start_url).toBe(`/events/${ev.slug}/attending/now`)
  })

  it('uses the stock icon set when no icon is uploaded', async () => {
    const bearer = await loginAs(`user_${Date.now()}_mf6`)
    const ev = await createEvent(bearer, 'Default Icon Fest')

    const m = (await app.request(manifestUrl(ev.id)).then((r) => r.json())) as Manifest
    expect(m.icons[0]!.src).toBe('/icons/rallypt-192.png')
  })

  // --- icon upload / serve / delete ----------------------------------

  it('upload + serve: stores the icon in R2 and the manifest points at it', async () => {
    const bearer = await loginAs(`user_${Date.now()}_ic1`)
    const ev = await createEvent(bearer, 'Icon Fest')

    const up = await uploadIcon(bearer, ev.id)
    expect(up.status).toBe(201)

    const m = (await app.request(manifestUrl(ev.id)).then((r) => r.json())) as Manifest
    expect(m.icons).toHaveLength(3)
    expect(m.icons.every((i) => i.src.endsWith(`/api/v1/sdk/events/${ev.id}/app-icon`))).toBe(true)
    // Android needs a maskable entry or it letterboxes the icon.
    expect(m.icons.some((i) => i.purpose === 'maskable')).toBe(true)

    // The bytes stream back publicly (no session) as image/png.
    const img = await app.request(`http://localhost/api/v1/sdk/events/${ev.id}/app-icon`)
    expect(img.status).toBe(200)
    expect(img.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG_BYTES)
  })

  it('404s the icon route when no icon is uploaded', async () => {
    const bearer = await loginAs(`user_${Date.now()}_ic2`)
    const ev = await createEvent(bearer, 'No Icon Fest')
    const res = await app.request(`http://localhost/api/v1/sdk/events/${ev.id}/app-icon`)
    expect(res.status).toBe(404)
  })

  // Status is 400 across image-validation failures to match the existing
  // map-upload surface (see errors.ts); the `code` is what distinguishes
  // them, so assert on that.
  it('rejects a non-PNG upload', async () => {
    const bearer = await loginAs(`user_${Date.now()}_ic3`)
    const ev = await createEvent(bearer, 'Jpeg Reject Fest')
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    const res = await uploadIcon(bearer, ev.id, jpeg, 'image/jpeg')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('unsupported_image_type')
    // The message must name PNG specifically, not the map allowlist.
    expect(body.error.message).toContain('PNG')
    expect(body.error.message).not.toContain('WebP')
  })

  // Polyglot guard: declared PNG, actually JPEG bytes.
  it('rejects bytes that do not match the declared PNG type', async () => {
    const bearer = await loginAs(`user_${Date.now()}_ic4`)
    const ev = await createEvent(bearer, 'Polyglot Fest')
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    const res = await uploadIcon(bearer, ev.id, jpegBytes, 'image/png')
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'unsupported_image_type',
    )
  })

  it('rejects an oversized icon', async () => {
    const bearer = await loginAs(`user_${Date.now()}_ic5`)
    const ev = await createEvent(bearer, 'Huge Icon Fest')
    const big = new Uint8Array(APP_ICON_MAX_BYTES + 1)
    big.set(PNG_BYTES, 0)
    const res = await uploadIcon(bearer, ev.id, big)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'image_too_large',
    )
  })

  it('rejects an over-cap declared Content-Length before parsing the body', async () => {
    const bearer = await loginAs(`user_${Date.now()}_ic5b`)
    const ev = await createEvent(bearer, 'Declared Too Big Fest')
    // Declared length far over the cap; the tiny body is never parsed
    // because the early gate rejects first. If the gate did NOT fire, the
    // (non-multipart) body would instead yield a 'file is required'
    // validation error — so image_too_large proves the pre-parse path.
    const res = await app.request(`http://localhost/api/v1/ui/events/${ev.id}/app-icon`, {
      method: 'POST',
      headers: {
        ...headers(bearer),
        'content-type': 'multipart/form-data; boundary=----x',
        'content-length': String(APP_ICON_MAX_BYTES + 5 * 1024 * 1024),
      },
      body: 'x',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('image_too_large')
  })

  it('replacing an icon reaps the previous R2 object', async () => {
    const bearer = await loginAs(`user_${Date.now()}_ic6`)
    const ev = await createEvent(bearer, 'Replace Icon Fest')

    await uploadIcon(bearer, ev.id)
    const first = await repos.events.findById(ev.id)
    const firstKey = (first!.publicPageConfig as { theme?: { icon_image_key?: string } })
      .theme!.icon_image_key!

    await uploadIcon(bearer, ev.id)
    const second = await repos.events.findById(ev.id)
    const secondKey = (second!.publicPageConfig as { theme?: { icon_image_key?: string } })
      .theme!.icon_image_key!

    expect(secondKey).not.toBe(firstKey)
    expect(await env.OBJECT_STORE.head(firstKey)).toBeNull()
    expect(await env.OBJECT_STORE.head(secondKey)).not.toBeNull()
  })

  it('delete clears the key, removes the object, and reverts to stock icons', async () => {
    const bearer = await loginAs(`user_${Date.now()}_ic7`)
    const ev = await createEvent(bearer, 'Delete Icon Fest')
    await uploadIcon(bearer, ev.id)

    const before = await repos.events.findById(ev.id)
    const key = (before!.publicPageConfig as { theme?: { icon_image_key?: string } })
      .theme!.icon_image_key!

    const del = await app.request(`http://localhost/api/v1/ui/events/${ev.id}/app-icon`, {
      method: 'DELETE',
      headers: headers(bearer),
    })
    expect(del.status).toBe(204)
    expect(await env.OBJECT_STORE.head(key)).toBeNull()

    const m = (await app.request(manifestUrl(ev.id)).then((r) => r.json())) as Manifest
    expect(m.icons[0]!.src).toBe('/icons/rallypt-192.png')
  })

  it('delete is idempotent when no icon exists', async () => {
    const bearer = await loginAs(`user_${Date.now()}_ic8`)
    const ev = await createEvent(bearer, 'Idempotent Delete Fest')
    const res = await app.request(`http://localhost/api/v1/ui/events/${ev.id}/app-icon`, {
      method: 'DELETE',
      headers: headers(bearer),
    })
    expect(res.status).toBe(204)
  })

  // Writing an icon must not publish the event's landing page.
  it('uploading an icon does not enable the public page', async () => {
    const bearer = await loginAs(`user_${Date.now()}_ic9`)
    const ev = await createEvent(bearer, 'Stays Private Fest')
    await uploadIcon(bearer, ev.id)

    const row = await repos.events.findById(ev.id)
    const cfg = row!.publicPageConfig as { enabled?: boolean }
    expect(cfg.enabled).toBe(false)

    // ...and the public landing-page SDK route still 404s.
    const pub = await app.request(`http://localhost/api/v1/sdk/events/${ev.slug}`)
    expect(pub.status).toBe(404)
  })

  it('rejects an icon upload from a non-member', async () => {
    const owner = await loginAs(`user_${Date.now()}_own`)
    const stranger = await loginAs(`user_${Date.now()}_str`)
    const ev = await createEvent(owner, 'Members Only Fest')

    const res = await uploadIcon(stranger, ev.id)
    expect(res.status).toBe(404) // existence is not leaked
  })

  // The icon write merges into a shared JSON blob, so it must not
  // clobber ANY owner-set field — not just the one the manifest reads.
  it('preserves the whole public page config when the icon is written', async () => {
    const bearer = await loginAs(`user_${Date.now()}_ic10`)
    const ev = await createEvent(bearer, 'Accent Fest')

    const config = {
      enabled: true,
      theme: { accent_color: '#1abc9c', background_image_key: `events/${ev.id}/bg/key.jpg` },
      sections: [{ kind: 'description' }, { kind: 'lineup', limit_to_tier: 'headliner' }],
      hidden_fields: ['location_label'],
    }
    const patch = await app.request(`http://localhost/api/v1/ui/events/${ev.id}`, {
      method: 'PATCH',
      headers: { ...headers(bearer), 'content-type': 'application/json' },
      body: JSON.stringify({ publicPageConfig: config }),
    })
    expect(patch.status).toBe(200)

    await uploadIcon(bearer, ev.id)

    const row = await repos.events.findById(ev.id)
    const saved = row!.publicPageConfig as typeof config & {
      theme: { icon_image_key?: string }
    }
    expect(saved.enabled).toBe(true)
    expect(saved.sections).toEqual(config.sections)
    expect(saved.hidden_fields).toEqual(config.hidden_fields)
    expect(saved.theme.accent_color).toBe('#1abc9c')
    expect(saved.theme.background_image_key).toBe(`events/${ev.id}/bg/key.jpg`)
    expect(saved.theme.icon_image_key).toBeTruthy()

    const m = (await app.request(manifestUrl(ev.id)).then((r) => r.json())) as Manifest
    expect(m.theme_color).toBe('#1abc9c')
    expect(m.icons[0]!.src).toContain('/app-icon')
  })

  // Removing the icon must be equally surgical.
  it('preserves the rest of the config when the icon is removed', async () => {
    const bearer = await loginAs(`user_${Date.now()}_ic11`)
    const ev = await createEvent(bearer, 'Remove Preserve Fest')

    await app.request(`http://localhost/api/v1/ui/events/${ev.id}`, {
      method: 'PATCH',
      headers: { ...headers(bearer), 'content-type': 'application/json' },
      body: JSON.stringify({
        publicPageConfig: {
          enabled: true,
          theme: { accent_color: '#1abc9c' },
          sections: [{ kind: 'description' }],
        },
      }),
    })
    await uploadIcon(bearer, ev.id)
    await app.request(`http://localhost/api/v1/ui/events/${ev.id}/app-icon`, {
      method: 'DELETE',
      headers: headers(bearer),
    })

    const row = await repos.events.findById(ev.id)
    const saved = row!.publicPageConfig as {
      enabled: boolean
      theme: { accent_color?: string; icon_image_key?: string }
      sections: unknown[]
    }
    expect(saved.enabled).toBe(true)
    expect(saved.theme.accent_color).toBe('#1abc9c')
    expect(saved.sections).toEqual([{ kind: 'description' }])
    expect(saved.theme.icon_image_key).toBeUndefined()
  })

  // Audit 1.1: the icon key can arrive client-supplied via the events
  // PATCH route, so the public serve route must refuse keys outside
  // this event's `events/<eventId>/` namespace — even when the object
  // exists (e.g. it belongs to another event).
  it('refuses an out-of-scope icon key and omits it from the manifest', async () => {
    const bearer = await loginAs(`user_${Date.now()}_ic13`)
    const ev = await createEvent(bearer, 'Scoped Icon Fest')
    const victim = await createEvent(bearer, 'Icon Victim Fest')
    await uploadIcon(bearer, victim.id)
    const victimRow = await repos.events.findById(victim.id)
    const victimKey = (victimRow!.publicPageConfig as { theme: { icon_image_key: string } })
      .theme.icon_image_key
    // Plant the foreign key directly (bypassing the PATCH gate).
    await repos.events.patch(ev.id, {
      publicPageConfig: { enabled: false, theme: { icon_image_key: victimKey } },
    })

    const img = await app.request(`http://localhost/api/v1/sdk/events/${ev.id}/app-icon`)
    expect(img.status).toBe(404)

    const m = (await app.request(manifestUrl(ev.id)).then((r) => r.json())) as Manifest
    expect(m.icons.every((i) => !i.src.includes(`/events/${ev.id}/app-icon`))).toBe(true)
  })

  // The icon backs the INSTALLED app, so one bad unrelated field must
  // not strip every installed home-screen icon for the event.
  it('still serves the icon when an unrelated config field is malformed', async () => {
    const bearer = await loginAs(`user_${Date.now()}_ic12`)
    const ev = await createEvent(bearer, 'Malformed Config Fest')
    await uploadIcon(bearer, ev.id)

    const row = await repos.events.findById(ev.id)
    const cfg = row!.publicPageConfig as { theme: { icon_image_key: string } }
    // Write a config that would fail PublicPageConfigSchema validation
    // but still carries a real icon key.
    await repos.events.patch(ev.id, {
      publicPageConfig: {
        enabled: 'not-a-boolean',
        sections: [{ kind: 'not-a-real-kind' }],
        theme: { icon_image_key: cfg.theme.icon_image_key },
      },
    })

    const img = await app.request(`http://localhost/api/v1/sdk/events/${ev.id}/app-icon`)
    expect(img.status).toBe(200)

    const m = (await app.request(manifestUrl(ev.id)).then((r) => r.json())) as Manifest
    expect(m.icons[0]!.src).toContain('/app-icon')
  })
})
