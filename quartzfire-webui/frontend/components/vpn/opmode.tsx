"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
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
    <div className="rounded-lg p-4 flex flex-col gap-1" style={{ background: "var(--qz-surface)", border: "1px solid var(--qz-border)" }}>
      <span className="text-[11px] uppercase tracking-wider text-[var(--qz-fg-4)]">{label}</span>
      <span className="text-[20px] font-semibold text-[var(--qz-fg-1)]" style={{ fontFamily: "var(--qz-font-mono)" }}>{value}</span>
      {sub && <span className="text-[11px] text-[var(--qz-fg-4)]">{sub}</span>}
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
        {lastUpdated && <span className="text-[12px] text-[var(--qz-fg-4)]">Updated {lastUpdated.toLocaleTimeString()}</span>}
        <Button kind="secondary" size="sm" icon={RotateCw} onClick={onRefresh}>Refresh</Button>
      </div>
    </div>
  );
}

export function StatusLoading({ what }: { what: string }) {
  return <div className="text-[13px] text-[var(--qz-fg-4)]">Loading {what}…</div>;
}

export function StatusError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-[13px] text-[var(--qz-danger)]">
        <AlertTriangle size={15} /> {message}
      </div>
      <div>
        <Button kind="secondary" icon={RotateCw} onClick={onRetry}>Retry</Button>
      </div>
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg p-6 text-center text-[13px] text-[var(--qz-fg-4)]" style={{ background: "var(--qz-surface)", border: "1px solid var(--qz-border)" }}>
      {children}
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
    <div className="overflow-x-auto rounded-lg" style={{ border: "1px solid var(--qz-border)" }}>
      <table ref={resize.tableRef} className="w-full border-collapse text-[13px]" style={{ tableLayout: resize.tableLayout }}>
        <colgroup>
          {table.headers.map((h, i) => (
            <col key={i} style={{ width: resize.colWidth(`${i}:${h}`) }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {table.headers.map((h, i) => (
              <th
                key={i}
                {...resize.thProps(i)}
                className="text-left font-semibold text-[var(--qz-fg-3)] px-3 py-2 whitespace-nowrap"
                style={{ background: "var(--qz-surface)", borderBottom: "1px solid var(--qz-border)", position: "relative" }}
              >
                {h}
                {resize.handle(i)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, ri) => (
            <tr key={ri} style={{ borderBottom: ri < table.rows.length - 1 ? "1px solid var(--qz-border)" : undefined }}>
              {table.headers.map((h, ci) => (
                <td
                  key={ci}
                  className="px-3 py-2 whitespace-nowrap text-[var(--qz-fg-1)]"
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
    <div className="rounded-lg" style={{ border: "1px solid var(--qz-border)" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-[var(--qz-fg-3)] cursor-pointer bg-transparent border-0 text-left"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="font-medium">Raw output</span>
        <code className="ml-1 text-[11px] text-[var(--qz-fg-4)]">{`show ${command}`}</code>
      </button>
      {open && (
        <pre
          className="m-0 px-3 py-3 text-[12px] overflow-x-auto"
          style={{ borderTop: "1px solid var(--qz-border)", background: "var(--qz-input-bg)", color: "var(--qz-fg-2)", fontFamily: "var(--qz-font-mono)" }}
        >
          {body || "(no output)"}
        </pre>
      )}
    </div>
  );
}
