// QuartzCommand cloud management data layer (System → Management).
//
// Split personality, mirroring geolocation:
//   * CONFIG (`system quartz-command`: gateway / port / ca-certificate /
//     enroll-token) is real VyOS config shipped by the qfagent package —
//     read and written through the authenticated VyOS proxy. Enrollment IS a
//     config commit: setting `enroll-token` and committing runs the qfagent
//     conf-mode owner synchronously, so enrollment failures come back as the
//     commit error of the very request the UI made (bad token, unreachable
//     gateway, clock skew…), and a successful commit means the device
//     enrolled — the token is then scrubbed from the config by qfagent's
//     root one-shot, never persisted.
//   * STATUS (device ID, org, control channel, cert expiry, host-mismatch
//     flags) comes from the backend's /api/quartz-command/status, which
//     merges qfagent's status.json + state.json.
//
// Writes take the DIRECT commit path like L2TP/DHCP (cloud management does
// not ride the management path an interface change does).

import { apiFetch, vyosApi } from "./api";
import { commitAndSave } from "./interfaces";
import type { VyosCommand, VyosResponse } from "./interfaces";

// ── status (backend merge of qfagent status.json + state.json) ───────────────

export type ControlState =
  | "unenrolled"
  | "host-mismatch"
  | "connecting"
  | "connected"
  | "backoff";

export interface QfAgentLiveStatus {
  time_unix: number;
  enrolled: boolean;
  device_id: string | null;
  org_id: string | null;
  gateway: string | null;
  trust_path: "web-pki" | "pinned-ca" | null;
  cert_not_after_unix: number | null;
  renew_after_unix: number | null;
  cert_renewal_alarm: boolean;
  control: ControlState;
  control_since_unix: number | null;
  last_error: string | null;
  flags: string[];
}

export interface QfAgentState {
  enrolled: boolean;
  device_id: string | null;
  org_id: string | null;
  token_gateway: string | null;
  assigned_gateway: string | null;
  trust_path: "web-pki" | "pinned-ca" | null;
  enrolled_at_unix: number | null;
  cert_not_after_unix: number | null;
  renew_after_unix: number | null;
}

export interface QuartzCommandStatus {
  /// Live daemon status; null until qfagent has run.
  status: QfAgentLiveStatus | null;
  /// Durable enrollment state; null until an identity exists.
  state: QfAgentState | null;
}

export async function fetchQuartzCommandStatus(): Promise<QuartzCommandStatus> {
  return apiFetch<QuartzCommandStatus>("/quartz-command/status");
}

// ── config (VyOS proxy) ───────────────────────────────────────────────────────

export interface QuartzCommandConfig {
  gateway: string | null;
  port: number | null; // null = default 443
  ca_certificate: string | null;
}

type Cfg = Record<string, unknown>;

function childStr(v: Cfg, key: string): string | null {
  const s = v[key];
  return typeof s === "string" && s !== "" ? s : null;
}

export async function fetchQuartzCommandConfig(): Promise<QuartzCommandConfig> {
  const resp = await vyosApi<VyosResponse<Cfg | null>>("retrieve", {
    op: "showConfig",
    path: ["system", "quartz-command"],
  });
  let cfg: Cfg = {};
  if (resp.success) cfg = resp.data ?? {};
  else if (!(resp.error ?? "").toLowerCase().includes("empty")) {
    throw new Error(resp.error || "Device returned an error reading Quartz Command configuration.");
  }
  const portRaw = childStr(cfg, "port");
  const port = portRaw === null ? null : Number(portRaw);
  return {
    gateway: childStr(cfg, "gateway"),
    port: port !== null && Number.isFinite(port) ? port : null,
    ca_certificate: childStr(cfg, "ca-certificate"),
  };
}

/// Names under `pki certificate` (for the ca-certificate picker).
export async function fetchPkiCertificateNames(): Promise<string[]> {
  const resp = await vyosApi<VyosResponse<Cfg | null>>("retrieve", {
    op: "showConfig",
    path: ["pki", "certificate"],
  });
  if (!resp.success || !resp.data) return [];
  return Object.keys(resp.data).sort();
}

const BASE = ["system", "quartz-command"];

/// Diff + commit the connection settings.
export async function saveQuartzCommandSettings(
  live: QuartzCommandConfig,
  update: QuartzCommandConfig,
): Promise<number> {
  const out: VyosCommand[] = [];
  const gw = update.gateway?.trim() || null;
  if (gw !== live.gateway) {
    out.push(
      gw
        ? { op: "set", path: [...BASE, "gateway", gw] }
        : { op: "delete", path: [...BASE, "gateway"] },
    );
  }
  if (update.port !== live.port) {
    out.push(
      update.port !== null
        ? { op: "set", path: [...BASE, "port", String(update.port)] }
        : { op: "delete", path: [...BASE, "port"] },
    );
  }
  const ca = update.ca_certificate?.trim() || null;
  if (ca !== live.ca_certificate) {
    out.push(
      ca
        ? { op: "set", path: [...BASE, "ca-certificate", ca] }
        : { op: "delete", path: [...BASE, "ca-certificate"] },
    );
  }
  return commitAndSave(out);
}

/// Enroll: commit the one-shot token. The commit runs enrollment
/// synchronously in qfagent's conf-mode owner — a rejected token/gateway
/// problem aborts the commit and surfaces here as the thrown error; on
/// success qfagent removes the token from the config automatically.
export async function enrollQuartzCommand(token: string): Promise<void> {
  await commitAndSave([{ op: "set", path: [...BASE, "enroll-token", token.trim()] }]);
}

// ── token pre-flight ──────────────────────────────────────────────────────────
//
// Mirror of qfagent's strict parser (src/token.rs) for instant feedback in
// the form — the device-side parser remains the authority.

export interface ParsedEnrollToken {
  gatewayHost: string;
  gatewayPort: number;
  orgId: string;
  tokenId: string;
}

export function validateEnrollToken(
  raw: string,
): { ok: true; token: ParsedEnrollToken } | { ok: false; error: string } {
  const err = (error: string) => ({ ok: false as const, error });
  if (raw.length === 0) return err("Paste an enrollment token.");
  if (raw.length > 1024) return err("Token is too long — check the paste.");
  // eslint-disable-next-line no-control-regex
  if (!/^[\x21-\x7e]+$/.test(raw)) {
    return err("Token contains whitespace or unusual characters — paste it as a single unbroken line.");
  }
  const segments = raw.split("|");
  if (segments.length !== 5) {
    return err(`Token must have 5 |-separated segments, found ${segments.length}.`);
  }
  if (segments[0] !== "QC1") {
    return err(`Segment 1 (version) must be 'QC1', found '${segments[0]}'.`);
  }
  const gw = segments[1];
  const colon = gw.lastIndexOf(":");
  if (colon <= 0) return err("Segment 2 (gateway) must be host:port.");
  let host = gw.slice(0, colon);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const port = Number(gw.slice(colon + 1));
  if (host === "" ) return err("Segment 2 (gateway) must be host:port.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return err("Segment 2 (gateway) has an invalid port (expected 1-65535).");
  }
  if (segments[2] === "") return err("Segment 3 (org id) is empty.");
  const dot = segments[3].indexOf(".");
  if (dot <= 0 || dot === segments[3].length - 1) {
    return err("Segment 4 (token) must be token_id.secret with both parts non-empty.");
  }
  if (!segments[4].startsWith("sha256:")) {
    return err("Segment 5 (CA fingerprint) must start with 'sha256:'.");
  }
  const hex = segments[4].slice("sha256:".length);
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    return err("Segment 5 (CA fingerprint) must be 64 hex characters after 'sha256:'.");
  }
  return {
    ok: true,
    token: {
      gatewayHost: host,
      gatewayPort: port,
      orgId: segments[2],
      tokenId: segments[3].slice(0, dot),
    },
  };
}
