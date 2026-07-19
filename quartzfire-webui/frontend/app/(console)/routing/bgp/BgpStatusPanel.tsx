"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, RotateCw, Info } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { AddressFamily, fetchBgp } from "@/lib/bgp";
import {
  AfSummary,
  BgpSummary,
  NeighborDetail,
  PeerSummary,
  fetchBgpNeighbor,
  fetchBgpSummary,
  formatUptime,
} from "@/lib/bgp-status";

const REFRESH_MS = 5000;

const AF_LABEL: Record<AddressFamily, string> = {
  "ipv4-unicast": "IPv4 Unicast",
  "ipv6-unicast": "IPv6 Unicast",
  "l2vpn-evpn": "L2VPN EVPN",
};

const dash = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === "" ? "—" : String(v);

/// State → badge class. Established is healthy; the transient FSM states
/// (Idle/Connect/Active/OpenSent/OpenConfirm) are "working on it"; anything else
/// is trouble.
function stateBadge(state: string) {
  const s = state.toLowerCase();
  if (s === "established") return "badge badge-ok";
  if (["idle", "connect", "active", "opensent", "openconfirm"].includes(s)) return "badge badge-muted";
  return "badge badge-crit";
}

// ── summary tiles ─────────────────────────────────────────────────────────────

function StatTile({ label, value, sub, subTone = "muted" }: { label: string; value: string; sub?: string; subTone?: "muted" | "warn" }) {
  return (
    <div
      className="rounded-lg p-4 flex flex-col gap-1"
      style={{ background: "var(--qz-surface)", border: "1px solid var(--qz-border)" }}
    >
      <span className="text-[11px] uppercase tracking-wider text-[var(--qz-fg-4)]">{label}</span>
      <span className="text-[20px] font-semibold text-[var(--qz-fg-1)]" style={{ fontFamily: "var(--qz-font-mono)" }}>
        {value}
      </span>
      {sub && <span className="text-[11px]" style={{ color: subTone === "warn" ? "var(--qz-warn)" : "var(--qz-fg-4)" }}>{sub}</span>}
    </div>
  );
}

// ── per-AF neighbor table ───────────────────────────────────────────────────

function peerColumns(): Column<PeerSummary>[] {
  return [
    { key: "neighbor", header: "Neighbor", value: (r) => r.neighbor, mono: true, sortable: true },
    { key: "remote_as", header: "Remote AS", value: (r) => r.remote_as ?? "", render: (r) => dash(r.remote_as), mono: true, sortable: true, width: 120 },
    {
      key: "state",
      header: "State",
      value: (r) => r.state,
      render: (r) => <span className={stateBadge(r.state)}>{r.state}</span>,
      sortable: true,
      width: 130,
    },
    { key: "uptime", header: "Uptime", value: (r) => r.uptime_secs ?? 0, render: (r) => formatUptime(r.uptime_secs), mono: true, sortable: true, width: 110 },
    { key: "pfx_rcvd", header: "Pfx Rcvd", value: (r) => r.prefixes_received ?? -1, render: (r) => dash(r.prefixes_received), mono: true, sortable: true, width: 100 },
    { key: "pfx_sent", header: "Pfx Sent", value: (r) => r.prefixes_sent ?? -1, render: (r) => dash(r.prefixes_sent), mono: true, sortable: true, width: 100 },
    { key: "msgs", header: "Msgs Rx/Tx", value: (r) => (r.msg_rcvd ?? 0) + (r.msg_sent ?? 0), render: (r) => `${dash(r.msg_rcvd)} / ${dash(r.msg_sent)}`, mono: true, width: 130 },
  ];
}

function AfTable({ af, onInspect }: { af: AfSummary; onInspect: (neighbor: string) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="text-[14px] font-semibold text-[var(--qz-fg-1)] m-0">{AF_LABEL[af.af] ?? af.af}</h3>
        <span className="text-[12px] text-[var(--qz-fg-4)]">
          {af.established_peers}/{af.total_peers} established
        </span>
      </div>
      <DataTable
        rows={af.peers}
        columns={peerColumns()}
        rowId={(r) => r.neighbor}
        storageKey={`routing-bgp-status-${af.af}`}
        searchPlaceholder="Search neighbors…"
        emptyMessage="No neighbors in this address family."
        actions={(row) => (
          <button
            type="button"
            onClick={() => onInspect(row.neighbor)}
            title={`Details for ${row.neighbor}`}
            className="inline-flex items-center gap-[5px] text-[12px] text-[var(--qz-fg-3)] hover:text-[var(--qz-accent)] transition-colors bg-transparent border-0 p-0 cursor-pointer"
          >
            <Info size={13} /> Details
          </button>
        )}
      />
    </div>
  );
}

// ── neighbor detail modal ───────────────────────────────────────────────────

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-[5px] border-b" style={{ borderColor: "var(--qz-divider)" }}>
      <span className="text-[12px] text-[var(--qz-fg-4)]">{label}</span>
      <span className="text-[13px] text-[var(--qz-fg-1)] text-right" style={{ fontFamily: "var(--qz-font-mono)" }}>{value}</span>
    </div>
  );
}

function MsgRow({ label, rx, tx }: { label: string; rx: number; tx: number }) {
  return (
    <tr>
      <td className="text-[12px] text-[var(--qz-fg-3)] py-[3px]">{label}</td>
      <td className="text-[13px] text-[var(--qz-fg-1)] text-right py-[3px]" style={{ fontFamily: "var(--qz-font-mono)" }}>{rx}</td>
      <td className="text-[13px] text-[var(--qz-fg-1)] text-right py-[3px]" style={{ fontFamily: "var(--qz-font-mono)" }}>{tx}</td>
    </tr>
  );
}

function NeighborDetailModal({ neighbor, onClose }: { neighbor: string; onClose: () => void }) {
  const [detail, setDetail] = useState<NeighborDetail | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    let alive = true;
    setStatus("loading");
    fetchBgpNeighbor(neighbor)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        setStatus("ready");
      })
      .catch((e) => {
        if (!alive) return;
        setErrorMsg(e instanceof Error ? e.message : "Failed to load neighbor detail.");
        setStatus("error");
      });
    return () => {
      alive = false;
    };
  }, [neighbor]);

  const m = detail?.message_stats;

  return (
    <ModalShell onClose={onClose} maxWidth={560}>
      <ModalHeader
        title={neighbor}
        subtitle={detail?.description ?? "BGP neighbor detail"}
        onClose={onClose}
      />
      {status === "loading" && <div className="text-[13px] text-[var(--qz-fg-4)]">Loading neighbor detail…</div>}
      {status === "error" && (
        <div className="flex items-center gap-2 text-[13px] text-[var(--qz-danger)]">
          <AlertTriangle size={15} /> {errorMsg}
        </div>
      )}
      {status === "ready" && detail && (
        <div className="flex flex-col gap-5">
          <div>
            <DetailRow label="Session state" value={<span className={stateBadge(detail.state)}>{detail.state}</span>} />
            <DetailRow label="Uptime" value={formatUptime(detail.uptime_secs)} />
            <DetailRow label="Remote AS" value={dash(detail.remote_as)} />
            <DetailRow label="Local AS" value={dash(detail.local_as)} />
            <DetailRow label="Remote router-id" value={dash(detail.remote_router_id)} />
            <DetailRow label="Hold time" value={detail.hold_time_secs != null ? `${detail.hold_time_secs}s` : "—"} />
            <DetailRow label="Keepalive" value={detail.keepalive_secs != null ? `${detail.keepalive_secs}s` : "—"} />
            <DetailRow label="Connections up / dropped" value={`${dash(detail.connections_established)} / ${dash(detail.connections_dropped)}`} />
            {detail.last_reset && <DetailRow label="Last reset" value={detail.last_reset} />}
          </div>

          {detail.address_families.length > 0 && (
            <div>
              <h4 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--qz-fg-4)] m-0 mb-2">Prefixes</h4>
              {detail.address_families.map((af) => (
                <DetailRow
                  key={af.af}
                  label={AF_LABEL[af.af] ?? af.af}
                  value={`${dash(af.accepted_prefixes)} in / ${dash(af.sent_prefixes)} out`}
                />
              ))}
            </div>
          )}

          {m && (
            <div>
              <h4 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--qz-fg-4)] m-0 mb-2">Message counters</h4>
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="text-left text-[11px] text-[var(--qz-fg-4)] font-medium"> </th>
                    <th className="text-right text-[11px] text-[var(--qz-fg-4)] font-medium">Received</th>
                    <th className="text-right text-[11px] text-[var(--qz-fg-4)] font-medium">Sent</th>
                  </tr>
                </thead>
                <tbody>
                  <MsgRow label="Opens" rx={m.opens_recv} tx={m.opens_sent} />
                  <MsgRow label="Updates" rx={m.updates_recv} tx={m.updates_sent} />
                  <MsgRow label="Keepalives" rx={m.keepalives_recv} tx={m.keepalives_sent} />
                  <MsgRow label="Notifications" rx={m.notifications_recv} tx={m.notifications_sent} />
                  <MsgRow label="Route refresh" rx={m.route_refresh_recv} tx={m.route_refresh_sent} />
                  <MsgRow label="Total" rx={m.total_recv} tx={m.total_sent} />
                </tbody>
              </table>
            </div>
          )}

          {detail.capabilities.length > 0 && (
            <div>
              <h4 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--qz-fg-4)] m-0 mb-2">Capabilities</h4>
              <div className="flex flex-col gap-[2px]">
                {detail.capabilities.map((c) => (
                  <div key={c.name} className="flex items-baseline justify-between gap-4 text-[12px]">
                    <span className="text-[var(--qz-fg-3)]">{c.name}</span>
                    <span className="text-[var(--qz-fg-4)]" style={{ fontFamily: "var(--qz-font-mono)" }}>{c.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </ModalShell>
  );
}

// ── panel ─────────────────────────────────────────────────────────────────────

export function BgpStatusPanel() {
  const [summary, setSummary] = useState<BgpSummary | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [inspect, setInspect] = useState<string | null>(null);
  // Configured `protocols bgp parameters router-id` (null = not configured,
  // undefined = not loaded / read failed). Read once so we can explain the
  // operational Router ID below — FRR auto-derives it from interfaces when none
  // is configured, which is why it can surface as an unexpected address.
  const [cfgRouterId, setCfgRouterId] = useState<string | null | undefined>(undefined);
  const refreshing = useRef(false);

  const load = useCallback(async (mode: "load" | "poll" = "load") => {
    if (refreshing.current) return;
    refreshing.current = true;
    if (mode === "load") setStatus("loading");
    try {
      const s = await fetchBgpSummary();
      setSummary(s);
      setLastUpdated(new Date());
      setStatus("ready");
    } catch (e) {
      // A poll failure keeps the last good data on screen; only a cold load
      // flips to the error state.
      if (mode === "load") {
        setErrorMsg(e instanceof Error ? e.message : "Failed to load BGP status.");
        setStatus("error");
      }
    } finally {
      refreshing.current = false;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    fetchBgp()
      .then((c) => { if (alive) setCfgRouterId(c.global.router_id); })
      .catch(() => { /* leave undefined → neutral hint, never block the tab */ });
    return () => { alive = false; };
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
    return <div className="text-[13px] text-[var(--qz-fg-4)]">Loading BGP status…</div>;
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

  const totalEstablished = summary?.address_families.reduce((n, af) => n + af.established_peers, 0) ?? 0;
  const totalPeers = summary?.address_families.reduce((n, af) => n + af.total_peers, 0) ?? 0;
  const hasPeers = (summary?.address_families.length ?? 0) > 0;

  // Explain the operational Router ID against what's configured. FRR auto-picks
  // the highest interface address when no router-id is set; a configured value
  // that differs from the live one means FRR hasn't applied it yet (`clear ip
  // bgp *`).
  const opRouterId = summary?.router_id ?? null;
  let routerIdSub: string | undefined;
  let routerIdTone: "muted" | "warn" = "muted";
  if (opRouterId) {
    if (cfgRouterId === undefined) {
      routerIdSub = "operational value";
    } else if (!cfgRouterId) {
      routerIdSub = "auto-derived — none configured";
    } else if (cfgRouterId !== opRouterId) {
      routerIdSub = `configured ${cfgRouterId} — clear session to apply`;
      routerIdTone = "warn";
    } else {
      routerIdSub = "configured";
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 flex-1 min-w-[280px]">
          <StatTile label="Local AS" value={dash(summary?.local_as)} />
          <StatTile label="Router ID" value={dash(summary?.router_id)} sub={routerIdSub} subTone={routerIdTone} />
          <StatTile label="Sessions" value={`${totalEstablished}/${totalPeers}`} sub="established / total (all AFs)" />
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-[12px] text-[var(--qz-fg-4)]">
              Updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <Button kind="secondary" size="sm" icon={RotateCw} onClick={() => load("poll")}>Refresh</Button>
        </div>
      </div>

      {!hasPeers ? (
        <div
          className="rounded-lg p-6 text-center text-[13px] text-[var(--qz-fg-4)]"
          style={{ background: "var(--qz-surface)", border: "1px solid var(--qz-border)" }}
        >
          BGP is not running, or has no neighbors in any address family.
        </div>
      ) : (
        summary!.address_families.map((af) => (
          <AfTable key={af.af} af={af} onInspect={setInspect} />
        ))
      )}

      {inspect && <NeighborDetailModal neighbor={inspect} onClose={() => setInspect(null)} />}
    </div>
  );
}
