"use client";

// System → Management: QuartzCommand cloud enrollment + control channel.
//
// Status polls the backend merge of qfagent's status/state files; settings
// and enrollment go through the VyOS proxy (enrollment is a synchronous
// config commit — see lib/quartz-command.ts).

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Cloud, RotateCw } from "lucide-react";
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
    <div className="flex items-start gap-4 py-[9px]" style={{ borderBottom: "1px solid var(--qz-border)" }}>
      <span className="text-[12px] text-[var(--qz-fg-4)] w-[200px] flex-shrink-0 pt-[1px]">{label}</span>
      <span className="text-[13px] text-[var(--qz-fg-1)] min-w-0">{children}</span>
    </div>
  );
}

function Section({ title, action, children }: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      className="rounded-lg px-5 pt-2 pb-3"
      style={{ background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" }}
    >
      <div className="flex items-center justify-between py-2">
        <h2 className="text-[15px] font-semibold text-[var(--qz-fg-1)] m-0">{title}</h2>
        {action}
      </div>
      {children}
    </section>
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
      return <span className="badge badge-ok">Connected</span>;
    case "connecting":
      return <span className="badge badge-muted">Connecting…</span>;
    case "backoff":
      return <span className="badge badge-warn">Reconnecting (backoff)</span>;
    case "host-mismatch":
      return <span className="badge badge-danger">Refused — identity/host mismatch</span>;
    case "unenrolled":
      return <span className="badge badge-muted">Not started (unenrolled)</span>;
    default:
      return <span className="badge badge-muted">Unknown (agent not running?)</span>;
  }
}

const inputCls =
  "w-full rounded-md px-3 py-[7px] text-[13px] text-[var(--qz-fg-1)] outline-none";
const inputStyle: React.CSSProperties = {
  background: "var(--qz-bg)",
  border: "1px solid var(--qz-border)",
  fontFamily: "var(--qz-font-mono)",
};

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
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          Management
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Quartz Command cloud management — enrollment and the control channel
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {phase === "loading" && (
          <div className="text-[13px] text-[var(--qz-fg-4)]">Loading cloud management state…</div>
        )}
        {phase === "error" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-[13px] text-[var(--qz-danger)]">
              <AlertTriangle size={15} />
              {errorMsg}
            </div>
            <div>
              <Button kind="secondary" icon={RotateCw} onClick={load}>Retry</Button>
            </div>
          </div>
        )}
        {phase === "ready" && (
          <div className="flex flex-col gap-7">
            {(live?.flags?.length ?? 0) > 0 && (
              <div
                className="rounded-lg px-4 py-3 flex flex-col gap-1 text-[13px]"
                style={{ border: "1px solid var(--qz-danger)", color: "var(--qz-danger)" }}
              >
                {live!.flags.map((f) => (
                  <div key={f} className="flex items-center gap-2">
                    <AlertTriangle size={15} className="flex-shrink-0" />
                    {f}
                  </div>
                ))}
              </div>
            )}

            <Section
              title="Status"
              action={
                <Button kind="secondary" size="sm" icon={RotateCw} onClick={() => void loadStatus()}>
                  Refresh
                </Button>
              }
            >
              <InfoRow label="Enrollment">
                {enrolled ? (
                  <span className="badge badge-ok">Enrolled</span>
                ) : (
                  <span className="badge badge-muted">Not enrolled</span>
                )}
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
                      expires {fmtUnix(live?.cert_not_after_unix ?? state?.cert_not_after_unix ?? null)}
                      {live?.cert_renewal_alarm && (
                        <span className="badge badge-danger">renewal failing — expires in &lt;7 days</span>
                      )}
                    </span>
                  </InfoRow>
                </>
              )}
              <InfoRow label="Control Channel">
                <span className="flex items-center gap-2 flex-wrap">
                  {controlBadge(live?.control)}
                  {live?.control === "connected" && live.control_since_unix && (
                    <span className="text-[var(--qz-fg-4)]">since {fmtUnix(live.control_since_unix)}</span>
                  )}
                </span>
              </InfoRow>
              {live?.last_error && (
                <InfoRow label="Last Error">
                  <span className="text-[var(--qz-danger)]">{live.last_error}</span>
                </InfoRow>
              )}
            </Section>

            {!enrolled && (
              <Section title="Enroll">
                <p className="text-[13px] text-[var(--qz-fg-4)] mt-1 mb-3">
                  Paste an enrollment token issued by your Quartz Command controller
                  (QC1|…). Enrollment runs as a config commit: the token is consumed
                  once and removed from the configuration automatically.
                </p>
                <textarea
                  className={inputCls}
                  style={{ ...inputStyle, minHeight: 64, resize: "vertical" }}
                  placeholder="QC1|gateway.example.com:443|org_…|token_id.secret|sha256:…"
                  value={token}
                  onChange={(e) => { setToken(e.target.value); setEnrollError(null); }}
                  disabled={enrolling}
                  spellCheck={false}
                />
                {tokenCheck && !tokenCheck.ok && (
                  <p className="text-[12px] text-[var(--qz-danger)] mt-2 mb-0">{tokenCheck.error}</p>
                )}
                {tokenCheck?.ok && (
                  <p className="text-[12px] text-[var(--qz-fg-4)] mt-2 mb-0">
                    Gateway {tokenCheck.token.gatewayHost}:{tokenCheck.token.gatewayPort} · org{" "}
                    {tokenCheck.token.orgId}
                  </p>
                )}
                {enrollError && (
                  <div className="flex items-start gap-2 text-[13px] text-[var(--qz-danger)] mt-2">
                    <AlertTriangle size={15} className="flex-shrink-0 mt-[2px]" />
                    <span>{enrollError}</span>
                  </div>
                )}
                <div className="mt-3">
                  <Button
                    icon={Cloud}
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
                  {saving ? "Saving…" : "Save settings"}
                </Button>
              }
            >
              <p className="text-[13px] text-[var(--qz-fg-4)] mt-1 mb-3">
                Optional: pre-set the gateway for status display and self-hosted
                controllers. An enrollment token&apos;s gateway always takes
                precedence and is written here after a successful enrollment.
              </p>
              <div className="flex flex-col gap-3 pb-2 max-w-[560px]">
                <label className="flex flex-col gap-1 text-[12px] text-[var(--qz-fg-4)]">
                  Gateway host
                  <input
                    className={inputCls}
                    style={inputStyle}
                    value={gateway}
                    onChange={(e) => setGateway(e.target.value)}
                    placeholder="qc.example.com"
                    spellCheck={false}
                  />
                </label>
                <label className="flex flex-col gap-1 text-[12px] text-[var(--qz-fg-4)]">
                  Port (default 443)
                  <input
                    className={inputCls}
                    style={inputStyle}
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    placeholder="443"
                    inputMode="numeric"
                  />
                </label>
                <label className="flex flex-col gap-1 text-[12px] text-[var(--qz-fg-4)]">
                  CA certificate (PKI name, for controllers without WebPKI certificates)
                  <select
                    className={inputCls}
                    style={inputStyle}
                    value={caCert}
                    onChange={(e) => setCaCert(e.target.value)}
                  >
                    <option value="">None (WebPKI / token fingerprint)</option>
                    {pkiCerts.map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </label>
              </div>
            </Section>

            <Section title="Identity Lifecycle">
              <p className="text-[13px] text-[var(--qz-fg-4)] mt-1 mb-2">
                Destructive identity operations are CLI-only (they sever cloud
                management until re-enrollment):
              </p>
              <InfoRow label="Regenerate identity">
                <span style={{ fontFamily: "var(--qz-font-mono)" }}>qf identity regenerate</span>
                <span className="text-[var(--qz-fg-4)]"> — wipe the device keypair (e.g. after cloning)</span>
              </InfoRow>
              <InfoRow label="Prepare VM template">
                <span style={{ fontFamily: "var(--qz-font-mono)" }}>qf prepare-template</span>
                <span className="text-[var(--qz-fg-4)]"> — wipe identity + machine-id before templating</span>
              </InfoRow>
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}
