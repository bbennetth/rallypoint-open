// HTML-escape user input for safe interpolation into mailer
// template strings. Shared by every render fn in this directory
// so a future fix (e.g. unicode line separators) lands in ONE
// place rather than five (#35).

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
