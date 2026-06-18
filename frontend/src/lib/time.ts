// AIDEV-NOTE: Shared time/size formatting utilities for the mailhedgehog UI.
// Uses Intl.RelativeTimeFormat for human-friendly relative timestamps,
// falling back to a localized absolute date for messages older than 30 days.
// Uses Intl.NumberFormat for file size formatting (B / KB / MB).

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/**
 * Returns a human-friendly relative time string for an ISO timestamp.
 * e.g. "just now", "5 minutes ago", "2 hours ago", "3 days ago", or a localized date.
 * AIDEV-NOTE: Falls back to toLocaleDateString for messages older than 30 days so
 * the string stays compact in the MessageRow (which has limited width).
 */
export function relativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;
  const diffSec = Math.round(diffMs / 1000);

  if (diffSec < 45) return 'just now';
  if (diffSec < 90) return rtf.format(-1, 'minute');

  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 45) return rtf.format(-diffMin, 'minute');
  if (diffMin < 90) return rtf.format(-1, 'hour');

  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 22) return rtf.format(-diffHour, 'hour');
  if (diffHour < 36) return rtf.format(-1, 'day');

  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 30) return rtf.format(-diffDay, 'day');

  // Older than 30 days: show a localized absolute date
  return new Date(iso).toLocaleDateString();
}

// AIDEV-NOTE: Thresholds for size formatting.
// Using 1024-based units (KiB/MiB) because email clients traditionally show these.
const KB = 1024;
const MB = 1024 * 1024;

const byteFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const kbFormatter = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const mbFormatter = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * Returns a human-friendly size string.
 * e.g. "512 B", "2.0 KB", "1.4 MB".
 */
export function formatSize(bytes: number): string {
  if (bytes < KB) return `${byteFormatter.format(bytes)} B`;
  if (bytes < MB) return `${kbFormatter.format(bytes / KB)} KB`;
  return `${mbFormatter.format(bytes / MB)} MB`;
}
