"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
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

const pillStyle = {
  fontFamily: "var(--qz-font-mono)",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
} as const;

/// State → pill class. Established is healthy; the transient FSM states
/// (Idle/Connect/Active/OpenSent/OpenConfirm) are "working on it"; anything else
/// is trouble.
function statePill(state: string) {
  const s = state.toLowerCase();
  if (s === "established") return "label label-success";
  if (["idle", "connect", "active", "opensent", "openconfirm"].includes(s)) return "label label-warning";
  return "label label-danger";
}

// ── summary tiles ─────────────────────────────────────────────────────────────

function StatTile({ label, value, sub, subTone = "muted" }: { label: string; value: string; sub?: React.ReactNode; subTone?: "muted" | "warn" }) {
  return (
    <div className="card" style={{ marginTop: 0 }}>
      <div className="card-block flex flex-col gap-1">
        <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--cds-alias-typography-color-200)" }}>{label}</span>
        <span style={{ fontSize: 20, fontWeight: 600, fontFamily: "var(--qz-font-mono)", color: "var(--cds-alias-typography-color-450)" }}>
          {value}
        </span>
        {sub && (
          <span style={{ fontSize: 11, color: subTone === "warn" ? "var(--cds-alias-status-warning)" : "var(--cds-alias-typography-color-200)" }}>{sub}</span>
        )}
      </div>
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
      render: (r) => <span className={statePill(r.state)} style={pillStyle}>{r.state}</span>,
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
        <h3 className="clr-section" style={{ margin: 0, color: "var(--cds-alias-typography-color-450)" }}>{AF_LABEL[af.af] ?? af.af}</h3>
        <span className="clr-secondary">
          <span className="mono">{af.established_peers}/{af.total_peers}</span> established
        </span>
      </div>
      <DataTable
        rows={af.peers}
        columns={peerColumns()}
        rowId={(r) => r.neighbor}
        storageKey={`routing-bgp-status-${af.af}`}
        searchPlaceholder="Search neighbors…"
        emptyMessage="No neighbors in this address family."
        onRowOpen={(row) => onInspect(row.neighbor)}
        actions={(row) => (
          <button
            type="button"
            onClick={() => onInspect(row.neighbor)}
            title={`Details for ${row.neighbor}`}
            className="btn btn-sm btn-link-neutral"
          >
            <Icon shape="info-circle" size={14} /> Details
          </button>
        )}
      />
    </div>
  );
}

// ── neighbor detail modal ───────────────────────────────────────────────────

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-[5px] border-b" style={{ borderColor: "var(--cds-alias-object-border-subtle)" }}>
      <span className="clr-secondary">{label}</span>
      <span style={{ fontSize: 13, textAlign: "right", fontFamily: "var(--qz-font-mono)", color: "var(--cds-alias-typography-color-450)" }}>{value}</span>
    </div>
  );
}

function MsgRow({ label, rx, tx }: { label: string; rx: number; tx: number }) {
  return (
    <tr>
      <td>{label}</td>
      <td style={{ textAlign: "right", fontFamily: "var(--qz-font-mono)", color: "var(--cds-alias-typography-color-450)" }}>{rx}</td>
      <td style={{ textAlign: "right", fontFamily: "var(--qz-font-mono)", color: "var(--cds-alias-typography-color-450)" }}>{tx}</td>
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
        title="Neighbor Detail"
        subtitle={
          <>
            <span className="mono">{neighbor}</span>
            {detail?.description ? <> — {detail.description}</> : null}
          </>
        }
        onClose={onClose}
      />
      {status === "loading" && <div className="clr-secondary">Loading neighbor detail…</div>}
      {status === "error" && (
        <div className="alert alert-danger alert-sm">
          <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
          <div className="alert-text">{errorMsg}</div>
        </div>
      )}
      {status === "ready" && detail && (
        <div className="flex flex-col gap-5">
          <div>
            <DetailRow label="Session state" value={<span className={statePill(detail.state)} style={pillStyle}>{detail.state}</span>} />
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
              <h4 className="clr-smallcaption" style={{ margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--cds-alias-typography-color-200)" }}>Prefixes</h4>
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
              <h4 className="clr-smallcaption" style={{ margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--cds-alias-typography-color-200)" }}>Message counters</h4>
              <table className="table table-noborder table-compact" style={{ width: "100%" }}>
                <thead>
                  <tr>
                    <th> </th>
                    <th style={{ textAlign: "right" }}>Received</th>
                    <th style={{ textAlign: "right" }}>Sent</th>
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
              <h4 className="clr-smallcaption" style={{ margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--cds-alias-typography-color-200)" }}>Capabilities</h4>
              <div className="flex flex-col gap-[2px]">
                {detail.capabilities.map((c) => (
                  <div key={c.name} className="flex items-baseline justify-between gap-4" style={{ fontSize: 12 }}>
                    <span style={{ color: "var(--cds-alias-typography-color-300)" }}>{c.name}</span>
                    <span style={{ color: "var(--cds-alias-typography-color-200)", fontFamily: "var(--qz-font-mono)" }}>{c.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      <ModalFooter><button type="button" className="btn btn-primary" onClick={onClose}>Close</button></ModalFooter>
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
    return <div className="clr-secondary">Loading BGP status…</div>;
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

  const totalEstablished = summary?.address_families.reduce((n, af) => n + af.established_peers, 0) ?? 0;
  const totalPeers = summary?.address_families.reduce((n, af) => n + af.total_peers, 0) ?? 0;
  const hasPeers = (summary?.address_families.length ?? 0) > 0;

  // Explain the operational Router ID against what's configured. FRR auto-picks
  // the highest interface address when no router-id is set; a configured value
  // that differs from the live one means FRR hasn't applied it yet (`clear ip
  // bgp *`).
  const opRouterId = summary?.router_id ?? null;
  let routerIdSub: React.ReactNode | undefined;
  let routerIdTone: "muted" | "warn" = "muted";
  if (opRouterId) {
    if (cfgRouterId === undefined) {
      routerIdSub = "operational value";
    } else if (!cfgRouterId) {
      routerIdSub = "auto-derived — none configured";
    } else if (cfgRouterId !== opRouterId) {
      routerIdSub = <>configured <span className="mono">{cfgRouterId}</span> — clear session to apply</>;
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
        <div className="flex flex-col items-end gap-2">
          {lastUpdated && (
            <span className="clr-secondary">
              Updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <Button kind="secondary" size="sm" icon="refresh" onClick={() => load("poll")}>Refresh</Button>
        </div>
      </div>

      {!hasPeers ? (
        <div className="card" style={{ marginTop: 0 }}>
          <div className="card-block clr-secondary" style={{ padding: 24, textAlign: "center" }}>
            BGP is not running, or has no neighbors in any address family.
          </div>
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
