"use client";

import { useCallback } from "react";
import {
  EmptyState,
  OpTableView,
  RawOutput,
  StatTile,
  StatusError,
  StatusHeader,
  StatusLoading,
  useOpMode,
} from "@/components/vpn/opmode";
import { OpTable, colIndex, parseFixedTable, runShow, runShowSafe } from "@/lib/vpn-status";

interface Result {
  table: OpTable;
  raw: string;
  command: string;
}

const isActive = (s: string) => {
  const v = s.toLowerCase();
  return v.startsWith("active") || v.startsWith("estab") || v.startsWith("up");
};

function stateBadge(value: string) {
  if (isActive(value)) return <span className="label label-success">{value}</span>;
  if (value.toLowerCase().startsWith("start") || value.toLowerCase().startsWith("finish")) return <span className="label">{value}</span>;
  return <span className="label">{value || "—"}</span>;
}

/// Live L2TP remote-access sessions. The unified `show vpn remote-access`
/// command is preferred; older builds only have `show l2tp-server sessions`, so
/// we fall back to it when the first returns nothing.
export function L2tpStatusPanel() {
  const fetcher = useCallback(async (): Promise<Result> => {
    // Preferred command first; fall back only if it fails or is empty.
    const primary = "vpn remote-access";
    const rawPrimary = await runShowSafe(["vpn", "remote-access"]);
    if (rawPrimary && parseFixedTable(rawPrimary, "user").rows.length > 0) {
      return { table: parseFixedTable(rawPrimary, "user"), raw: rawPrimary, command: primary };
    }
    const rawFallback = await runShowSafe(["l2tp-server", "sessions"]);
    if (rawFallback) {
      return { table: parseFixedTable(rawFallback, "user"), raw: rawFallback, command: "l2tp-server sessions" };
    }
    // Neither produced sessions — show whatever the primary returned (or run it
    // once more to surface a genuine device error).
    const raw = rawPrimary ?? (await runShow(["vpn", "remote-access"]));
    return { table: parseFixedTable(raw, "user"), raw, command: primary };
  }, []);
  const { data, status, error, lastUpdated, reload, retry } = useOpMode(fetcher);

  if (status === "loading") return <StatusLoading what="L2TP sessions" />;
  if (status === "error") return <StatusError message={error} onRetry={retry} />;

  const table = data?.table ?? { headers: [], rows: [] };
  const stateCol = colIndex(table, "state");
  const total = table.rows.length;
  const active = stateCol >= 0 ? table.rows.filter((r) => isActive(r[stateCol] ?? "")).length : 0;

  return (
    <div className="flex flex-col gap-5">
      <StatusHeader
        lastUpdated={lastUpdated}
        onRefresh={reload}
        tiles={
          <>
            <StatTile label="Sessions" value={String(total)} />
            <StatTile label="Active" value={`${active}/${total}`} sub="active / total" />
          </>
        }
      />

      {total === 0 ? (
        <EmptyState>No L2TP sessions. Connected remote-access clients appear here.</EmptyState>
      ) : (
        <OpTableView
          table={table}
          emptyMessage="No L2TP sessions."
          renderCell={(header, value) => (header.toLowerCase() === "state" ? stateBadge(value) : value || "—")}
        />
      )}

      {data && <RawOutput command={data.command} text={data.raw} />}
    </div>
  );
}
