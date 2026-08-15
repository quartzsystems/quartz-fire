"use client";

// System → Management: QuartzCommand cloud enrollment + control channel.
//
// Status polls the backend merge of qfagent's status/state files; settings
// and enrollment go through the VyOS proxy (enrollment is a synchronous
// config commit — see lib/quartz-command.ts).

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { useDashboard } from "@/lib/DashboardContext";
import {
  ControlState,
  enrollQuartzCommand,
  fetchPkiCertificateNames,
  fetchQuartzCommandConfig,
  fetchQuartzCommandStatus,
  QuartzCommandConfig,
  QuartzCommandStatus,
  saveQuartzCommandSettings,
  validateEnrollToken,
} from "@/lib/quartz-command";

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      className="flex items-start gap-4 py-[9px]"
      style={{ borderBottom: "1px solid var(--cds-alias-object-border-subtle)" }}
    >
      <span
        className="w-[200px] flex-shrink-0 pt-[1px]"
        style={{ fontSize: 12, color: "var(--cds-alias-typography-color-200)" }}
      >
        {label}
      </span>
      <span className="min-w-0" style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>
        {children}
      </span>
    </div>
  );
}

function Section({ title, action, children }: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="card" style={{ maxWidth: 760 }}>
      <div className="card-header">
        {title}
        {action && <span style={{ marginLeft: "auto" }}>{action}</span>}
      </div>
      <div className="card-block" style={{ paddingTop: 4, paddingBottom: 8 }}>{children}</div>
    </div>
  );
}

/// Clarity status pill — mono uppercase label.
function Pill({ tone, children }: { tone?: "success" | "warning" | "danger" | "info"; children: React.ReactNode }) {
  return (
    <span
      className={`label${tone ? ` label-${tone}` : ""}`}
      style={{
        fontFamily: "var(--qz-font-mono)",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        width: "fit-content",
      }}
    >
      {children}
    </span>
  );
}

function fmtUnix(t: number | null): string {
  if (!t) return "—";
  return new Date(t * 1000).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function controlBadge(control: ControlState | undefined): React.ReactNode {
  switch (control) {
    case "connected":
      return <Pill tone="success">Connected</Pill>;
    case "connecting":
      return <Pill>Connecting…</Pill>;
    case "backoff":
      return <Pill tone="warning">Reconnecting</Pill>;
    case "host-mismatch":
      return (
        <>
          <Pill tone="danger">Refused</Pill>
          <span style={{ color: "var(--cds-alias-typography-color-200)" }}>identity/host mismatch</span>
        </>
      );
    case "unenrolled":
      return (
        <>
          <Pill>Not Started</Pill>
          <span style={{ color: "var(--cds-alias-typography-color-200)" }}>(unenrolled)</span>
        </>
      );
    default:
      return (
        <>
          <Pill>Unknown</Pill>
          <span style={{ color: "var(--cds-alias-typography-color-200)" }}>(agent not running?)</span>
        </>
      );
  }
}

export default function ManagementPage() {
  const { setToast } = useDashboard();

  const [status, setStatus] = useState<QuartzCommandStatus | null>(null);
  const [config, setConfig] = useState<QuartzCommandConfig | null>(null);
  const [pkiCerts, setPkiCerts] = useState<string[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  // Settings form (edited copy of config).
  const [gateway, setGateway] = useState("");
  const [port, setPort] = useState("");
  const [caCert, setCaCert] = useState("");
  const [saving, setSaving] = useState(false);

  // Enrollment form.
  const [token, setToken] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const enrollingRef = useRef(false);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await fetchQuartzCommandStatus());
    } catch {
      /* transient — next poll catches up */
    }
  }, []);

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const [st, cfg, certs] = await Promise.all([
        fetchQuartzCommandStatus(),
        fetchQuartzCommandConfig(),
        fetchPkiCertificateNames(),
      ]);
      setStatus(st);
      setConfig(cfg);
      setPkiCerts(certs);
      setGateway(cfg.gateway ?? "");
      setPort(cfg.port === null ? "" : String(cfg.port));
      setCaCert(cfg.ca_certificate ?? "");
      setPhase("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load Quartz Command state.");
      setPhase("error");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Live status poll (10 s) — enrollment/control state changes out-of-band.
  useEffect(() => {
    const t = setInterval(() => { if (!enrollingRef.current) void loadStatus(); }, 10_000);
    return () => clearInterval(t);
  }, [loadStatus]);

  const live = status?.status ?? null;
  const state = status?.state ?? null;
  const enrolled = live?.enrolled ?? state?.enrolled ?? false;
  const deviceId = live?.device_id ?? state?.device_id ?? null;
  const tokenCheck = token.trim() === "" ? null : validateEnrollToken(token.trim());

  async function saveSettings() {
    if (!config) return;
    const portNum = port.trim() === "" ? null : Number(port.trim());
    if (portNum !== null && (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535)) {
      setToast("Port must be 1-65535.");
      return;
    }
    setSaving(true);
    try {
      const n = await saveQuartzCommandSettings(config, {
        gateway: gateway.trim() || null,
        port: portNum,
        ca_certificate: caCert.trim() || null,
      });
      setToast(n === 0 ? "No changes to save." : "Quartz Command settings saved.");
      await load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Saving settings failed.");
    } finally {
      setSaving(false);
    }
  }

  async function enroll() {
    const trimmed = token.trim();
    const check = validateEnrollToken(trimmed);
    if (!check.ok) {
      setEnrollError(check.error);
      return;
    }
    setEnrollError(null);
    setEnrolling(true);
    enrollingRef.current = true;
    try {
      // The commit blocks while the device talks to the controller (up to
      // ~90 s device-side). Errors here ARE the enrollment errors.
      await enrollQuartzCommand(trimmed);
      setToken("");
      setToast(`Enrolled with Quartz Command (org ${check.token.orgId}).`);
      await load();
    } catch (e) {
      setEnrollError(e instanceof Error ? e.message : "Enrollment failed.");
    } finally {
      setEnrolling(false);
      enrollingRef.current = false;
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2>Management</h2>
        <p className="clr-secondary" style={{ marginTop: 4 }}>
          Quartz Command cloud management — enrollment and the control channel
        </p>
      </div>

      {phase === "loading" && <div className="clr-secondary">Loading cloud management state…</div>}
      {phase === "error" && (
        <div className="alert alert-danger alert-sm">
          <Icon shape="exclamation-circle" size={14} className="alert-icon" />
          <div className="alert-text">{errorMsg}</div>
          <div className="alert-actions">
            <button type="button" className="alert-action" onClick={() => void load()}>
              Retry
            </button>
          </div>
        </div>
      )}
      {phase === "ready" && (
        <div className="flex flex-col gap-4">
          {(live?.flags?.length ?? 0) > 0 && (
            <div className="alert alert-danger" style={{ maxWidth: 760 }}>
              <Icon shape="exclamation-triangle" size={16} className="alert-icon" />
              <div className="alert-items">
                {live!.flags.map((f) => (
                  <div key={f} className="alert-item">
                    <div className="alert-text">{f}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <Section
            title="Status"
            action={
              <Button kind="secondary" size="sm" icon="refresh" onClick={() => void loadStatus()}>
                Refresh
              </Button>
            }
          >
            <InfoRow label="Enrollment">
              {enrolled ? <Pill tone="success">Enrolled</Pill> : <Pill>Not enrolled</Pill>}
            </InfoRow>
            <InfoRow label="Device ID">
              <span style={{ fontFamily: "var(--qz-font-mono)" }}>{deviceId ?? "—"}</span>
            </InfoRow>
            {enrolled && (
              <>
                <InfoRow label="Organization">
                  <span style={{ fontFamily: "var(--qz-font-mono)" }}>
                    {live?.org_id ?? state?.org_id ?? "—"}
                  </span>
                </InfoRow>
                <InfoRow label="Gateway">
                  <span style={{ fontFamily: "var(--qz-font-mono)" }}>
                    {live?.gateway ?? state?.assigned_gateway ?? state?.token_gateway ?? "—"}
                  </span>
                </InfoRow>
                <InfoRow label="Trust">
                  {(live?.trust_path ?? state?.trust_path) === "pinned-ca"
                    ? "Pinned CA (from token fingerprint)"
                    : (live?.trust_path ?? state?.trust_path) === "web-pki"
                      ? "WebPKI"
                      : "—"}
                </InfoRow>
                <InfoRow label="Certificate">
                  <span className="flex items-center gap-2 flex-wrap">
                    expires <span className="mono">{fmtUnix(live?.cert_not_after_unix ?? state?.cert_not_after_unix ?? null)}</span>
                    {live?.cert_renewal_alarm && (
                      <>
                        <Pill tone="danger">Renewal Failing</Pill>
                        <span style={{ color: "var(--cds-alias-typography-color-200)" }}>expires in &lt;7 days</span>
                      </>
                    )}
                  </span>
                </InfoRow>
              </>
            )}
            <InfoRow label="Control Channel">
              <span className="flex items-center gap-2 flex-wrap">
                {controlBadge(live?.control)}
                {live?.control === "connected" && live.control_since_unix && (
                  <span style={{ color: "var(--cds-alias-typography-color-200)" }}>
                    since <span className="mono">{fmtUnix(live.control_since_unix)}</span>
                  </span>
                )}
              </span>
            </InfoRow>
            {live?.last_error && (
              <InfoRow label="Last Error">
                <span style={{ color: "var(--cds-alias-status-danger)" }}>{live.last_error}</span>
              </InfoRow>
            )}
          </Section>

          {!enrolled && (
            <Section title="Enroll">
              <div className="clr-form-control">
                <label className="clr-control-label" htmlFor="enroll-token">Enrollment Token</label>
                <textarea
                  id="enroll-token"
                  className="clr-textarea"
                  style={{
                    fontFamily: "var(--qz-font-mono)",
                    maxWidth: "none",
                    minHeight: 64,
                    resize: "vertical",
                  }}
                  placeholder="QC1|gateway.example.com:443|org_…|token_id.secret|sha256:…"
                  value={token}
                  onChange={(e) => { setToken(e.target.value); setEnrollError(null); }}
                  disabled={enrolling}
                  spellCheck={false}
                />
                <p className="clr-subtext" style={{ marginTop: 6, marginBottom: 0 }}>
                  Paste an enrollment token issued by your Quartz Command controller
                  (QC1|…). Enrollment runs as a config commit: the token is consumed
                  once and removed from the configuration automatically.
                </p>
              </div>
              {tokenCheck && !tokenCheck.ok && (
                <p className="m-0" style={{ fontSize: 12, color: "var(--cds-alias-status-danger)", marginTop: 8 }}>
                  {tokenCheck.error}
                </p>
              )}
              {tokenCheck?.ok && (
                <p className="clr-subtext" style={{ marginTop: 8, marginBottom: 0 }}>
                  Gateway {tokenCheck.token.gatewayHost}:{tokenCheck.token.gatewayPort} · org{" "}
                  {tokenCheck.token.orgId}
                </p>
              )}
              {enrollError && (
                <div className="alert alert-danger alert-sm" style={{ marginTop: 8 }}>
                  <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
                  <div className="alert-text">{enrollError}</div>
                </div>
              )}
              <div className="mt-3 pb-2">
                <Button
                  icon="cloud"
                  onClick={() => void enroll()}
                  disabled={enrolling || !tokenCheck?.ok}
                >
                  {enrolling ? "Enrolling… (this can take a minute)" : "Enroll"}
                </Button>
              </div>
            </Section>
          )}

          <Section
            title="Connection Settings"
            action={
              <Button kind="secondary" size="sm" onClick={() => void saveSettings()} disabled={saving}>
                {saving ? "Saving…" : "Save Settings"}
              </Button>
            }
          >
            <p className="clr-secondary" style={{ marginTop: 4, marginBottom: 12 }}>
              Optional: pre-set the gateway for status display and self-hosted
              controllers. An enrollment token&apos;s gateway always takes
              precedence and is written here after a successful enrollment.
            </p>
            <div className="flex flex-col gap-3 pb-2 max-w-[560px]">
              <div className="clr-form-control">
                <label className="clr-control-label">Gateway Host</label>
                <input
                  className="clr-input"
                  style={{ fontFamily: "var(--qz-font-mono)", maxWidth: "none" }}
                  value={gateway}
                  onChange={(e) => setGateway(e.target.value)}
                  placeholder="qc.example.com"
                  spellCheck={false}
                />
              </div>
              <div className="clr-form-control">
                <label className="clr-control-label">Port</label>
                <input
                  className="clr-input"
                  style={{ fontFamily: "var(--qz-font-mono)", maxWidth: "none" }}
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder="443"
                  inputMode="numeric"
                />
                <p className="clr-subtext" style={{ marginTop: 6, marginBottom: 0 }}>Default 443.</p>
              </div>
              <div className="clr-form-control">
                <label className="clr-control-label">CA Certificate</label>
                <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
                  <select
                    className="clr-select"
                    style={{ fontFamily: "var(--qz-font-mono)", maxWidth: "none", width: "100%" }}
                    value={caCert}
                    onChange={(e) => setCaCert(e.target.value)}
                  >
                    <option value="">None (WebPKI / token fingerprint)</option>
                    {pkiCerts.map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </div>
                <p className="clr-subtext" style={{ marginTop: 6, marginBottom: 0 }}>
                  PKI name, for controllers without WebPKI certificates.
                </p>
              </div>
            </div>
          </Section>

          <Section title="Identity Lifecycle">
            <p className="clr-secondary" style={{ marginTop: 4, marginBottom: 8 }}>
              Destructive identity operations are CLI-only (they sever cloud
              management until re-enrollment):
            </p>
            <InfoRow label="Regenerate identity">
              <span style={{ fontFamily: "var(--qz-font-mono)" }}>qf identity regenerate</span>
              <span style={{ color: "var(--cds-alias-typography-color-200)" }}> — wipe the device keypair (e.g. after cloning)</span>
            </InfoRow>
            <InfoRow label="Prepare VM template">
              <span style={{ fontFamily: "var(--qz-font-mono)" }}>qf prepare-template</span>
              <span style={{ color: "var(--cds-alias-typography-color-200)" }}> — wipe identity + machine-id before templating</span>
            </InfoRow>
          </Section>
        </div>
      )}
    </div>
  );
}
