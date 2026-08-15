"use client";

// SSL Inspection — WatchGuard-style Content Inspection built on Squid ssl_bump.
//
// Squid is the SOLE TLS terminator on the box: it owns ssl_bump, the CA, the
// private key, and the generated-cert store (see
// quartzfire-ssl-inspection/docs/design.md). This page manages the enable
// toggle, the inspection CA, the inspection policy + do-not-inspect list, the
// interface scope, and surfaces build/health status. Config edits are real
// VyOS config (`service quartzfire ssl-inspection …`) committed under
// commit-confirm.
//
// The Content Filter section is intentionally INERT: no filtering engine is
// attached yet. It shows the ICAP seam a future e2guardian/c-icap layer plugs
// into — that engine runs behind Squid over ICAP in plaintext and must never
// do its own TLS MITM. Do not implement filtering logic here.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { useColumnResize } from "@/components/dashboard/ColumnResize";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { useDashboard } from "@/lib/DashboardContext";
import { emptyFirewallConfig, fetchFirewall, FirewallConfig } from "@/lib/firewall";
import {
  applySslInspection,
  caCrtUrl,
  caDerUrl,
  caDistUrl,
  emptySslInspectionConfig,
  fetchSslInspection,
  fetchSslStatus,
  regenerateCa,
  setSslEnabled,
  SslInspectionConfig,
  SslPolicyAction,
  SslStatusReport,
  validateDomainPattern,
} from "@/lib/ssl-inspection";

/// Clarity status pill (mono uppercase), per the design reference.
const pillStyle = { fontFamily: "var(--qz-font-mono)", letterSpacing: "0.06em" } as const;

// ── status indicators ───────────────────────────────────────────────────────

function Indicator({ label, state, detail }: { label: string; state: "ok" | "warn" | "muted"; detail?: string }) {
  const cls = state === "ok" ? "badge-ok" : state === "warn" ? "badge-warn" : "badge-muted";
  return (
    <div className="flex flex-col gap-1">
      <span className="clr-smallcaption">{label}</span>
      <span className={`badge ${cls}`} title={detail}>
        {detail ?? (state === "ok" ? "Yes" : state === "warn" ? "No" : "—")}
      </span>
    </div>
  );
}

function StatusCard({ status }: { status: SslStatusReport | null }) {
  const squid = status?.squid;
  const icap = status?.icap;
  const boolState = (b: boolean | null | undefined): "ok" | "warn" | "muted" =>
    b === true ? "ok" : b === false ? "warn" : "muted";

  return (
    <section className="card">
      <div className="card-header">System Status</div>
      <div className="card-block flex flex-col gap-3">
        <div className="flex flex-wrap gap-6">
          <Indicator label="Squid running" state={boolState(squid?.running)} />
          <Indicator
            label="Bump-capable build"
            state={boolState(squid?.bump_capable)}
            detail={squid?.bump_capable === false ? "squid-openssl missing" : undefined}
          />
          <Indicator label="ICAP-capable build" state={boolState(squid?.icap_capable)} />
          <Indicator label="Certgen DB" state={boolState(status?.certgen_db_ready)} />
          <Indicator
            label="Content filter (ICAP)"
            state={icap?.configured ? boolState(icap.reachable) : "muted"}
            detail={
              icap?.configured
                ? icap.reachable
                  ? `Reachable (${icap.endpoint})`
                  : `Unreachable (${icap.endpoint})`
                : "No filter engine configured"
            }
          />
        </div>
        {status?.apply && !status.apply.ok && status.apply.error && (
          <div className="alert alert-danger alert-sm">
            <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
            <div className="alert-text">{status.apply.error}</div>
          </div>
        )}
        {squid?.bump_capable === false && (
          <div className="alert alert-danger alert-sm">
            <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
            <div className="alert-text">
              This Squid was built without OpenSSL ssl_bump support. Install the
              <span className="mono"> squid-openssl</span> package — inspection cannot work otherwise.
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// ── CA panel ────────────────────────────────────────────────────────────────

function CaPanel({
  status,
  onRegenerate,
  regenerating,
}: {
  status: SslStatusReport | null;
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  const ca = status?.ca;
  const [copied, setCopied] = useState(false);
  // Prefer the resolved LAN IP of the CA-download interface (where clients
  // actually reach :4126); fall back to the address the admin browsed in on.
  const fallbackHost = typeof window !== "undefined" ? window.location.hostname : "your-firewall";
  const host = status?.ca_download?.addresses?.[0] ?? fallbackHost;

  const copyFp = async () => {
    if (!ca?.fingerprint_sha256) return;
    try {
      await navigator.clipboard.writeText(ca.fingerprint_sha256);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  };

  const label = (text: string) => <span style={{ color: "var(--cds-alias-typography-color-200)" }}>{text}</span>;
  const mono = { fontFamily: "var(--qz-font-mono)", color: "var(--cds-alias-typography-color-400)" } as const;

  return (
    <section className="card">
      <div className="card-header">
        Inspection CA
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <a href={ca?.present ? caCrtUrl : undefined} download>
            <button type="button" className="btn btn-sm" disabled={!ca?.present} style={{ margin: 0 }}>
              Download Certificate
            </button>
          </a>
          <button
            type="button"
            className="btn btn-sm btn-warning-outline"
            onClick={onRegenerate}
            disabled={regenerating}
            style={{ margin: 0 }}
          >
            {regenerating ? "Regenerating…" : "Regenerate"}
          </button>
        </span>
      </div>
      <div
        className="card-block"
        style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 24px", fontSize: 13 }}
      >
        {!ca?.present ? (
          <p className="text-[13px] text-[var(--cds-alias-typography-color-300)] m-0" style={{ gridColumn: "1 / -1" }}>
            No CA generated yet. Enabling SSL inspection generates a self-signed root CA
            (<span className="mono">CN=QuartzFire SSL Inspection, O=Quartz Systems</span>).
          </p>
        ) : (
          <>
            {label("Subject")}
            <span style={mono}>{ca.subject ?? "—"}</span>
            {label("Fingerprint")}
            <span style={{ ...mono, wordBreak: "break-all" }}>
              SHA-256 {ca.fingerprint_sha256 ?? "—"}
              {ca.fingerprint_sha256 && (
                <>
                  {" "}
                  <button
                    type="button"
                    onClick={copyFp}
                    className="btn btn-sm btn-link"
                    style={{ margin: 0, minWidth: 0, padding: "0 4px" }}
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </>
              )}
            </span>
            {label("Validity")}
            <span style={mono}>
              {ca.not_before ?? "—"} → {ca.not_after ?? "—"}
            </span>
            {label("Distribution")}
            <span style={{ color: "var(--cds-alias-typography-color-300)" }}>
              Install this CA on every inspected client, or TLS breaks visibly — that is the point. Clients
              fetch it from{" "}
              <a
                className="underline"
                style={{ color: "var(--cds-alias-typography-link-color)" }}
                href={caDistUrl(host)}
                target="_blank"
                rel="noreferrer"
              >
                {caDistUrl(host)}
              </a>{" "}
              (plain HTTP, trusted interfaces only), or as{" "}
              <a className="underline" style={{ color: "var(--cds-alias-typography-link-color)" }} href={caDerUrl} download>
                DER
              </a>
              . The private key never leaves the box.
            </span>
          </>
        )}
      </div>
    </section>
  );
}

// ── exclusions (do-not-inspect) card ─────────────────────────────────────────

/// Add one do-not-inspect destination (mock: "Add SSL Exclusion").
function AddExclusionModal({
  existing,
  onClose,
  onAdd,
}: {
  existing: string[];
  onClose: () => void;
  onAdd: (domain: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const d = draft.trim().toLowerCase();
    if (!d) return;
    const v = validateDomainPattern(d);
    if (v) {
      setErr(v);
      return;
    }
    if (existing.includes(d)) {
      setErr("Already in the list.");
      return;
    }
    onAdd(d);
  };

  return (
    <ModalShell onClose={onClose} maxWidth={460}>
      <ModalHeader title="Add SSL Exclusion" onClose={onClose} />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="clr-form-control" style={{ marginTop: 0 }}>
          <label className="clr-control-label">Destination *</label>
          <input
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setErr(null);
            }}
            placeholder="*.bank.example"
            autoFocus
            className="clr-input"
            style={{ maxWidth: "none", width: "100%", fontFamily: "var(--qz-font-mono)" }}
          />
          <div className="clr-subtext">SNI pattern or FQDN — matching flows are spliced, never decrypted.</div>
        </div>
        {err && (
          <p className="text-[12px] m-0" style={{ color: "var(--cds-alias-status-danger)" }}>
            {err}
          </p>
        )}
        <ModalFooter>
          <button type="button" className="btn btn-neutral" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!draft.trim()}>
            Add Exclusion
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}

/// The mock's Exclusions card: compact table of do-not-inspect destinations
/// with the add button in the card header. Edits go to the page draft and are
/// committed by the Apply Changes row below the settings cards.
function ExclusionsCard({
  domains,
  baseline,
  onChange,
  onBaselineChange,
}: {
  domains: string[];
  baseline: boolean;
  onChange: (next: string[]) => void;
  onBaselineChange: (v: boolean) => void;
}) {
  const [adding, setAdding] = useState(false);

  return (
    <section className="card">
      <div className="card-header">
        Exclusions
        <span style={{ marginLeft: "auto" }}>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setAdding(true)} style={{ margin: 0 }}>
            Add Exclusion
          </button>
        </span>
      </div>
      <table className="table table-noborder table-compact" style={{ width: "100%" }}>
        <thead>
          <tr>
            <th>Destination</th>
            <th style={{ width: 60 }} aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {domains.length === 0 ? (
            <tr>
              <td colSpan={2} className="text-center" style={{ color: "var(--cds-alias-typography-color-200)" }}>
                No custom exclusions — the shipped baseline still applies while enabled below.
              </td>
            </tr>
          ) : (
            domains.map((d) => (
              <tr key={d}>
                <td className="mono">{d}</td>
                <td className="text-right">
                  <button
                    type="button"
                    title={`Remove ${d}`}
                    aria-label={`Remove ${d}`}
                    onClick={() => onChange(domains.filter((x) => x !== d))}
                    className="btn btn-sm btn-link-neutral btn-icon"
                  >
                    <Icon shape="trash" size={14} />
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <div className="card-block" style={{ borderTop: "1px solid var(--cds-alias-object-border-subtle)" }}>
        <label className="clr-checkbox-wrapper cursor-pointer">
          <input type="checkbox" checked={baseline} onChange={(e) => onBaselineChange(e.target.checked)} />
          <span className="text-[13px] text-[var(--cds-alias-typography-color-400)]">
            Apply the shipped baseline (banking, healthcare, government, cert-pinned/update endpoints)
          </span>
        </label>
      </div>

      {adding && (
        <AddExclusionModal
          existing={domains}
          onClose={() => setAdding(false)}
          onAdd={(d) => {
            onChange([...domains, d]);
            setAdding(false);
          }}
        />
      )}
    </section>
  );
}

// ── policies tab (per firewall rule) ─────────────────────────────────────────

/// One row per eligible forward Allow rule, with an inspect / splice / none
/// picker — mirrors the Application Control Policies tab so attaching inspection
/// to a rule is discoverable (and so enabling has something to intercept). Each
/// change commits immediately, like the App Control page.
/** Resizable columns of the Policies tab's rules table. */
const SSL_RULE_COLS = [
  { key: "rule", header: "#", width: 60, minWidth: 40 },
  { key: "name", header: "Name" },
  { key: "fromto", header: "From → To", width: 150 },
  { key: "action", header: "Action", width: 90 },
  { key: "ssl", header: "SSL inspection", width: 200 },
];

function PoliciesTab({
  config,
  status,
  onApplied,
  setToast,
}: {
  config: SslInspectionConfig;
  status: SslStatusReport | null;
  onApplied: () => Promise<void>;
  setToast: (msg: string) => void;
}) {
  const resize = useColumnResize("ssl-rules", SSL_RULE_COLS);
  const [fw, setFw] = useState<FirewallConfig>(emptyFirewallConfig);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [busyRule, setBusyRule] = useState<number | null>(null);

  const loadFw = useCallback(async () => {
    try {
      setFw(await fetchFirewall());
      setState("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load the firewall config.");
      setState("error");
    }
  }, []);
  useEffect(() => {
    loadFw();
  }, [loadFw]);

  const actionByRule = useMemo(() => {
    const m = new Map<number, SslPolicyAction>();
    for (const p of config.policies) if (p.enabled) m.set(p.rule, p.action);
    return m;
  }, [config.policies]);

  const problemFor = (rule: number) => status?.problems?.find((p) => p.policy === rule)?.error ?? null;

  const setRule = async (rule: number, choice: "off" | SslPolicyAction) => {
    const policies = config.policies.filter((p) => p.rule !== rule);
    if (choice !== "off") policies.push({ rule, ruleset: "forward", action: choice, enabled: true });
    policies.sort((a, b) => a.rule - b.rule);
    setBusyRule(rule);
    try {
      await applySslInspection(config, { ...config, policies });
      setToast(
        choice === "off"
          ? `Removed SSL inspection from rule ${rule}.`
          : `Rule ${rule} set to ${choice === "inspect" ? "Inspect" : "Splice"}.`,
      );
      await onApplied();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to change the inspection policy.");
    } finally {
      setBusyRule(null);
    }
  };

  if (state === "loading") return <div className="text-[13px] text-[var(--cds-alias-typography-color-200)]">Loading firewall rules…</div>;
  if (state === "error")
    return (
      <div className="flex flex-col gap-3">
        <div className="alert alert-danger alert-sm">
          <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
          <div className="alert-text">{errorMsg}</div>
        </div>
        <div>
          <Button kind="secondary" icon="refresh" onClick={loadFw}>
            Retry
          </Button>
        </div>
      </div>
    );

  const eligible = fw.rules.filter((r) => r.chain === "forward" && r.action === "accept");

  return (
    <div className="flex flex-col gap-3">
      <section className="card">
        <div className="card-header">Rule Bindings</div>
        <table ref={resize.tableRef} className="table table-noborder" style={{ width: "100%", tableLayout: resize.tableLayout }}>
          <colgroup>
            {SSL_RULE_COLS.map((c) => (
              <col key={c.key} style={{ width: resize.colWidth(c.key) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {SSL_RULE_COLS.map((c, i) => (
                <th key={c.key} {...resize.thProps(i)}>
                  {c.header}
                  {resize.handle(i)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {eligible.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center text-[var(--cds-alias-typography-color-200)]" style={{ cursor: "default" }}>
                  No eligible forward Allow rules — create them under{" "}
                  <Link href="/firewall/rules" className="text-[var(--cds-alias-typography-color-300)]">
                    Firewall → Rules
                  </Link>
                  .
                </td>
              </tr>
            ) : (
              eligible.map((r) => {
                const value = actionByRule.get(r.rule) ?? "off";
                const problem = problemFor(r.rule);
                return (
                  <tr key={r.rule} style={{ cursor: "default", opacity: r.enabled ? 1 : 0.55 }}>
                    <td className="mono text-[var(--cds-alias-typography-color-300)]">{r.rule}</td>
                    <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.name ?? <span className="text-[var(--cds-alias-typography-color-200)]">Rule {r.rule}</span>}
                    </td>
                    <td className="mono text-[12px] text-[var(--cds-alias-typography-color-300)]">
                      {(r.from.iface ?? "any") + " → " + (r.to.iface ?? "any")}
                    </td>
                    <td>
                      <span className="badge badge-ok">Allow</span>
                    </td>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="clr-select-wrapper" style={{ maxWidth: "none", flex: 1 }}>
                          <select
                            value={value}
                            disabled={busyRule !== null}
                            onChange={(e) => setRule(r.rule, e.target.value as "off" | SslPolicyAction)}
                            className="clr-select"
                            style={{ maxWidth: "none", color: value === "off" ? "var(--cds-alias-typography-color-200)" : "var(--cds-alias-interaction-action)" }}
                          >
                            <option value="off">None</option>
                            <option value="inspect">Inspect</option>
                            <option value="splice">Splice</option>
                          </select>
                        </div>
                        {problem && (
                          <span className="badge badge-warn flex-shrink-0" title={problem}>
                            Not Enforced
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </section>

      <div style={{ fontSize: 12, color: "var(--cds-alias-typography-color-200)" }}>
        Attach SSL inspection to a forward Allow rule to decrypt (<span className="mono">Inspect</span>)
        or explicitly spare (<span className="mono">Splice</span>) the HTTPS it matches. Only forward
        Allow rules are eligible. SSL inspection won&apos;t enable until at least one rule is set to
        Inspect. Rules that match on an outbound interface can&apos;t carry inspection — scope by
        source or destination instead.
      </div>
    </div>
  );
}

// ── confirm modal ────────────────────────────────────────────────────────────

/// Themed replacement for window.confirm on the high-blast-radius actions
/// (enabling interception, regenerating the CA). Styled to the console theme
/// so the warning reads inside the app instead of a bare browser dialog.
function ConfirmModal({
  title,
  subtitle,
  tone = "warn",
  confirmLabel,
  onCancel,
  onConfirm,
  children,
}: {
  title: string;
  subtitle?: string;
  tone?: "warn" | "danger";
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
  children: React.ReactNode;
}) {
  const [working, setWorking] = useState(false);
  // While the action is in flight, ignore backdrop/Escape closes so the modal
  // stays put until the device answers (parent unmounts it on completion).
  const close = () => {
    if (!working) onCancel();
  };
  const run = async () => {
    setWorking(true);
    try {
      await onConfirm();
    } finally {
      setWorking(false);
    }
  };
  return (
    <ModalShell onClose={close} maxWidth={460}>
      <ModalHeader title={title} subtitle={subtitle} onClose={close} />
      <div className="flex flex-col gap-4">
        <div className={`alert ${tone === "danger" ? "alert-danger" : "alert-warning"}`}>
          <Icon shape={tone === "danger" ? "exclamation-triangle" : "shield-x"} size={16} className="alert-icon" />
          <div className="alert-text flex flex-col gap-2 [&_p]:m-0">{children}</div>
        </div>
        <ModalFooter>
          <button type="button" className="btn btn-neutral" onClick={close} disabled={working}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${tone === "danger" ? "btn-danger" : "btn-warning"}`}
            onClick={run}
            disabled={working}
          >
            {working ? "Working…" : confirmLabel}
          </button>
        </ModalFooter>
      </div>
    </ModalShell>
  );
}

// ── page ────────────────────────────────────────────────────────────────────

export default function SslInspectionPage() {
  const { setToast } = useDashboard();
  const [config, setConfig] = useState<SslInspectionConfig>(emptySslInspectionConfig);
  const [draft, setDraft] = useState<SslInspectionConfig>(emptySslInspectionConfig);
  const [status, setStatus] = useState<SslStatusReport | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  // Which high-blast-radius action is awaiting an in-app confirmation, if any.
  const [confirm, setConfirm] = useState<"enable" | "regenerate" | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      setStatus((await fetchSslStatus()).status);
    } catch {
      /* status is best-effort; the config still renders */
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const cfg = await fetchSslInspection();
      setConfig(cfg);
      setDraft(cfg);
      setPhase("ready");
      await loadStatus();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load the SSL inspection config.");
      setPhase("error");
    }
  }, [loadStatus]);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = useMemo(() => JSON.stringify(config) !== JSON.stringify(draft), [config, draft]);

  const applyEnabled = async (enabled: boolean) => {
    setToggling(true);
    try {
      await setSslEnabled(config, enabled);
      setToast(enabled ? "SSL inspection enabled." : "SSL inspection disabled.");
      await load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to change the enable state.");
    } finally {
      setToggling(false);
    }
  };

  const onToggle = async (enabled: boolean) => {
    // Enabling starts intercepting LAN HTTPS immediately. Any client that has
    // not installed the QuartzFire CA will get certificate errors and be unable
    // to load HTTPS sites, so require an explicit acknowledgement first via the
    // themed confirm modal. Disabling is safe and applies straight away.
    if (enabled) {
      setConfirm("enable");
      return;
    }
    await applyEnabled(false);
  };

  const onSave = async () => {
    setSaving(true);
    try {
      const n = await applySslInspection(config, draft);
      setToast(n === 0 ? "No changes to apply." : "SSL inspection settings applied.");
      await load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to apply the settings.");
    } finally {
      setSaving(false);
    }
  };

  const applyRegenerate = async () => {
    setRegenerating(true);
    try {
      await regenerateCa();
      setToast("CA regeneration requested. Re-distribute the new certificate to clients.");
      // The root helper regenerates asynchronously; poll a few times.
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 1200));
        await loadStatus();
      }
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to request CA regeneration.");
    } finally {
      setRegenerating(false);
    }
  };

  if (phase === "loading") {
    return <div className="text-[13px] text-[var(--cds-alias-typography-color-200)]">Loading…</div>;
  }
  if (phase === "error") {
    return (
      <div className="alert alert-danger alert-sm">
        <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
        <div className="alert-text">{errorMsg}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <div className="mr-auto">
          <h2 className="m-0">SSL Inspection</h2>
          <p className="clr-secondary" style={{ marginTop: 4 }}>
            Decrypt, inspect, and re-encrypt TLS on forward Allow rules that opt in.
          </p>
        </div>
        <span className="flex items-center gap-2 pt-1">
          <span className={`label${config.enabled ? " label-success" : ""}`} style={pillStyle}>
            {config.enabled ? "ENABLED" : "DISABLED"}
          </span>
          <span aria-disabled={toggling} style={{ opacity: toggling ? 0.5 : 1 }}>
            <Switch on={config.enabled} onChange={onToggle} />
          </span>
          <button type="button" className="btn" onClick={() => load()}>
            Refresh
          </button>
        </span>
      </div>

      {/* DC page order: CA card → Rule Bindings → Exclusions; the status card
          leads (alerts/tiles slot) and the extra config cards follow. */}
      <div className="flex flex-col gap-4 max-w-[1000px]">
        <StatusCard status={status} />
        <CaPanel status={status} onRegenerate={() => setConfirm("regenerate")} regenerating={regenerating} />
        <PoliciesTab config={config} status={status} onApplied={load} setToast={setToast} />
        <ExclusionsCard
          domains={draft.noInspect}
          baseline={draft.defaultExclusions}
          onChange={(next) => setDraft((d) => ({ ...d, noInspect: next }))}
          onBaselineChange={(v) => setDraft((d) => ({ ...d, defaultExclusions: v }))}
        />

        {/* Inspection policy */}
        <section className="card">
          <div className="card-header">Inspection Policy</div>
          <div className="card-block flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <span className="clr-smallcaption">Default action</span>
              <Segmented
                items={[
                  { value: "inspect", label: "Inspect all" },
                  { value: "splice", label: "Splice all" },
                ]}
                value={draft.defaultAction}
                onChange={(v) => setDraft((d) => ({ ...d, defaultAction: v as "inspect" | "splice" }))}
              />
              <span className="text-[12px] text-[var(--cds-alias-typography-color-200)]">
                Traffic not on the do-not-inspect list is {draft.defaultAction === "inspect" ? "decrypted" : "passed through"}.
              </span>
            </div>

            <div className="flex flex-col gap-2">
              <span className="clr-smallcaption">
                Upstream certificate validation
              </span>
              <Segmented
                items={[
                  { value: "block", label: "Block invalid" },
                  { value: "allow", label: "Allow invalid" },
                ]}
                value={draft.upstreamInvalid}
                onChange={(v) => setDraft((d) => ({ ...d, upstreamInvalid: v as "block" | "allow" }))}
              />
            </div>
          </div>
        </section>

        {/* Applies the draft: policy settings and the Exclusions card above. */}
        <div className="flex items-center gap-2">
          <Button kind="primary" size="sm" onClick={onSave} disabled={!dirty || saving}>
            {saving ? "Applying…" : "Apply Changes"}
          </Button>
          {dirty && (
            <Button kind="secondary" size="sm" onClick={() => setDraft(config)} disabled={saving}>
              Discard
            </Button>
          )}
        </div>

        {/* Content filter — inert seam */}
        <section className="card opacity-90">
          <div className="card-header">
            Content Filter (ICAP)
            <span className="badge badge-muted">Not attached</span>
          </div>
          <div className="card-block flex flex-col gap-3">
            <p className="text-[13px] text-[var(--cds-alias-typography-color-300)] m-0">
              No content-filtering engine is attached yet. When one is added (e2guardian in ICAP mode, or
              c-icap/ClamAV), it runs <em>behind</em> Squid and receives already-decrypted plaintext HTTP —
              it never does its own TLS interception and never holds its own CA. These fields are the seam it
              will plug into.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="clr-form-control" style={{ marginTop: 0 }}>
                <label className="clr-control-label">ICAP host</label>
                <input disabled value={draft.contentFilter?.icapHost ?? "127.0.0.1"} className="clr-input" style={{ maxWidth: "none", fontFamily: "var(--qz-font-mono)" }} />
              </div>
              <div className="clr-form-control" style={{ marginTop: 0 }}>
                <label className="clr-control-label">ICAP port</label>
                <input disabled value={draft.contentFilter?.icapPort ?? 1344} className="clr-input" style={{ maxWidth: "none", fontFamily: "var(--qz-font-mono)" }} />
              </div>
              <div className="clr-form-control" style={{ marginTop: 0 }}>
                <label className="clr-control-label">Fail mode</label>
                <input disabled value={draft.contentFilter?.failMode ?? "closed (fail closed)"} className="clr-input" style={{ maxWidth: "none", fontFamily: "var(--qz-font-mono)" }} />
              </div>
            </div>
          </div>
        </section>
      </div>

      {confirm === "enable" && (
        <ConfirmModal
          title="Enable SSL Inspection?"
          tone="warn"
          confirmLabel="Enable Inspection"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            setConfirm(null);
            await applyEnabled(true);
          }}
        >
          <p>
            Outbound HTTPS matched by your inspection policies will be intercepted and re-signed with
            the QuartzFire inspection CA. Any client that does <strong>not</strong> trust this CA will
            get certificate errors and be unable to load HTTPS sites.
          </p>
          <p>
            Make sure the inspection CA has already been distributed to and installed on your clients
            (download it from the Inspection CA card) before enabling.
          </p>
        </ConfirmModal>
      )}

      {confirm === "regenerate" && (
        <ConfirmModal
          title="Regenerate the Inspection CA?"
          tone="danger"
          confirmLabel="Regenerate CA"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            setConfirm(null);
            await applyRegenerate();
          }}
        >
          <p>
            All previously distributed CAs become <strong>invalid</strong> — every client must
            reinstall the new certificate before it can browse HTTPS through the firewall.
          </p>
        </ConfirmModal>
      )}
    </div>
  );
}
