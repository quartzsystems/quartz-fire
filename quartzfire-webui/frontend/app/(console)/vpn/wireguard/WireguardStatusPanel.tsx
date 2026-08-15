"use client";

import { useCallback } from "react";
import {
  EmptyState,
  RawOutput,
  StatTile,
  StatusError,
  StatusHeader,
  StatusLoading,
  useOpMode,
} from "@/components/vpn/opmode";
import { WgInterfaceStatus, WgPeerStatus, parseWireguardStatus, runShow } from "@/lib/vpn-status";

interface Result {
  interfaces: WgInterfaceStatus[];
  raw: string;
}

/// A peer counts as "active" if it reports status active, or it has a recent
/// handshake (anything other than never / not-yet).
function peerActive(p: WgPeerStatus): boolean {
  if (p.status) return p.status.toLowerCase() === "active";
  const h = (p.latest_handshake ?? "").toLowerCase();
  return h !== "" && !h.includes("never");
}

const short = (k: string | null) => (k ? `${k.slice(0, 12)}…` : "—");

const muted = { color: "var(--cds-alias-typography-color-200)" } as const;
const mono = { fontFamily: "var(--qz-font-mono)" } as const;
const cellMono = { ...mono, fontSize: 12 } as const;

/// Mock-style cell: mono value, dim em-dash when absent.
function MonoCell({ value }: { value: string | null }) {
  return value && value.length ? <span style={cellMono}>{value}</span> : <span style={muted}>—</span>;
}

/// Borderless compact peer table per the DC mock (State · Peer · Endpoint ·
/// Allowed IPs · Latest handshake · Transfer).
function PeerTable({ peers }: { peers: WgPeerStatus[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="table table-compact table-noborder">
        <thead>
          <tr>
            <th>State</th>
            <th>Peer</th>
            <th>Endpoint</th>
            <th>Allowed IPs</th>
            <th>Latest handshake</th>
            <th>Transfer</th>
          </tr>
        </thead>
        <tbody>
          {peers.map((p, i) => {
            const active = peerActive(p);
            return (
              <tr key={`${p.name}-${i}`}>
                <td><span className={active ? "badge badge-ok" : "badge badge-muted"}>{active ? "Active" : "Idle"}</span></td>
                <td><span style={{ ...cellMono, fontWeight: 600, color: "var(--cds-alias-typography-color-450)" }}>{p.name}</span></td>
                <td><MonoCell value={p.endpoint} /></td>
                <td><MonoCell value={p.allowed_ips} /></td>
                <td><MonoCell value={p.latest_handshake} /></td>
                <td><MonoCell value={p.transfer} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/// Live WireGuard interface + peer state (`show interfaces wireguard`).
export function WireguardStatusPanel() {
  const fetcher = useCallback(async (): Promise<Result> => {
    const raw = await runShow(["interfaces", "wireguard"]);
    return { interfaces: parseWireguardStatus(raw), raw };
  }, []);
  const { data, status, error, lastUpdated, reload, retry } = useOpMode(fetcher);

  if (status === "loading") return <StatusLoading what="WireGuard status" />;
  if (status === "error") return <StatusError message={error} onRetry={retry} />;

  const interfaces = data?.interfaces ?? [];
  const totalPeers = interfaces.reduce((n, i) => n + i.peers.length, 0);
  const activePeers = interfaces.reduce((n, i) => n + i.peers.filter(peerActive).length, 0);

  return (
    <div className="flex flex-col gap-3">
      <StatusHeader
        lastUpdated={lastUpdated}
        onRefresh={reload}
        tiles={
          <>
            <StatTile label="Interfaces" value={String(interfaces.length)} />
            <StatTile label="Peers" value={String(totalPeers)} />
            <StatTile label="Active peers" value={`${activePeers} / ${totalPeers}`} sub="handshaking / total" />
          </>
        }
      />

      {interfaces.length === 0 ? (
        <EmptyState>No WireGuard interfaces are up.</EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {interfaces.map((iface) => {
            // DC-mock summary line: `10.200.0.1/24 · port 51820 · pubkey qF3xM2…`.
            const summary = [
              iface.address,
              iface.listening_port ? `port ${iface.listening_port}` : null,
              iface.public_key ? `pubkey ${short(iface.public_key)}` : null,
            ].filter(Boolean).join(" · ");
            return (
              <div key={iface.name} className="card">
                <div className="card-header">
                  <span style={mono}>{iface.name}</span>
                  {summary && (
                    <span className="text-[12px] font-normal" style={{ ...mono, marginLeft: 12, ...muted }} title={iface.public_key ?? undefined}>
                      {summary}
                    </span>
                  )}
                  <span className="ml-auto text-[12px] font-normal" style={muted}>{iface.peers.length} peer{iface.peers.length === 1 ? "" : "s"}</span>
                </div>
                {iface.peers.length === 0 ? (
                  <div className="px-4 py-3 text-[12px]" style={muted}>No peers.</div>
                ) : (
                  <PeerTable peers={iface.peers} />
                )}
              </div>
            );
          })}
        </div>
      )}

      {data && <RawOutput command="interfaces wireguard" text={data.raw} />}
    </div>
  );
}
