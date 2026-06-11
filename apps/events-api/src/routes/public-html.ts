import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  PublicPageConfigSchema,
  type PublicPageConfig,
} from '@rallypoint/events-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { EventRecord } from '../repos/types.js'

// Server-rendered HTML shell for the public event page (design §11
// "CSR-first ... Crawlers see meta tags injected server-side"). Caddy
// routes /e/* to events-api so crawlers like Slack/Twitter/Discord get
// per-event og:title/og:description/og:image before the JS hydrates.
//
// We do NOT do full SSR — we just inject the four OG tags + the
// page title into the existing events-web SPA HTML. The bundle then
// boots, React Router sees /e/:slug, and the PublicEventPage component
// renders normally via /api/v1/sdk/events/:slug.

const TENANT = 'rallypoint'

// Same gating as the SDK route. Imported as code rather than reused
// directly so this file stays self-contained — the two routes can
// evolve independently.
function resolveConfig(raw: unknown): PublicPageConfig | null {
  const parsed = PublicPageConfigSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

function gate(event: EventRecord | null): PublicPageConfig {
  if (!event || event.deletedAt) throw errors.eventNotFound()
  if (event.privacyMode === 'private') throw errors.eventNotFound()
  const config = resolveConfig(event.publicPageConfig)
  if (!config || !config.enabled) throw errors.eventNotFound()
  return config
}

// Read events-web's built index.html via the static-assets binding. On
// Cloudflare Workers there is no filesystem — the SPA is served by the
// ASSETS binding (wrangler.toml `[assets]`), and `/e/*` is listed in
// `run_worker_first` so this route runs before the static handler. We fetch
// the shell asset directly from the binding and inject the OG tags into it.
// Returns null when the binding is absent (e.g. the `app.request(...)` test
// helper) so the caller falls back to the dev stub. No module-level cache:
// the binding fetch is a fast local subrequest and /e/:slug is low-volume
// (crawler/unfurl) traffic served `no-store`.
async function readSpaShell(c: Context<HonoApp>): Promise<string | null> {
  const assets = c.env?.ASSETS
  if (!assets) return null
  try {
    const res = await assets.fetch(new URL('/index.html', c.req.url))
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

// Minimal HTML escape for tag values — title, description, slug,
// image URL. The og:image URL is presigned (safe ASCII) but we escape
// it anyway for defence in depth.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function ogBlock(input: {
  title: string
  description: string | null
  imageUrl: string | null
  pageUrl: string
}): string {
  const lines = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${escapeHtml(input.title)}" />`,
    `<meta property="og:url" content="${escapeHtml(input.pageUrl)}" />`,
    `<meta name="twitter:card" content="${input.imageUrl ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="twitter:title" content="${escapeHtml(input.title)}" />`,
  ]
  if (input.description) {
    const d = input.description.length > 200
      ? input.description.slice(0, 197) + '…'
      : input.description
    lines.push(`<meta property="og:description" content="${escapeHtml(d)}" />`)
    lines.push(`<meta name="twitter:description" content="${escapeHtml(d)}" />`)
  }
  if (input.imageUrl) {
    lines.push(`<meta property="og:image" content="${escapeHtml(input.imageUrl)}" />`)
    lines.push(`<meta name="twitter:image" content="${escapeHtml(input.imageUrl)}" />`)
  }
  return lines.join('\n    ')
}

// Inject the OG block + a per-event <title> into the SPA shell. The
// shell's static <title>...</title> is replaced if present; the OG
// block goes right before </head>.
function templateShell(shell: string, eventName: string, og: string): string {
  const titled = shell.replace(
    /<title>[^<]*<\/title>/i,
    `<title>${escapeHtml(eventName)} — Rallypoint Events</title>`,
  )
  return titled.replace(/<\/head>/i, `    ${og}\n  </head>`)
}

// Dev fallback when no dist build exists. Returns a tiny HTML stub
// with just the OG tags + a meta-refresh into the dev UI origin so
// devs can verify the head templating without a full build.
function devStub(input: {
  title: string
  og: string
  redirectUrl: string
}): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(input.title)}</title>
    <meta http-equiv="refresh" content="0; url=${escapeHtml(input.redirectUrl)}" />
    ${input.og}
  </head>
  <body><p>Loading…</p></body>
</html>
`
}

async function pickOgImageUrl(
  c: Context<HonoApp>,
  event: EventRecord,
  config: PublicPageConfig,
): Promise<string | null> {
  // Priority: theme.background_image_key → primary event map → none.
  // Images are served through the Worker (R2 binding, #409) on a public
  // route that applies the same public-page-config gate so the bucket
  // stays private but crawlers can reach the og:image URL unauthenticated.
  const origin = new URL(c.req.url).origin
  if (config.theme?.background_image_key) {
    // background_image_key is an opaque object key. Serve it through
    // the public background-image route keyed on the event id (which
    // has already passed the `gate()` check above).
    return `${origin}/api/v1/sdk/events/${event.id}/background-image`
  }
  const maps = await c.var.repos.maps.listForEvent(event.id)
  if (maps.length === 0) return null
  // Prefer a 'site' layer map if present, else the first.
  const primary = maps.find((m) => m.layer === 'site') ?? maps[0]!
  return `${origin}/api/v1/sdk/events/${event.id}/maps/${primary.id}/image`
}

export const publicHtmlRoutes = new Hono<HonoApp>()
  // --- OG-templated SPA shell ---------------------------------------
  // /e/:slug is the *public* URL owners share externally. Caddy routes
  // it to events-api so crawlers get filled-in og:* tags; humans get
  // the same HTML, the React bundle then takes over and the React
  // Router resolves /e/:slug → PublicEventPage.
  .get('/e/:slug', async (c) => {
    const slug = c.req.param('slug')
    const event = await c.var.repos.events.findBySlug(TENANT, slug)
    const config = gate(event)
    const imageUrl = await pickOgImageUrl(c, event!, config)

    const og = ogBlock({
      title: event!.name,
      description: event!.description,
      imageUrl,
      pageUrl: `${c.var.env.EVENTS_UI_ORIGIN}/e/${slug}`,
    })

    const shell = await readSpaShell(c)
    let html: string
    if (shell) {
      html = templateShell(shell, event!.name, og)
    } else {
      html = devStub({
        title: event!.name,
        og,
        redirectUrl: `${c.var.env.EVENTS_UI_ORIGIN}/e/${slug}`,
      })
    }

    // No CDN caching here — owners flipping `enabled: false` would
    // otherwise see a stale tag landing in a fresh unfurl. The SDK
    // route below carries the cache budget for the heavier payload.
    c.header('Cache-Control', 'no-store')
    c.header('Content-Type', 'text/html; charset=utf-8')
    return c.body(html)
  })
