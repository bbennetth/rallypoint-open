// Pure helpers for the Drawer component's responsive behavior.
//
// Drawer is right-side slide-out on desktop. When a consumer opts in
// via `mobileSheet`, it becomes a full-width bottom sheet under the
// `DRAWER_SHEET_BREAKPOINT`. The switch is done entirely in CSS (a
// media query) rather than JS resize listeners, so these helpers just
// build the class list and generate the stylesheet that the component
// injects. Keeping them pure makes the responsive contract unit-testable
// without rendering React.

/** Max viewport width (px, inclusive) at which `mobileSheet` drawers
 * render as a bottom sheet instead of a right-side panel. Matches the
 * planner-web mobile breakpoint (tab-bar / FAB layout). */
export const DRAWER_SHEET_BREAKPOINT = 1023

/** Root (backdrop flex container) class list. Adds the sheet modifier
 * only when the consumer opted in. */
export function drawerRootClass(mobileSheet: boolean): string {
  return mobileSheet ? 'rp-drawer-root rp-drawer-root--sheet' : 'rp-drawer-root'
}

/** Stylesheet injected by the Drawer. Generated from the breakpoint
 * constant so the media query can never drift from `DRAWER_SHEET_BREAKPOINT`.
 * Includes the desktop base rules, the keyframes, and the mobile
 * bottom-sheet overrides (full width, rounded top, safe-area inset,
 * slide-up animation). */
export function drawerCss(breakpoint: number = DRAWER_SHEET_BREAKPOINT): string {
  return `
    .rp-drawer-root {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: flex;
      justify-content: flex-end;
    }
    .rp-drawer-panel {
      position: relative;
      height: 100%;
      width: min(var(--rp-drawer-width, 360px), 100vw);
      background: var(--bg);
      border-left: 1.5px solid var(--line);
      display: flex;
      flex-direction: column;
      box-shadow: -12px 0 30px rgba(0, 0, 0, 0.2);
      animation: rp-drawer-slide-in var(--duration-drawer, 220ms) ease-out;
      outline: none;
    }
    .rp-drawer-body {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 16px;
    }
    @keyframes rp-drawer-fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes rp-drawer-slide-in {
      from { transform: translateX(100%); }
      to { transform: translateX(0); }
    }
    @keyframes rp-drawer-slide-up {
      from { transform: translateY(100%); }
      to { transform: translateY(0); }
    }
    @media (max-width: ${breakpoint}px) {
      .rp-drawer-root--sheet {
        justify-content: stretch;
        align-items: flex-end;
      }
      .rp-drawer-root--sheet .rp-drawer-panel {
        width: 100vw;
        height: auto;
        max-height: 90dvh;
        border-left: none;
        border-top: 1.5px solid var(--line);
        border-radius: 16px 16px 0 0;
        box-shadow: 0 -12px 30px rgba(0, 0, 0, 0.2);
        animation: rp-drawer-slide-up var(--duration-drawer, 220ms) ease-out;
      }
      .rp-drawer-root--sheet .rp-drawer-body {
        padding-bottom: calc(16px + env(safe-area-inset-bottom));
      }
    }
  `
}
