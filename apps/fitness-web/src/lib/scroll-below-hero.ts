/** Scroll a live-session element to the top of `.live-main` without
 *  landing it behind the sticky `.live-hero` clock. A plain
 *  scrollIntoView({block:'start'}) puts the element's header exactly
 *  under the hero (it overlays its own flow height once stuck), so the
 *  hero's CURRENT rendered height is measured at call time — it varies
 *  between pages (strength stays full-size; WoD compacts past 64px of
 *  scroll) — and applied as scroll-margin-top before scrolling. */
export function scrollBelowStickyHero(el: HTMLElement | null): void {
  if (!el) return
  const hero = el.closest('.live-main')?.querySelector<HTMLElement>('.live-hero')
  el.style.scrollMarginTop = hero ? `${hero.offsetHeight + 12}px` : ''
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
