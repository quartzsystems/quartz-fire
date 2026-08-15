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

interface ExtraOutput {
  command: string;
  text: string;
}
interface Result {
  table: OpTable;
  raw: string;
  extra: ExtraOutput[];
}

/// OpenVPN's `show interfaces openvpn` uses the S/L (state/link) code, e.g.
/// `u/u` = admin-up / link-up. Only both-up is "up".
const isUp = (sl: string) => sl.trim().toLowerCase() === "u/u";

function slBadge(value: string) {
  if (isUp(value)) return <span className="label label-success">{value}</span>;
  return <span className="label">{value || "—"}</span>;
}

/// Live OpenVPN status: the interface state table plus per-mode session output
/// (`show openvpn server|client|site-to-site`) for whichever modes are running.
export function OpenvpnStatusPanel() {
  const fetcher = useCallback(async (): Promise<Result> => {
    const raw = await runShow(["interfaces", "openvpn"]);
    // Per-mode session detail is optional — a mode errors when no tunnel of it
    // exists, so gather only the ones that return output.
    const modes: [string, string[]][] = [
      ["openvpn server", ["openvpn", "server"]],
      ["openvpn client", ["openvpn", "client"]],
      ["openvpn site-to-site", ["openvpn", "site-to-site"]],
    ];
    const extra: ExtraOutput[] = [];
    for (const [command, path] of modes) {
      const text = await runShowSafe(path);
      if (text) extra.push({ command, text });
    }
    return { table: parseFixedTable(raw, "Interface"), raw, extra };
  }, []);
  const { data, status, error, lastUpdated, reload, retry } = useOpMode(fetcher);

  if (status === "loading") return <StatusLoading what="OpenVPN status" />;
  if (status === "error") return <StatusError message={error} onRetry={retry} />;

  const table = data?.table ?? { headers: [], rows: [] };
  const slCol = colIndex(table, "S/L");
  const total = table.rows.length;
  const up = slCol >= 0 ? table.rows.filter((r) => isUp(r[slCol] ?? "")).length : 0;

  return (
    <div className="flex flex-col gap-5">
      <StatusHeader
        lastUpdated={lastUpdated}
        onRefresh={reload}
        tiles={
          <>
            <StatTile label="Tunnels" value={String(total)} />
            <StatTile label="Up" value={`${up}/${total}`} sub="up / total" />
          </>
        }
      />

      {total === 0 ? (
        <EmptyState>No OpenVPN interfaces are present.</EmptyState>
      ) : (
        <OpTableView
          table={table}
          emptyMessage="No OpenVPN interfaces."
          renderCell={(header, value) => (header.toLowerCase() === "s/l" ? slBadge(value) : value || "—")}
        />
      )}

      {data?.extra.map((e) => <RawOutput key={e.command} command={e.command} text={e.text} />)}
      {data && <RawOutput command="interfaces openvpn" text={data.raw} />}
    </div>
  );
}
