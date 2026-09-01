// Off-DOM brand mark — a standalone SVG string of the Compass mark for
// contexts where CSS custom properties don't resolve: canvas rendering,
// data-URL rasterization (PWA manifest icons, og:image, share-sheet
// exports). MUST stay in sync with the Compass component's markup in
// `components/icons.tsx` — if that SVG's geometry changes, mirror the
// change here too. `currentColor` → opts.ink, `var(--acid)` → opts.acid,
// `var(--bg)` → opts.bg.

export function brandMarkSvg(opts: { ink: string; acid: string; bg: string }): string {
  const { ink, acid, bg } = opts
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" aria-hidden="true">
      <circle cx="256" cy="256" r="200" stroke="${ink}" stroke-width="16" fill="none" />
      <line x1="256" y1="40" x2="256" y2="74" stroke="${ink}" stroke-width="16" stroke-linecap="round" />
      <line x1="256" y1="438" x2="256" y2="472" stroke="${ink}" stroke-width="16" stroke-linecap="round" />
      <line x1="40" y1="256" x2="74" y2="256" stroke="${ink}" stroke-width="16" stroke-linecap="round" />
      <line x1="438" y1="256" x2="472" y2="256" stroke="${ink}" stroke-width="16" stroke-linecap="round" />
      <line x1="408.7" y1="103.3" x2="389.5" y2="122.5" stroke="${ink}" stroke-width="11" stroke-linecap="round" opacity="0.55" />
      <line x1="103.3" y1="103.3" x2="122.5" y2="122.5" stroke="${ink}" stroke-width="11" stroke-linecap="round" opacity="0.55" />
      <line x1="408.7" y1="408.7" x2="389.5" y2="389.5" stroke="${ink}" stroke-width="11" stroke-linecap="round" opacity="0.55" />
      <line x1="103.3" y1="408.7" x2="122.5" y2="389.5" stroke="${ink}" stroke-width="11" stroke-linecap="round" opacity="0.55" />
      <polygon points="343.1,168.9 183.73,258.41 253.59,328.27" fill="${acid}" />
      <circle cx="397.4" cy="114.6" r="24" fill="${acid}" />
      <circle cx="397.4" cy="114.6" r="10" fill="${bg}" />
    </svg>`
}
