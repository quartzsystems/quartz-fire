// Live VPN status (the Status tab on each VPN protocol page).
//
// Unlike routing status (which reads FRR via the backend's vtysh endpoint),
// VPN has no FRR: its state comes from VyOS op-mode `show` commands. Those run
// straight through the authenticated `show` proxy from the browser — the same
// path `fetchPhysicalEthernet` uses — so this is a pure frontend read layer,
// no backend endpoint required.
//
// The commands emit human-formatted text (no JSON), so we parse defensively:
// a fixed-width column parser for the tabulated commands (IPsec SAs, L2TP
// sessions, OpenVPN interfaces) and a block parser for WireGuard's `wg`-style
// output. Every panel also shows the raw output, so a parser that drifts on a
// future VyOS release never hides the real state.

import { vyosApi } from "./api";
import type { VyosResponse } from "./interfaces";

/// Run an op-mode `show` command and return its raw text. Throws on a device
/// error (the panel surfaces the message).
export async function runShow(path: string[]): Promise<string> {
  const resp = await vyosApi<VyosResponse<string | null>>("show", { op: "show", path });
  if (!resp.success) {
    throw new Error(resp.error || "Device returned an error running the command.");
  }
  return resp.data ?? "";
}

/// Like `runShow` but swallows failures (returns null) — for optional commands
/// that error when the relevant mode isn't configured (e.g. `show openvpn
/// server` with no server tunnel).
export async function runShowSafe(path: string[]): Promise<string | null> {
  try {
    const text = await runShow(path);
    return text.trim() === "" ? null : text;
  } catch {
    return null;
  }
}

// ── fixed-width table parser ────────────────────────────────────────────────────

export interface OpTable {
  headers: string[];
  rows: string[][];
}

/// Parse a VyOS/`tabulate` op-mode table into headers + rows. Columns are found
/// from the header line's start offsets (a field begins after 2+ spaces), then
/// every data row is sliced at those same offsets — so empty cells stay aligned
/// instead of collapsing the way a naive whitespace split would.
///
/// `headerKeyword` locates the header row (case-insensitive substring), letting
/// us skip any legend/title lines a command prints first.
export function parseFixedTable(text: string, headerKeyword: string): OpTable {
  const lines = text.replace(/\r/g, "").split("\n");
  const headerIdx = lines.findIndex(
    (l) => l.trim().length > 0 && l.toLowerCase().includes(headerKeyword.toLowerCase()),
  );
  if (headerIdx < 0) return { headers: [], rows: [] };

  const header = lines[headerIdx];
  // Column start offsets: index 0 (if it holds text) plus any non-space run
  // preceded by 2+ spaces. A single internal space (e.g. "Bytes In/Out") keeps
  // the header token whole.
  const starts: number[] = [];
  for (let i = 0; i < header.length; i++) {
    if (header[i] === " ") continue;
    if (i === 0 || (header[i - 1] === " " && (i < 2 || header[i - 2] === " "))) starts.push(i);
  }
  if (starts.length === 0) return { headers: [], rows: [] };

  const cell = (line: string, k: number) => {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : line.length;
    return line.slice(from, to).trim();
  };

  const headers = starts.map((_, k) => cell(header, k));
  const rows: string[][] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^[\s\-=_+|]+$/.test(line)) continue; // separator rule line
    rows.push(starts.map((_, k) => cell(line, k)));
  }
  return { headers, rows };
}

/// Find a column index by a case-insensitive header substring (headers vary
/// slightly across releases). Returns -1 when absent.
export function colIndex(table: OpTable, ...candidates: string[]): number {
  for (const c of candidates) {
    const i = table.headers.findIndex((h) => h.toLowerCase().includes(c.toLowerCase()));
    if (i >= 0) return i;
  }
  return -1;
}

// ── WireGuard block parser ──────────────────────────────────────────────────────

export interface WgPeerStatus {
  name: string;
  public_key: string | null;
  endpoint: string | null;
  allowed_ips: string | null;
  latest_handshake: string | null;
  transfer: string | null;
  status: string | null;
  keepalive: string | null;
}

export interface WgInterfaceStatus {
  name: string;
  public_key: string | null;
  listening_port: string | null;
  address: string | null;
  peers: WgPeerStatus[];
}

/// Parse `show interfaces wireguard` (`wg`-style blocks). An `interface:` line
/// opens an interface; an indented `peer:` line opens a peer under it; the
/// `key: value` lines beneath fill fields. Unknown fields are ignored, so extra
/// lines on a future release don't break the parse.
export function parseWireguardStatus(text: string): WgInterfaceStatus[] {
  const out: WgInterfaceStatus[] = [];
  let iface: WgInterfaceStatus | null = null;
  let peer: WgPeerStatus | null = null;

  const kv = (line: string): [string, string] | null => {
    const idx = line.indexOf(":");
    if (idx < 0) return null;
    return [line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim()];
  };

  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const parsed = kv(line);
    if (!parsed) continue;
    const [key, value] = parsed;

    if (key === "interface") {
      iface = { name: value, public_key: null, listening_port: null, address: null, peers: [] };
      peer = null;
      out.push(iface);
      continue;
    }
    if (key === "peer") {
      if (!iface) continue;
      peer = { name: value, public_key: null, endpoint: null, allowed_ips: null, latest_handshake: null, transfer: null, status: null, keepalive: null };
      iface.peers.push(peer);
      continue;
    }
    const val = value || null;
    if (peer) {
      if (key === "public key") peer.public_key = val;
      else if (key === "endpoint") peer.endpoint = val;
      else if (key === "allowed ips") peer.allowed_ips = val;
      else if (key === "latest handshake") peer.latest_handshake = val;
      else if (key === "transfer") peer.transfer = val;
      else if (key === "status") peer.status = val;
      else if (key === "persistent keepalive") peer.keepalive = val;
    } else if (iface) {
      if (key === "public key") iface.public_key = val;
      else if (key === "listening port") iface.listening_port = val;
      else if (key === "address") iface.address = val;
    }
  }
  return out;
}
