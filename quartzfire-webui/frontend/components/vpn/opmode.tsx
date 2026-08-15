"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { useColumnResize } from "@/components/dashboard/ColumnResize";
import { OpTable } from "@/lib/vpn-status";

const REFRESH_MS = 5000;

/// Poll an op-mode fetcher every 5s (paused when the tab is hidden). The first
/// load shows the loading state; later polls update silently and only surface
/// an error if the very first load failed. Mirrors the routing Status panels.
export function useOpMode<T>(fetcher: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const busy = useRef(false);

  const load = useCallback(
    async (mode: "load" | "poll" = "load") => {
      if (busy.current) return;
      busy.current = true;
      if (mode === "load") setStatus("loading");
      try {
        const d = await fetcher();
        setData(d);
        setLastUpdated(new Date());
        setStatus("ready");
      } catch (e) {
        if (mode === "load") {
          setError(e instanceof Error ? e.message : "Failed to load status.");
          setStatus("error");
        }
      } finally {
        busy.current = false;
      }
    },
    [fetcher],
  );

  useEffect(() => {
    load();
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      load("poll");
    };
    const id = window.setInterval(tick, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);

  return { data, status, error, lastUpdated, reload: () => load("poll"), retry: () => load() };
}

export function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <div className="card-block flex flex-col gap-1" style={{ padding: "12px 16px" }}>
        <span className="clr-smallcaption">{label}</span>
        <span className="text-[20px] font-semibold" style={{ color: "var(--cds-alias-typography-color-450)", fontFamily: "var(--qz-font-mono)" }}>{value}</span>
        {sub && <span className="text-[11px]" style={{ color: "var(--cds-alias-typography-color-200)" }}>{sub}</span>}
      </div>
    </div>
  );
}

/// Header row for a Status panel: stat tiles on the left, timestamp + Refresh
/// stacked on the right.
export function StatusHeader({ tiles, lastUpdated, onRefresh }: {
  tiles: React.ReactNode;
  lastUpdated: Date | null;
  onRefresh: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 flex-wrap">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 flex-1 min-w-[280px]">{tiles}</div>
      <div className="flex flex-col items-end gap-2">
        {lastUpdated && <span className="text-[12px]" style={{ color: "var(--cds-alias-typography-color-200)" }}>Updated <span className="mono">{lastUpdated.toLocaleTimeString()}</span></span>}
        <Button kind="secondary" size="sm" icon="refresh" onClick={onRefresh}>Refresh</Button>
      </div>
    </div>
  );
}

export function StatusLoading({ what }: { what: string }) {
  return <div className="text-[13px]" style={{ color: "var(--cds-alias-typography-color-300)" }}>Loading {what}…</div>;
}

export function StatusError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="alert alert-danger alert-sm">
      <Icon shape="exclamation-circle" size={14} className="alert-icon" />
      <span className="alert-text">{message}</span>
      <div className="alert-actions">
        <button type="button" className="alert-action" onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="card-block text-center text-[13px]" style={{ padding: 24, color: "var(--cds-alias-typography-color-300)" }}>
        {children}
      </div>
    </div>
  );
}

/// Render a parsed op-mode table. Purely presentational — column meaning is
/// whatever the command emitted. `renderCell` lets a caller badge a column.
/// Columns are drag-resizable; widths persist per header set (or per
/// `storageKey` when a caller wants an explicit namespace).
export function OpTableView({ table, renderCell, emptyMessage, storageKey }: {
  table: OpTable;
  renderCell?: (colHeader: string, value: string) => React.ReactNode;
  emptyMessage: string;
  storageKey?: string;
}) {
  const resize = useColumnResize(
    storageKey ?? `op:${table.headers.join(",")}`,
    table.headers.map((h, i) => ({ key: `${i}:${h}` })),
  );
  if (table.headers.length === 0 || table.rows.length === 0) {
    return <EmptyState>{emptyMessage}</EmptyState>;
  }
  return (
    <div className="overflow-x-auto">
      <table ref={resize.tableRef} className="table" style={{ tableLayout: resize.tableLayout }}>
        <colgroup>
          {table.headers.map((h, i) => (
            <col key={i} style={{ width: resize.colWidth(`${i}:${h}`) }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {table.headers.map((h, i) => (
              <th key={i} {...resize.thProps(i)} className="whitespace-nowrap" style={{ position: "relative" }}>
                {h}
                {resize.handle(i)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, ri) => (
            <tr key={ri}>
              {table.headers.map((h, ci) => (
                <td
                  key={ci}
                  className="whitespace-nowrap"
                  style={{ fontFamily: "var(--qz-font-mono)", overflow: "hidden", textOverflow: "ellipsis" }}
                >
                  {renderCell ? renderCell(h, row[ci] ?? "") : (row[ci] || "—")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/// Collapsible raw command output — the source of truth behind every parsed
/// view, so a drifted parser never hides real state. Collapsed by default.
/// `command` is the op-mode command shown in the header (e.g. `vpn ipsec sa`).
export function RawOutput({ command, text }: { command: string; text: string }) {
  const [open, setOpen] = useState(false);
  const body = text.trim();
  return (
    <div className="card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="btn btn-sm btn-link-neutral"
        style={{ justifyContent: "flex-start", width: "100%", height: "auto", padding: "8px 12px" }}
      >
        <Icon shape="angle" dir={open ? "down" : "right"} size={12} />
        <span className="font-medium">Raw output</span>
        <code className="ml-1 text-[11px]" style={{ color: "var(--cds-alias-typography-color-200)", fontFamily: "var(--qz-font-mono)" }}>{`show ${command}`}</code>
      </button>
      {open && (
        <pre
          className="m-0 px-3 py-3 text-[12px] overflow-x-auto"
          style={{ borderTop: "1px solid var(--cds-alias-object-border-subtle)", background: "var(--qz-input-bg)", color: "var(--cds-alias-typography-color-400)", fontFamily: "var(--qz-font-mono)" }}
        >
          {body || "(no output)"}
        </pre>
      )}
    </div>
  );
}
