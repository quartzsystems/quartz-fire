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
import { OpTable, colIndex, parseFixedTable, runShow } from "@/lib/vpn-status";

interface Result {
  table: OpTable;
  raw: string;
}

const isUp = (s: string) => s.toLowerCase().startsWith("up") || s.toLowerCase().startsWith("est");

function stateBadge(value: string) {
  if (isUp(value)) return <span className="badge badge-ok">{value}</span>;
  if (value.toLowerCase().startsWith("down")) return <span className="badge badge-crit">{value}</span>;
  return <span className="badge badge-muted">{value || "—"}</span>;
}

/// Live IPsec security associations (`show vpn ipsec sa`).
export function IpsecStatusPanel() {
  const fetcher = useCallback(async (): Promise<Result> => {
    const raw = await runShow(["vpn", "ipsec", "sa"]);
    return { table: parseFixedTable(raw, "Connection"), raw };
  }, []);
  const { data, status, error, lastUpdated, reload, retry } = useOpMode(fetcher);

  if (status === "loading") return <StatusLoading what="IPsec status" />;
  if (status === "error") return <StatusError message={error} onRetry={retry} />;

  const table = data?.table ?? { headers: [], rows: [] };
  const stateCol = colIndex(table, "State");
  const total = table.rows.length;
  const up = stateCol >= 0 ? table.rows.filter((r) => isUp(r[stateCol] ?? "")).length : 0;

  return (
    <div className="flex flex-col gap-5">
      <StatusHeader
        lastUpdated={lastUpdated}
        onRefresh={reload}
        tiles={
          <>
            <StatTile label="Security associations" value={String(total)} />
            <StatTile label="Established" value={`${up}/${total}`} sub="up / total" />
          </>
        }
      />

      {total === 0 ? (
        <EmptyState>No IPsec security associations. Peers appear here once they negotiate.</EmptyState>
      ) : (
        <OpTableView
          table={table}
          emptyMessage="No IPsec security associations."
          renderCell={(header, value) => (header.toLowerCase().includes("state") ? stateBadge(value) : value || "—")}
        />
      )}

      {data && <RawOutput command="vpn ipsec sa" text={data.raw} />}
    </div>
  );
}
