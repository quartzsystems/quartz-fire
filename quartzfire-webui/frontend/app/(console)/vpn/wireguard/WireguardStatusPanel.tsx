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
const dash = (v: string | null) => (v && v.length ? v : "—");

const muted = { color: "var(--cds-alias-typography-color-200)" } as const;
const mono = { fontFamily: "var(--qz-font-mono)" } as const;

function PeerRow({ peer, first }: { peer: WgPeerStatus; first: boolean }) {
  const active = peerActive(peer);
  return (
    <div className="grid gap-x-4 gap-y-1 px-4 py-3" style={{ gridTemplateColumns: "minmax(120px,1fr) minmax(140px,1.4fr) minmax(120px,1fr)", borderTop: first ? undefined : "1px solid var(--cds-alias-object-border-subtle)" }}>
      <div className="flex items-center gap-2 min-w-0">
        <span className={active ? "label label-success" : "label"}>{active ? "active" : "idle"}</span>
        <span className="text-[13px] truncate" style={{ ...mono, color: "var(--cds-alias-typography-color-450)" }}>{peer.name}</span>
      </div>
      <div className="text-[12px] min-w-0" style={{ color: "var(--cds-alias-typography-color-300)" }}>
        <div><span style={muted}>endpoint </span><span style={mono}>{dash(peer.endpoint)}</span></div>
        <div><span style={muted}>allowed </span><span style={mono}>{dash(peer.allowed_ips)}</span></div>
      </div>
      <div className="text-[12px] min-w-0" style={{ color: "var(--cds-alias-typography-color-300)" }}>
        <div><span style={muted}>handshake </span>{dash(peer.latest_handshake)}</div>
        <div><span style={muted}>transfer </span><span style={mono}>{dash(peer.transfer)}</span></div>
      </div>
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
    <div className="flex flex-col gap-5">
      <StatusHeader
        lastUpdated={lastUpdated}
        onRefresh={reload}
        tiles={
          <>
            <StatTile label="Interfaces" value={String(interfaces.length)} />
            <StatTile label="Peers" value={String(totalPeers)} />
            <StatTile label="Active peers" value={`${activePeers}/${totalPeers}`} sub="handshaking / total" />
          </>
        }
      />

      {interfaces.length === 0 ? (
        <EmptyState>No WireGuard interfaces are up.</EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          {interfaces.map((iface) => (
            <div key={iface.name} className="card">
              <div className="card-header flex-wrap gap-x-5 gap-y-1">
                <span style={mono}>{iface.name}</span>
                {iface.address && <span className="text-[12px] font-normal" style={{ color: "var(--cds-alias-typography-color-300)" }}><span style={muted}>addr </span><span style={mono}>{iface.address}</span></span>}
                {iface.listening_port && <span className="text-[12px] font-normal" style={{ color: "var(--cds-alias-typography-color-300)" }}><span style={muted}>port </span><span style={mono}>{iface.listening_port}</span></span>}
                <span className="text-[12px] font-normal" style={{ color: "var(--cds-alias-typography-color-300)" }}><span style={muted}>pubkey </span><span style={mono} title={iface.public_key ?? undefined}>{short(iface.public_key)}</span></span>
                <span className="ml-auto text-[12px] font-normal" style={muted}>{iface.peers.length} peer{iface.peers.length === 1 ? "" : "s"}</span>
              </div>
              {iface.peers.length === 0 ? (
                <div className="px-4 py-3 text-[12px]" style={muted}>No peers.</div>
              ) : (
                iface.peers.map((p, i) => <PeerRow key={`${p.name}-${i}`} peer={p} first={i === 0} />)
              )}
            </div>
          ))}
        </div>
      )}

      {data && <RawOutput command="interfaces wireguard" text={data.raw} />}
    </div>
  );
}
