"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { DeviceSystemInfo, fetchSystemInfo } from "@/lib/vyos";
import { formatBytes } from "@/lib/format";

const POLL_MS = 10_000;

const UPTIME_UNITS: Record<string, string> = {
  year: "y", week: "w", day: "d", hour: "h", minute: "m", second: "s",
};

/// "1 day, 2 hours, 34 minutes, 5 seconds" → "1 d 2 h" — the two largest units,
/// spaced like the DC reference ("41 d 6 h"). Falls back to the raw string.
function shortUptime(s: string | null): string | null {
  if (!s) return null;
  const parts: string[] = [];
  const re = /(\d+)\s*(year|week|day|hour|minute|second)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) parts.push(`${m[1]} ${UPTIME_UNITS[m[2]]}`);
  return parts.length ? parts.slice(0, 2).join(" ") : s;
}

/// Built-on strings arrive like "Sat 15 Aug 2026 17:58 UTC" — render ISO per the
/// content rules ("2026-08-15 17:58 UTC"). Unparseable strings pass through.
function isoBuilt(s: string): string {
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s;
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

/// "quartzfire-0.1.0" → "QuartzFire v0.1.0" (unrecognized strings pass through).
/// A trailing build-timestamp segment ("-202607120222") is dropped — the build
/// date is surfaced separately as "Built: …".
function prettyVersion(v: string | null): string {
  if (!v) return "Unknown version";
  const m = /^quartzfire-(.+)$/i.exec(v.trim());
  if (!m) return v;
  return `QuartzFire v${m[1].replace(/-\d{6,}$/, "")}`;
}

/// "7.1 GiB / 23 GiB" → "7.1 / 23 GiB" — the DC reference drops the first unit
/// when both figures share it ("119 MiB / 2 GiB" keeps both).
function usedOfTotal(used: number | null, total: number | null): string {
  const u = formatBytes(used);
  const t = formatBytes(total);
  const ui = u.indexOf(" ");
  const ti = t.indexOf(" ");
  if (ui === -1 || ti === -1 || u.slice(ui + 1) !== t.slice(ti + 1)) return `${u} / ${t}`;
  return `${u.slice(0, ui)} / ${t}`;
}

/// Progress variant by utilisation: green → amber → red.
function progressVariant(pct: number | null): string {
  if (pct == null) return "";
  if (pct >= 90) return " danger";
  if (pct >= 70) return " warning";
  return " success";
}

function Bar({ pct }: { pct: number | null }) {
  const width = Math.max(0, Math.min(100, pct ?? 0));
  return (
    <div className={`progress progress-sm${progressVariant(pct)}`}>
      <div className="progress-fill" style={{ width: `${width}%` }} />
    </div>
  );
}

/// Uppercase section eyebrow, exactly as the DC reference hand-rolls it
/// (11px, 0.04em tracking, color-200) — deliberately not .clr-smallcaption.
function SectionTitle({ label }: { label: React.ReactNode }) {
  return (
    <div
      className="mb-[8px] text-[11px] uppercase"
      style={{ letterSpacing: "0.04em", color: "var(--cds-alias-typography-color-200)" }}
    >
      {label}
    </div>
  );
}

function MetricRow({ label, value, pct }: { label: string; value: string; pct: number | null }) {
  return (
    <div className="flex items-center gap-2 mb-[6px] last:mb-0">
      <span className="w-[44px] flex-shrink-0 text-[12px] text-[var(--cds-alias-typography-color-300)]">{label}</span>
      <div className="flex-1 min-w-0">
        <Bar pct={pct} />
      </div>
      <span
        className="w-[40px] flex-shrink-0 text-right text-[12px] text-[var(--cds-alias-typography-color-400)]"
        style={{ fontFamily: "var(--qz-font-mono)" }}
      >
        {value}
      </span>
    </div>
  );
}

function Divider() {
  return <div className="my-3" style={{ borderTop: "1px solid var(--cds-alias-object-border-subtle)" }} />;
}

export function SystemInfoPod() {
  const [info, setInfo] = useState<DeviceSystemInfo | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await fetchSystemInfo();
      setInfo(data);
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load system information.");
      setStatus((s) => (s === "ready" ? s : "error"));
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const mem = info?.memory;
  const hardware = [info?.hardware_vendor, info?.hardware_model].filter(Boolean).join(" ");
  const uptime = shortUptime(info?.uptime ?? null);

  return (
    <>
      <div className="card-header flex-shrink-0">
        System Information
        {uptime && (
          <span
            style={{
              marginLeft: "auto",
              fontSize: 11,
              fontWeight: 400,
              fontFamily: "var(--qz-font-mono)",
              color: "var(--cds-alias-typography-color-200)",
            }}
          >
            UPTIME {uptime}
          </span>
        )}
      </div>

      <div className="card-block flex-1 min-h-0 overflow-auto">
        {status === "loading" && (
          <div className="text-[13px] text-[var(--cds-alias-typography-color-200)] py-2">Loading system information…</div>
        )}

        {status === "error" && (
          <div className="flex items-center gap-2 text-[13px] py-2" style={{ color: "var(--cds-alias-status-danger)" }}>
            <Icon shape="exclamation-triangle" size={14} />
            {errorMsg}
          </div>
        )}

        {status === "ready" && info && (
          <>
            {/* Identity */}
            <div
              className="text-[20px] font-semibold"
              style={{ color: "var(--cds-alias-interaction-action)", fontFamily: "var(--qz-font-mono)" }}
            >
              {prettyVersion(info.version)}
            </div>
            <div className="grid gap-x-3 gap-y-[2px] text-[12px] mt-2" style={{ gridTemplateColumns: "auto 1fr" }}>
              {info.hostname && (
                <>
                  <span style={{ color: "var(--cds-alias-typography-color-200)" }}>Hostname</span>
                  <span style={{ color: "var(--cds-alias-typography-color-400)", fontFamily: "var(--qz-font-mono)" }}>
                    {info.hostname}
                  </span>
                </>
              )}
              {hardware && (
                <>
                  <span style={{ color: "var(--cds-alias-typography-color-200)" }}>Model</span>
                  <span style={{ color: "var(--cds-alias-typography-color-400)" }}>{hardware}</span>
                </>
              )}
              {info.built_on && (
                <>
                  <span style={{ color: "var(--cds-alias-typography-color-200)" }}>Built</span>
                  <span style={{ color: "var(--cds-alias-typography-color-400)", fontFamily: "var(--qz-font-mono)" }}>
                    {isoBuilt(info.built_on)}
                  </span>
                </>
              )}
            </div>

            <Divider />

            {/* Load average */}
            <SectionTitle label="Load average" />
            <MetricRow label="1 min" value={info.load.one != null ? `${info.load.one}%` : "—"} pct={info.load.one} />
            <MetricRow label="5 min" value={info.load.five != null ? `${info.load.five}%` : "—"} pct={info.load.five} />
            <MetricRow label="15 min" value={info.load.fifteen != null ? `${info.load.fifteen}%` : "—"} pct={info.load.fifteen} />

            <Divider />

            {/* Memory — DC anatomy: "Memory · 38.2%" eyebrow, bar, Used/Total row. */}
            <SectionTitle
              label={mem?.used_pct != null ? `Memory · ${mem.used_pct.toFixed(1)}%` : "Memory"}
            />
            <Bar pct={mem?.used_pct ?? null} />
            <div
              className="flex justify-between mt-1 text-[11px]"
              style={{ fontFamily: "var(--qz-font-mono)", color: "var(--cds-alias-typography-color-200)" }}
            >
              <span>Used {formatBytes(mem?.used_bytes ?? null)}</span>
              <span>Total {formatBytes(mem?.total_bytes ?? null)}</span>
            </div>

            <Divider />

            {/* Disk usage — DC anatomy: fs · bar · "used / total" per row. */}
            <SectionTitle label="Disk usage" />
            {info.storage.length === 0 && (
              <div className="text-[12px] text-[var(--cds-alias-typography-color-200)]">No storage data available.</div>
            )}
            {info.storage.map((s) => (
              <div key={s.filesystem} className="flex items-center gap-2 mb-[6px] last:mb-0">
                <span
                  className="w-[88px] flex-shrink-0 truncate text-[11px] text-[var(--cds-alias-typography-color-300)]"
                  style={{ fontFamily: "var(--qz-font-mono)" }}
                  title={s.filesystem}
                >
                  {s.filesystem}
                </span>
                <div className="flex-1 min-w-0">
                  <Bar pct={s.used_pct} />
                </div>
                <span
                  className="w-[96px] flex-shrink-0 text-right text-[11px] text-[var(--cds-alias-typography-color-200)]"
                  style={{ fontFamily: "var(--qz-font-mono)" }}
                >
                  {usedOfTotal(s.used_bytes, s.size_bytes)}
                </span>
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
}
