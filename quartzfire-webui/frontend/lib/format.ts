// Shared formatting helpers for dashboard tiles.

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const KB = 1024;

/// Human byte size (2 decimals, 1024-based, GB/MB/KB) — for cumulative totals.
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(2)} MB`;
  if (bytes >= KB) return `${(bytes / KB).toFixed(2)} KB`;
  return `${bytes} B`;
}

/// Compact relative time from a unix timestamp (seconds): "just now",
/// "2 min ago", "3 hr ago", "5 days ago". For a future timestamp (e.g. a lease
/// expiry) it reads "in 2 hr". Pairs with `formatTimestamp` for the hover title.
export function formatRelative(unixSecs: number | null | undefined): string {
  if (unixSecs == null || !Number.isFinite(unixSecs) || unixSecs <= 0) return "—";
  const deltaSec = Math.round(Date.now() / 1000 - unixSecs);
  const future = deltaSec < 0;
  const s = Math.abs(deltaSec);
  const say = (n: number, unit: string) => {
    const label = `${n} ${unit}${n === 1 ? "" : "s"}`;
    return future ? `in ${label}` : `${label} ago`;
  };
  if (s < 45) return future ? "soon" : "just now";
  if (s < 90) return say(1, "min");
  if (s < 3600) return say(Math.round(s / 60), "min");
  if (s < 5400) return say(1, "hr");
  if (s < 86400) return say(Math.round(s / 3600), "hr");
  if (s < 172800) return say(1, "day");
  if (s < 2592000) return say(Math.round(s / 86400), "day");
  if (s < 31536000) return say(Math.round(s / 2592000), "mo");
  return say(Math.round(s / 31536000), "yr");
}

/// Absolute local timestamp for tooltips ("Jul 13, 2026, 2:04:11 PM").
export function formatTimestamp(unixSecs: number | null | undefined): string {
  if (unixSecs == null || !Number.isFinite(unixSecs) || unixSecs <= 0) return "—";
  return new Date(unixSecs * 1000).toLocaleString();
}

/// Network rate from bytes/sec, shown in bits/sec (the conventional "speed" unit).
export function formatRate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec == null || !Number.isFinite(bytesPerSec)) return "—";
  const bits = bytesPerSec * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gbps`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(2)} Mbps`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(1)} Kbps`;
  return `${Math.round(bits)} bps`;
}
