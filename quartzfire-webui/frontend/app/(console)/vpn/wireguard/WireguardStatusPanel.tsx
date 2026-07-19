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

function PeerRow({ peer }: { peer: WgPeerStatus }) {
  const active = peerActive(peer);
  return (
    <div className="grid gap-x-4 gap-y-1 px-3 py-3" style={{ gridTemplateColumns: "minmax(120px,1fr) minmax(140px,1.4fr) minmax(120px,1fr)", borderTop: "1px solid var(--qz-border)" }}>
      <div className="flex items-center gap-2 min-w-0">
        <span className={active ? "badge badge-ok" : "badge badge-muted"}>{active ? "active" : "idle"}</span>
        <span className="text-[13px] text-[var(--qz-fg-1)] truncate" style={{ fontFamily: "var(--qz-font-mono)" }}>{peer.name}</span>
      </div>
      <div className="text-[12px] text-[var(--qz-fg-3)] min-w-0">
        <div><span className="text-[var(--qz-fg-4)]">endpoint </span><span style={{ fontFamily: "var(--qz-font-mono)" }}>{dash(peer.endpoint)}</span></div>
        <div><span className="text-[var(--qz-fg-4)]">allowed </span><span style={{ fontFamily: "var(--qz-font-mono)" }}>{dash(peer.allowed_ips)}</span></div>
      </div>
      <div className="text-[12px] text-[var(--qz-fg-3)] min-w-0">
        <div><span className="text-[var(--qz-fg-4)]">handshake </span>{dash(peer.latest_handshake)}</div>
        <div><span className="text-[var(--qz-fg-4)]">transfer </span><span style={{ fontFamily: "var(--qz-font-mono)" }}>{dash(peer.transfer)}</span></div>
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
            <div key={iface.name} className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--qz-border)" }}>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-3 py-3" style={{ background: "var(--qz-surface)" }}>
                <span className="text-[14px] font-semibold text-[var(--qz-fg-1)]" style={{ fontFamily: "var(--qz-font-mono)" }}>{iface.name}</span>
                {iface.address && <span className="text-[12px] text-[var(--qz-fg-3)]"><span className="text-[var(--qz-fg-4)]">addr </span><span style={{ fontFamily: "var(--qz-font-mono)" }}>{iface.address}</span></span>}
                {iface.listening_port && <span className="text-[12px] text-[var(--qz-fg-3)]"><span className="text-[var(--qz-fg-4)]">port </span><span style={{ fontFamily: "var(--qz-font-mono)" }}>{iface.listening_port}</span></span>}
                <span className="text-[12px] text-[var(--qz-fg-3)]"><span className="text-[var(--qz-fg-4)]">pubkey </span><span style={{ fontFamily: "var(--qz-font-mono)" }} title={iface.public_key ?? undefined}>{short(iface.public_key)}</span></span>
                <span className="ml-auto text-[12px] text-[var(--qz-fg-4)]">{iface.peers.length} peer{iface.peers.length === 1 ? "" : "s"}</span>
              </div>
              {iface.peers.length === 0 ? (
                <div className="px-3 py-3 text-[12px] text-[var(--qz-fg-4)]" style={{ borderTop: "1px solid var(--qz-border)" }}>No peers.</div>
              ) : (
                iface.peers.map((p, i) => <PeerRow key={`${p.name}-${i}`} peer={p} />)
              )}
            </div>
          ))}
        </div>
      )}

      {data && <RawOutput command="interfaces wireguard" text={data.raw} />}
    </div>
  );
}
