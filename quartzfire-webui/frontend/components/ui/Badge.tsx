import { RouterStatus, AlarmSeverity } from "@/lib/types";

type BadgeVariant = RouterStatus | AlarmSeverity | "muted";

const variantMap: Record<BadgeVariant, { cls: string; text: string; dot: string }> = {
  ok:    { cls: "badge-ok",   text: "OK",       dot: "var(--qz-success)" },
  warn:  { cls: "badge-warn", text: "WARN",     dot: "var(--qz-warn)" },
  crit:  { cls: "badge-crit", text: "CRITICAL", dot: "var(--qz-danger)" },
  info:  { cls: "badge-info", text: "INFO",     dot: "var(--qz-info)" },
  off:   { cls: "badge-muted",text: "OFFLINE",  dot: "var(--qz-ink-7)" },
  muted: { cls: "badge-muted",text: "—",        dot: "var(--qz-ink-7)" },
};

/// Enabled/Disabled admin-state pill shared by the config tables.
export function StatePill({ enabled }: { enabled: boolean }) {
  return <span className={enabled ? "badge badge-ok" : "badge badge-muted"}>{enabled ? "Enabled" : "Disabled"}</span>;
}

export function StatusBadge({ status }: { status: BadgeVariant }) {
  const m = variantMap[status] ?? variantMap.muted;
  return (
    <span className={`badge ${m.cls}`}>
      <span
        className="w-[6px] h-[6px] rounded-full flex-shrink-0"
        style={{ background: m.dot }}
      />
      {m.text}
    </span>
  );
}
