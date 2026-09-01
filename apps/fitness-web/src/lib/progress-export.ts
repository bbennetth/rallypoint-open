// Canvas compositor for the progress-photo "compare + share" export: a
// 1080×1350 (Instagram 4:5) JPEG with 1 or 2 photos, captions, an optional
// delta line, and a branded footer. Mirrors image.ts's decode → canvas →
// toBlob shape; layout/crop math is pure and unit-tested separately from
// the canvas-drawing side (jsdom has no real 2D context to assert pixels).

import { BRAND, brandMarkSvg } from '@rallypoint/ui'

export const EXPORT = { width: 1080, height: 1350, pad: 48, gutter: 24, footerH: 132 } as const

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface ExportLayout {
  canvas: { width: number; height: number }
  photoBoxes: Box[]
  captionBoxes: Box[]
  deltaBox: Box | null
  footerBox: Box
}

const CAPTION_H = 96
const DELTA_H = 64

/** Pure layout for the 1080×1350 export canvas. Photo band on top, a
 *  caption band under each photo column, an optional delta-line band
 *  (2-up only), and a footer band at the bottom. */
export function computeExportLayout(count: 1 | 2): ExportLayout {
  const { width, height, pad, gutter, footerH } = EXPORT
  const deltaH = count === 2 ? DELTA_H : 0
  const footerBox: Box = { x: 0, y: height - footerH, w: width, h: footerH }
  const deltaBox: Box | null =
    count === 2 ? { x: pad, y: footerBox.y - deltaH, w: width - pad * 2, h: deltaH } : null
  // Available band runs from the top pad to the delta/footer, and holds the
  // photo box plus the caption glued directly beneath it, centered together.
  const bandBottom = deltaBox ? deltaBox.y : footerBox.y
  const availH = bandBottom - pad

  if (count === 1) {
    const boxW = width - pad * 2
    const photoH = Math.min(availH - CAPTION_H, boxW * 1.4)
    const photoY = pad + (availH - (photoH + CAPTION_H)) / 2
    const photoBoxes: Box[] = [{ x: pad, y: photoY, w: boxW, h: photoH }]
    const captionBoxes: Box[] = [{ x: pad, y: photoY + photoH, w: boxW, h: CAPTION_H }]
    return { canvas: { width, height }, photoBoxes, captionBoxes, deltaBox, footerBox }
  }

  const colW = (width - pad * 2 - gutter) / 2
  const photoH = Math.min(availH - CAPTION_H, colW * 1.4)
  const photoY = pad + (availH - (photoH + CAPTION_H)) / 2
  const captionY = photoY + photoH
  const photoBoxes: Box[] = [
    { x: pad, y: photoY, w: colW, h: photoH },
    { x: pad + colW + gutter, y: photoY, w: colW, h: photoH },
  ]
  const captionBoxes: Box[] = [
    { x: pad, y: captionY, w: colW, h: CAPTION_H },
    { x: pad + colW + gutter, y: captionY, w: colW, h: CAPTION_H },
  ]
  return { canvas: { width, height }, photoBoxes, captionBoxes, deltaBox, footerBox }
}

/** Source rect for cover-cropping a `srcW`×`srcH` image into `box`,
 *  centered. Degenerate inputs pass the full source through unchanged,
 *  matching fitWithin's style (image.ts). */
export function coverRect(
  srcW: number,
  srcH: number,
  box: Box,
): { sx: number; sy: number; sw: number; sh: number } {
  if (
    !Number.isFinite(srcW) ||
    !Number.isFinite(srcH) ||
    srcW <= 0 ||
    srcH <= 0 ||
    !Number.isFinite(box.w) ||
    !Number.isFinite(box.h) ||
    box.w <= 0 ||
    box.h <= 0
  ) {
    return { sx: 0, sy: 0, sw: srcW, sh: srcH }
  }
  const srcAspect = srcW / srcH
  const boxAspect = box.w / box.h
  if (srcAspect > boxAspect) {
    // Source is relatively wider than the box — crop the sides.
    const sw = srcH * boxAspect
    return { sx: (srcW - sw) / 2, sy: 0, sw, sh: srcH }
  }
  if (srcAspect < boxAspect) {
    // Source is relatively taller than the box — crop top/bottom.
    const sh = srcW / boxAspect
    return { sx: 0, sy: (srcH - sh) / 2, sw: srcW, sh }
  }
  return { sx: 0, sy: 0, sw: srcW, sh: srcH }
}

function localDatePart(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Pure filename for the exported JPEG, local-date based. */
export function progressExportFileName(photos: { takenAt: string }[]): string {
  if (photos.length <= 1) {
    const date = photos[0] ? localDatePart(photos[0].takenAt) : localDatePart(new Date().toISOString())
    return `rallypoint-progress-${date}.jpg`
  }
  const sorted = [...photos].sort((a, b) => a.takenAt.localeCompare(b.takenAt))
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (!first || !last) return 'rallypoint-progress.jpg'
  return `rallypoint-progress-${localDatePart(first.takenAt)}-vs-${localDatePart(last.takenAt)}.jpg`
}

export interface ExportPhotoInput {
  url: string
  dateText: string
  weightText: string | null
}

function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image()
  img.src = url
  return img.decode().then(() => img)
}

function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  return loadImage(`data:image/svg+xml,${encodeURIComponent(svg)}`)
}

/** Render the 1080×1350 share/compare JPEG for 1 or 2 progress photos. */
export async function renderProgressExport(
  photos: ExportPhotoInput[],
  opts: { deltaText?: string | null } = {},
): Promise<Blob> {
  const count = photos.length === 2 ? 2 : 1
  const layout = computeExportLayout(count)

  const canvas = document.createElement('canvas')
  canvas.width = layout.canvas.width
  canvas.height = layout.canvas.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas export is not supported on this browser.')

  // Resolve the user's live accent (falls back to the brand default when
  // CSS custom properties aren't available, e.g. off-DOM/test contexts)
  // so exports match the chosen theme accent rather than a hard-pinned one.
  const acid =
    (typeof getComputedStyle === 'function' &&
      getComputedStyle(document.documentElement).getPropertyValue('--acid').trim()) ||
    BRAND.colors.acid

  const images = await Promise.all(photos.slice(0, count).map((p) => loadImage(p.url)))
  const markSvg = brandMarkSvg({ ink: BRAND.colors.white, acid, bg: BRAND.colors.bg })
  const markImg = await loadSvgImage(markSvg)

  await document.fonts?.ready

  // Background.
  ctx.fillStyle = BRAND.colors.bg
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Photos, cover-cropped into their boxes.
  images.forEach((img, i) => {
    const box = layout.photoBoxes[i]
    if (!box) return
    const srcW = img.naturalWidth || img.width
    const srcH = img.naturalHeight || img.height
    const { sx, sy, sw, sh } = coverRect(srcW, srcH, box)
    ctx.drawImage(img, sx, sy, sw, sh, box.x, box.y, box.w, box.h)
  })

  // Captions: date (mono, uppercase, letter-spaced, ~70% white) + weight
  // (larger, semibold, white) below it.
  photos.slice(0, count).forEach((p, i) => {
    const box = layout.captionBoxes[i]
    if (!box) return
    const cx = box.x + box.w / 2
    ctx.textAlign = 'center'
    ctx.fillStyle = 'rgba(255,255,255,0.7)'
    ctx.font = '600 22px ui-monospace, monospace'
    drawLetterSpaced(ctx, p.dateText.toUpperCase(), cx, box.y + 30, 2)
    if (p.weightText) {
      ctx.fillStyle = BRAND.colors.white
      ctx.font = '600 34px system-ui, sans-serif'
      ctx.fillText(p.weightText, cx, box.y + 70)
    }
  })

  // Delta line (2-up only).
  if (layout.deltaBox && opts.deltaText) {
    const box = layout.deltaBox
    ctx.textAlign = 'center'
    ctx.fillStyle = acid
    ctx.font = '700 30px system-ui, sans-serif'
    ctx.fillText(opts.deltaText, box.x + box.w / 2, box.y + box.h / 2 + 10)
  }

  // Footer: brand mark + wordmark (left), domain (right).
  const footer = layout.footerBox
  const markSize = 48
  const markX = EXPORT.pad
  const markY = footer.y + (footer.h - markSize) / 2
  ctx.drawImage(markImg, markX, markY, markSize, markSize)

  const wordmarkX = markX + markSize + 16
  const wordmarkY = footer.y + footer.h / 2 + 10
  ctx.textAlign = 'left'
  ctx.font = '700 32px system-ui, sans-serif'
  ctx.fillStyle = BRAND.colors.white
  ctx.fillText(BRAND.wordmark.primary, wordmarkX, wordmarkY)
  const primaryWidth = ctx.measureText(BRAND.wordmark.primary).width
  ctx.fillStyle = acid
  ctx.fillText(BRAND.wordmark.accent, wordmarkX + primaryWidth, wordmarkY)

  ctx.textAlign = 'right'
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  ctx.font = '500 22px system-ui, sans-serif'
  ctx.fillText(BRAND.domain, EXPORT.width - EXPORT.pad, wordmarkY)

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.92),
  )
  if (!blob) throw new Error('Canvas export failed to produce an image.')
  return blob
}

function drawLetterSpaced(
  ctx: CanvasRenderingContext2D,
  text: string,
  centerX: number,
  y: number,
  spacing: number,
): void {
  const chars = [...text]
  const widths = chars.map((ch) => ctx.measureText(ch).width)
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1)
  let x = centerX - total / 2
  const prevAlign = ctx.textAlign
  ctx.textAlign = 'left'
  chars.forEach((ch, i) => {
    ctx.fillText(ch, x, y)
    x += (widths[i] ?? 0) + spacing
  })
  ctx.textAlign = prevAlign
}

/** Share via the Web Share API when available (files), falling back to an
 *  object-URL download (SettingsPage's `a[download]` pattern). */
export async function shareOrDownload(
  blob: Blob,
  filename: string,
): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const file = new File([blob], filename, { type: 'image/jpeg' })

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] })
      return 'shared'
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return 'cancelled'
      // Other share errors fall through to download.
    }
  }

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Defer the revoke past the click's download-commit (Safari/iOS races
  // an immediate revoke against the download starting).
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return 'downloaded'
}
