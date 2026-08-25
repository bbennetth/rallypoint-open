// Components
// Ink app chrome — the shared shell + controls promoted from planner-web. Pairs
// with @rallypoint/ui/shell.css. (Supersedes AppShell/Sidebar/TabBar for apps
// adopting the full sidebar + pill-tabbar chrome.)
export { AppChrome } from './components/AppChrome.js'
export type {
  AppChromeProps,
  AppChromeNavItem,
} from './components/AppChrome.js'
export { AppSwitcher } from './components/AppSwitcher.js'
export type { AppSwitcherProps } from './components/AppSwitcher.js'
export { DEFAULT_APPS } from './components/apps.js'
export type { AppSwitcherApp } from './components/apps.js'
export { UserMenu } from './components/UserMenu.js'
export type { UserMenuProps, UserMenuProfile } from './components/UserMenu.js'
export { ThemeToggle } from './components/ThemeToggle.js'
export type { ThemeToggleProps } from './components/ThemeToggle.js'
export { Icon, Compass, AppBrandLockup } from './components/icons.js'
export type { IconName } from './components/icons.js'
export { Button } from './components/Button.js'
export type { ButtonProps, ButtonVariant } from './components/Button.js'
export { Field } from './components/Field.js'
export type { FieldProps } from './components/Field.js'
export { CheckboxField } from './components/CheckboxField.js'
export type { CheckboxFieldProps } from './components/CheckboxField.js'
export { ImagePickerField } from './components/ImagePickerField.js'
export type {
  ImagePickerFieldProps,
  ImagePickerStatus,
  ImagePickerVariant,
} from './components/ImagePickerField.js'
export { Banner } from './components/Banner.js'
export type { BannerProps, BannerTone } from './components/Banner.js'
export { BrandLockup } from './components/BrandLockup.js'
export type { BrandLockupProps } from './components/BrandLockup.js'
export { Avatar } from './components/Avatar.js'
export type { AvatarProps } from './components/Avatar.js'
export { initials, avatarBackground } from './lib/initials.js'
export type { InitialsInput } from './lib/initials.js'
export { PullToRefresh } from './components/PullToRefresh.js'
export type { PullToRefreshProps } from './components/PullToRefresh.js'
export { SwUpdateBanner } from './components/SwUpdateBanner.js'
export type { SwUpdateBannerProps } from './components/SwUpdateBanner.js'

// Ink MVP-handoff primitives (shared mobile sub-bar + small accent FAB)
// — single source of truth for the kit's `.rp-subbar` / `.rp-fab` chrome.
// Pair `<SubBar><SubBarSeg/><SubBarSeg/><Fab anchor="subbar" /></SubBar>`
// for tab-internal section switching, or `<Fab anchor="float" />` solo.
export { SubBar } from './components/SubBar.js'
export type { SubBarProps } from './components/SubBar.js'
export { SubBarSeg } from './components/SubBarSeg.js'
export type { SubBarSegProps } from './components/SubBarSeg.js'
export { Fab } from './components/Fab.js'
export type { FabProps } from './components/Fab.js'
export { pickFabAnchor } from './lib/fab-anchor.js'
export type { FabAnchor } from './lib/fab-anchor.js'

// Phase 5 primitives (platform/v-1.1 events redesign)
export { EmptyState } from './components/EmptyState.js'
export type { EmptyStateProps } from './components/EmptyState.js'
export { Table } from './components/Table.js'
export type {
  TableProps,
  TableColumn,
  TableRow,
  TableColumnAlign,
} from './components/Table.js'
export { Drawer } from './components/Drawer.js'
export type { DrawerProps } from './components/Drawer.js'
export { Toaster } from './components/Toaster.js'
export {
  useToast,
  useToastStore,
} from './store/toast.js'
export type { Toast, ToastInput } from './store/toast.js'
export { ConfirmDialog } from './components/ConfirmDialog.js'
export type { ConfirmDialogProps } from './components/ConfirmDialog.js'

// Soft Ink swipe-action rows (#762 PR3) — touch swipe / desktop hover /
// keyboard focus reveal of row edit+delete actions. Pure gesture math in
// lib/swipe-actions.ts (kept unexported, like swipe-nav).
export { SwipeActions } from './components/SwipeActions.js'
export type { SwipeActionsProps, SwipeAction } from './components/SwipeActions.js'

// Phase 5 pure-logic helpers (exposed so apps can drive controlled
// table sort state or build custom toast-like surfaces).
export {
  nextSortState,
  compareValues,
} from './lib/sort.js'
export type { SortDir, SortState } from './lib/sort.js'
export {
  makeToast,
  enqueue as enqueueToast,
  expireQueue,
  nextExpireDeadline,
  DEFAULT_DURATION_MS,
  MAX_QUEUE_SIZE,
} from './lib/toast-queue.js'
export type { ToastTone } from './lib/toast-queue.js'

// Theme store
export {
  useThemeStore,
  sanitizeTheme,
  sanitizeColor,
  applyThemeToDom,
  resolveBootTheme,
  cycleColor,
  toggleMode,
  COLORS_ORDER,
  ACCENT_HEX,
  CHASSIS_BG,
  THEME_BOOT_SOURCE,
  registerThemePersister,
  hydrateThemeFromServer,
} from './store/theme.js'
export type { Theme, AccentColor, ThemePersister } from './store/theme.js'

// Connection state — the SSE-driven tri-state dot used by chrome.
export {
  useConnectionStore,
  selectCanEdit,
  installConnectionListeners,
} from './store/connection.js'
export type { ConnectionState } from './store/connection.js'
export { useConnectionView } from './store/use-connection-view.js'
export type { UseConnectionViewOptions } from './store/use-connection-view.js'
export {
  decideConnectionView,
  wasRecentlyConnected,
  CONNECTION_COLORS,
  CONNECTING_STALE_MS,
  RECENTLY_SYNCED_GRACE_MS,
} from './lib/connection-status.js'
export type {
  ConnectionPhase,
  ConnectionView,
} from './lib/connection-status.js'

// Hooks + viewport helpers
export {
  useViewportHeight,
  pickViewportHeight,
  pickKeyboardInset,
  pickInitialViewportHeight,
  getViewportRecomputeDelays,
  getViewportResumeRecomputeDelays,
  triggerColdLaunchScrollWakeup,
} from './hooks/useViewportHeight.js'
export type {
  ScrollWakeupContainer,
  ScrollWakeupTrigger,
} from './hooks/useViewportHeight.js'
export { useFilePicker } from './hooks/useFilePicker.js'
export type { FilePicker, UseFilePickerOptions } from './hooks/useFilePicker.js'
export { useMobileViewport } from './hooks/useMobileViewport.js'

// Lib
export { detectStandalone } from './lib/standalone.js'
export {
  MOBILE_VIEWPORT_MAX,
  MOBILE_VIEWPORT_QUERY,
  isMobileViewport,
} from './lib/breakpoints.js'
export {
  captureEmbeddedShell,
  isEmbeddedShell,
  isIOS,
  shouldEmbedTarget,
  appendEmbeddedParam,
  hasEmbeddedParam,
  isIOSAgent,
} from './lib/embedded-shell.js'
export { shouldFireViewportResume } from './lib/viewportResumeGate.js'
export type {
  ViewportResumeGateState,
  ViewportResumeSource,
} from './lib/viewportResumeGate.js'

// Brand
export { BRAND } from './brand.js'
export type { Brand } from './brand.js'
