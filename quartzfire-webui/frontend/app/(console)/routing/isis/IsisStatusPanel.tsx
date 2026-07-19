"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { IsisNeighborState, IsisSummary, fetchIsisSummary } from "@/lib/isis-status";

const REFRESH_MS = 5000;

const dash = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === "" ? "—" : String(v);

function stateBadge(state: string | null) {
  const s = (state ?? "").toLowerCase();
  if (s === "up") return "badge badge-ok";
  if (s === "init") return "badge badge-muted";
  if (s === "" ) return "badge badge-muted";
  return "badge badge-crit";
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg p-4 flex flex-col gap-1" style={{ background: "var(--qz-surface)", border: "1px solid var(--qz-border)" }}>
      <span className="text-[11px] uppercase tracking-wider text-[var(--qz-fg-4)]">{label}</span>
      <span className="text-[20px] font-semibold text-[var(--qz-fg-1)]" style={{ fontFamily: "var(--qz-font-mono)" }}>{value}</span>
      {sub && <span className="text-[11px] text-[var(--qz-fg-4)]">{sub}</span>}
    </div>
  );
}

function neighborColumns(): Column<IsisNeighborState>[] {
  return [
    { key: "system_id", header: "System ID / Host", value: (r) => r.system_id ?? "", render: (r) => dash(r.system_id), mono: true, sortable: true },
    { key: "interface", header: "Interface", value: (r) => r.interface ?? "", render: (r) => dash(r.interface), mono: true, sortable: true, width: 130 },
    { key: "level", header: "Level", value: (r) => r.level ?? "", render: (r) => dash(r.level), mono: true, width: 100 },
    {
      key: "state",
      header: "State",
      value: (r) => r.state ?? "",
      render: (r) => <span className={stateBadge(r.state)}>{r.state ?? "—"}</span>,
      sortable: true,
      width: 110,
    },
    { key: "expires", header: "Holdtime", value: (r) => r.expires ?? "", render: (r) => dash(r.expires), mono: true, width: 110 },
    { key: "snpa", header: "SNPA", value: (r) => r.snpa ?? "", render: (r) => dash(r.snpa), mono: true, width: 150 },
  ];
}

export function IsisStatusPanel() {
  const [summary, setSummary] = useState<IsisSummary | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const refreshing = useRef(false);

  const load = useCallback(async (mode: "load" | "poll" = "load") => {
    if (refreshing.current) return;
    refreshing.current = true;
    if (mode === "load") setStatus("loading");
    try {
      const s = await fetchIsisSummary();
      setSummary(s);
      setLastUpdated(new Date());
      setStatus("ready");
    } catch (e) {
      if (mode === "load") {
        setErrorMsg(e instanceof Error ? e.message : "Failed to load IS-IS status.");
        setStatus("error");
      }
    } finally {
      refreshing.current = false;
    }
  }, []);

  useEffect(() => {
    load();
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      load("poll");
    };
    const id = window.setInterval(tick, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);

  if (status === "loading") {
    return <div className="text-[13px] text-[var(--qz-fg-4)]">Loading IS-IS status…</div>;
  }
  if (status === "error") {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-[13px] text-[var(--qz-danger)]">
          <AlertTriangle size={15} /> {errorMsg}
        </div>
        <div>
          <Button kind="secondary" icon={RotateCw} onClick={() => load()}>Retry</Button>
        </div>
      </div>
    );
  }

  const upNeighbors = summary?.neighbors.filter((n) => n.is_up).length ?? 0;
  const totalNeighbors = summary?.neighbors.length ?? 0;
  const running = summary?.running ?? false;
  const primaryArea = summary?.areas[0];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 flex-1 min-w-[280px]">
          <StatTile label="System ID" value={dash(primaryArea?.system_id)} sub={primaryArea?.is_type ?? undefined} />
          <StatTile label="NET" value={dash(primaryArea?.net)} />
          <StatTile label="Adjacencies" value={`${upNeighbors}/${totalNeighbors}`} sub="up / total" />
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && <span className="text-[12px] text-[var(--qz-fg-4)]">Updated {lastUpdated.toLocaleTimeString()}</span>}
          <Button kind="secondary" size="sm" icon={RotateCw} onClick={() => load("poll")}>Refresh</Button>
        </div>
      </div>

      {!running ? (
        <div className="rounded-lg p-6 text-center text-[13px] text-[var(--qz-fg-4)]" style={{ background: "var(--qz-surface)", border: "1px solid var(--qz-border)" }}>
          IS-IS is not running (isisd reports no area).
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <h3 className="text-[14px] font-semibold text-[var(--qz-fg-1)] m-0">Adjacencies</h3>
          <DataTable
            rows={summary!.neighbors}
            columns={neighborColumns()}
            rowId={(r) => `${r.interface ?? ""}-${r.system_id ?? ""}`}
            storageKey="routing-isis-status-neighbors"
            searchPlaceholder="Search adjacencies…"
            emptyMessage="No IS-IS adjacencies."
          />
        </div>
      )}
    </div>
  );
}
