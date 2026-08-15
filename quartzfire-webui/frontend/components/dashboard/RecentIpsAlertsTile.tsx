"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  IpsAlert,
  IpsSettings,
  THREAT_LEVELS,
  alertKey,
  fetchIpsAlertHistory,
  fetchIpsStatus,
} from "@/lib/ips";

const MAX_ROWS = 50;

type AlertRow = IpsAlert & { id: number };

/// Compact alert time — 24-hour clock per the DC reference ("14:03:11"), with a
/// day prefix for history rows older than today.
function alertTime(ts: number): string {
  const d = new Date(ts);
  const sameDay = new Date().toDateString() === d.toDateString();
  const clock = d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return sameDay ? clock : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${clock}`;
}

export function RecentIpsAlertsTile() {
  const rowsRef = useRef<AlertRow[]>([]);
  const nextId = useRef(0);
  const [rows, setRows] = useState<AlertRow[]>([]);
  const [settings, setSettings] = useState<IpsSettings | null>(null);
  const [running, setRunning] = useState<boolean | null>(null);

  // Settings (per-level Log/Alarm flags) and engine liveness, once on mount.
  useEffect(() => {
    let alive = true;
    fetchIpsStatus()
      .then((s) => {
        if (!alive) return;
        setSettings(s.settings);
        setRunning(s.running);
      })
      .catch(() => {
        // tile still renders alerts without the flags
      });
    return () => {
      alive = false;
    };
  }, []);

  // Live SSE stream + persistent history, deduped — the Alerts tab's pattern,
  // trimmed for a tile (no filters, small cap).
  useEffect(() => {
    const es = new EventSource("/api/ips/alerts");
    const push = () => setRows([...rowsRef.current]);
    es.onmessage = (ev) => {
      try {
        const alert = JSON.parse(ev.data) as IpsAlert;
        rowsRef.current = [{ ...alert, id: nextId.current++ }, ...rowsRef.current].slice(0, MAX_ROWS);
        push();
      } catch {
        // tolerate a malformed event rather than killing the stream
      }
    };

    let cancelled = false;
    fetchIpsAlertHistory()
      .then((history) => {
        if (cancelled || history.length === 0) return;
        const seen = new Set(rowsRef.current.map(alertKey));
        const merged = [
          ...rowsRef.current,
          ...history.filter((a) => !seen.has(alertKey(a))).map((a) => ({ ...a, id: nextId.current++ })),
        ];
        merged.sort((a, b) => b.ts - a.ts);
        rowsRef.current = merged.slice(0, MAX_ROWS);
        push();
      })
      .catch(() => {
        // best-effort — the live stream still works without history
      });

    return () => {
      cancelled = true;
      es.close();
    };
  }, []);

  // Hide levels whose Log flag is off, matching the Alerts tab.
  const visible = settings ? rows.filter((r) => settings[r.level]?.log ?? true) : rows;

  return (
    <>
      <div className="card-header flex-shrink-0">
        IPS Alerts
        <span className="ml-auto">
          <Link
            href="/services/intrusion-prevention?tab=alerts"
            className="text-[12px]"
            style={{ fontWeight: 400 }}
          >
            View all →
          </Link>
        </span>
      </div>

      <div className="card-block flex-1 min-h-0 flex flex-col" style={{ paddingTop: 8, paddingBottom: 8 }}>
        {running === false && (
          <div className="text-[12px] text-[var(--cds-alias-typography-color-200)] mb-2 flex-shrink-0">
            IPS engine is not running — showing logged history.
          </div>
        )}

        {visible.length === 0 ? (
          <div className="flex-1 grid place-items-center text-[12px] text-[var(--cds-alias-typography-color-200)] text-center px-4">
            No alerts yet — alerts appear when inspected traffic matches a signature.
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto">
            {visible.map((r) => {
              const meta = THREAT_LEVELS.find((l) => l.level === r.level) ?? THREAT_LEVELS[4];
              const alarm = settings?.[r.level]?.alarm ?? false;
              const route = `${r.src ?? "?"}${r.spt != null ? `:${r.spt}` : ""} → ${r.dst ?? "?"}${r.dpt != null ? `:${r.dpt}` : ""}`;
              return (
                <div
                  key={r.id}
                  className="flex items-center gap-[8px] py-[6px] text-[12px] flex-shrink-0"
                  style={{
                    borderTop: "1px solid var(--cds-alias-object-border-subtle)",
                    background: alarm
                      ? "color-mix(in oklab, var(--cds-alias-status-danger) 7%, transparent)"
                      : undefined,
                  }}
                  title={`${meta.label} · SID ${r.sid}${r.category ? ` · ${r.category}` : ""}\n${route}${r.proto ? ` (${r.proto})` : ""}`}
                >
                  {/* Severity dot per the DC reference (8px, severity color). */}
                  <span
                    className="flex-shrink-0"
                    style={{ width: 8, height: 8, borderRadius: 999, background: meta.color }}
                    aria-label={meta.label}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[var(--cds-alias-typography-color-400)] truncate">{r.signature}</div>
                    <div
                      className="text-[11px] text-[var(--cds-alias-typography-color-200)] truncate"
                      style={{ fontFamily: "var(--qz-font-mono)" }}
                    >
                      {route}
                    </div>
                  </div>
                  {r.action === "blocked" ? (
                    <span
                      className="label label-danger flex-shrink-0"
                      style={{ fontFamily: "var(--qz-font-mono)", fontSize: 10, letterSpacing: "0.06em" }}
                    >
                      BLOCKED
                    </span>
                  ) : (
                    <span
                      className="label label-success flex-shrink-0"
                      style={{ fontFamily: "var(--qz-font-mono)", fontSize: 10, letterSpacing: "0.06em" }}
                    >
                      ALLOWED
                    </span>
                  )}
                  <span
                    className="text-[11px] text-[var(--cds-alias-typography-color-200)] flex-shrink-0 text-right"
                    style={{ fontFamily: "var(--qz-font-mono)" }}
                  >
                    {alertTime(r.ts)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
