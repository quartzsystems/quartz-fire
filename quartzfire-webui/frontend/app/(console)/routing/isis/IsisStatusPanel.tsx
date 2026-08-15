"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { IsisNeighborState, IsisSummary, fetchIsisSummary } from "@/lib/isis-status";

const REFRESH_MS = 5000;

const dash = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === "" ? "—" : String(v);

const pillStyle = {
  fontFamily: "var(--qz-font-mono)",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
} as const;

function statePill(state: string | null) {
  const s = (state ?? "").toLowerCase();
  if (s === "up") return "label label-success";
  if (s === "init") return "label label-warning";
  if (s === "" ) return "label";
  return "label label-danger";
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card" style={{ marginTop: 0 }}>
      <div className="card-block flex flex-col gap-1">
        <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--cds-alias-typography-color-200)" }}>{label}</span>
        <span style={{ fontSize: 20, fontWeight: 600, fontFamily: "var(--qz-font-mono)", color: "var(--cds-alias-typography-color-450)" }}>{value}</span>
        {sub && <span className="clr-subtext" style={{ marginTop: 0 }}>{sub}</span>}
      </div>
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
      render: (r) => <span className={statePill(r.state)} style={pillStyle}>{r.state ?? "—"}</span>,
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
    return <div className="clr-secondary">Loading IS-IS status…</div>;
  }
  if (status === "error") {
    return (
      <div className="flex flex-col gap-3">
        <div className="alert alert-danger alert-sm">
          <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
          <div className="alert-text">{errorMsg}</div>
        </div>
        <div>
          <Button kind="secondary" icon="refresh" onClick={() => load()}>Retry</Button>
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
        <div className="flex flex-col items-end gap-2">
          {lastUpdated && <span className="clr-secondary">Updated {lastUpdated.toLocaleTimeString()}</span>}
          <Button kind="secondary" size="sm" icon="refresh" onClick={() => load("poll")}>Refresh</Button>
        </div>
      </div>

      {!running ? (
        <div className="card" style={{ marginTop: 0 }}>
          <div className="card-block clr-secondary" style={{ padding: 24, textAlign: "center" }}>
            IS-IS is not running (isisd reports no area).
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <h3 className="clr-section" style={{ margin: 0, color: "var(--cds-alias-typography-color-450)" }}>Adjacencies</h3>
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
