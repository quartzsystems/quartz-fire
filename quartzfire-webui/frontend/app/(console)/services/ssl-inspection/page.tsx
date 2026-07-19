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
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  Plus,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useColumnResize } from "@/components/dashboard/ColumnResize";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { Tabs } from "@/components/ui/Tabs";
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

const inputStyle = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;
const cardStyle = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;

// ── status indicators ───────────────────────────────────────────────────────

function Indicator({ label, state, detail }: { label: string; state: "ok" | "warn" | "muted"; detail?: string }) {
  const cls = state === "ok" ? "badge-ok" : state === "warn" ? "badge-warn" : "badge-muted";
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wide text-[var(--qz-fg-4)]">{label}</span>
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
    <section className="rounded-lg px-5 py-4 flex flex-col gap-3" style={cardStyle}>
      <h2 className="text-[13px] font-semibold text-[var(--qz-fg-1)] m-0">System status</h2>
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
        <div className="flex items-center gap-2 text-[12px] text-[var(--qz-danger)]">
          <AlertTriangle size={13} /> {status.apply.error}
        </div>
      )}
      {squid?.bump_capable === false && (
        <div className="flex items-center gap-2 text-[12px] text-[var(--qz-danger)]">
          <AlertTriangle size={13} /> This Squid was built without OpenSSL ssl_bump support. Install the
          <span className="mono"> squid-openssl</span> package — inspection cannot work otherwise.
        </div>
      )}
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

  const row = (label: string, value: React.ReactNode) => (
    <div className="flex flex-col gap-[2px]">
      <span className="text-[11px] uppercase tracking-wide text-[var(--qz-fg-4)]">{label}</span>
      <span className="text-[13px] text-[var(--qz-fg-1)] break-all">{value}</span>
    </div>
  );

  return (
    <section className="rounded-lg px-5 py-4 flex flex-col gap-4" style={cardStyle}>
      <div className="flex items-center gap-2">
        <ShieldCheck size={16} className="text-[var(--qz-fg-3)]" />
        <h2 className="text-[13px] font-semibold text-[var(--qz-fg-1)] m-0">Inspection Root CA</h2>
      </div>

      {!ca?.present ? (
        <p className="text-[13px] text-[var(--qz-fg-3)] m-0">
          No CA generated yet. Enabling SSL inspection generates a self-signed root CA
          (<span className="mono">CN=QuartzFire SSL Inspection, O=Quartz Systems</span>).
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {row("Subject", ca.subject ?? "—")}
            {row("Serial", <span className="mono text-[12px]">{ca.serial ?? "—"}</span>)}
            {row("Valid from", ca.not_before ?? "—")}
            {row("Valid until", ca.not_after ?? "—")}
          </div>
          <div className="flex flex-col gap-[2px]">
            <span className="text-[11px] uppercase tracking-wide text-[var(--qz-fg-4)]">
              SHA-256 fingerprint
            </span>
            <div className="flex items-center gap-2">
              <span className="mono text-[12px] text-[var(--qz-fg-1)] break-all">
                {ca.fingerprint_sha256 ?? "—"}
              </span>
              {ca.fingerprint_sha256 && (
                <button
                  type="button"
                  onClick={copyFp}
                  className="text-[var(--qz-fg-4)] hover:text-[var(--qz-fg-2)]"
                  title="Copy fingerprint"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              )}
            </div>
          </div>
        </>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <a href={caCrtUrl} download>
          <Button kind="secondary" size="sm" icon={Download} disabled={!ca?.present}>
            Download CA (PEM)
          </Button>
        </a>
        <a href={caDerUrl} download>
          <Button kind="secondary" size="sm" icon={Download} disabled={!ca?.present}>
            Download CA (DER)
          </Button>
        </a>
        <Button kind="danger" size="sm" icon={RotateCw} onClick={onRegenerate} disabled={regenerating}>
          {regenerating ? "Regenerating…" : "Regenerate"}
        </Button>
      </div>

      <p className="text-[12px] text-[var(--qz-fg-4)] m-0">
        Clients install the CA from{" "}
        <a className="text-[var(--qz-info)] underline" href={caDistUrl(host)} target="_blank" rel="noreferrer">
          {caDistUrl(host)}
        </a>{" "}
        (plain HTTP, reachable only on trusted interfaces). The private key never leaves the box.
      </p>
    </section>
  );
}

// ── do-not-inspect editor ───────────────────────────────────────────────────

function NoInspectEditor({
  domains,
  onChange,
}: {
  domains: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const add = () => {
    const d = draft.trim().toLowerCase();
    if (!d) return;
    const e = validateDomainPattern(d);
    if (e) {
      setErr(e);
      return;
    }
    if (domains.includes(d)) {
      setErr("Already in the list.");
      return;
    }
    onChange([...domains, d]);
    setDraft("");
    setErr(null);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setErr(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
          placeholder=".bank.com, *.mozilla.org…"
          className="rounded-md px-3 py-[6px] text-[13px] text-[var(--qz-fg-1)] outline-none w-[240px] mono"
          style={inputStyle}
        />
        <Button kind="secondary" size="sm" icon={Plus} onClick={add}>
          Add
        </Button>
      </div>
      {err && <span className="text-[12px] text-[var(--qz-danger)]">{err}</span>}
      {domains.length === 0 ? (
        <span className="text-[12px] text-[var(--qz-fg-4)]">
          No custom exclusions. (The shipped baseline still applies unless disabled below.)
        </span>
      ) : (
        <div className="flex flex-wrap gap-2">
          {domains.map((d) => (
            <span
              key={d}
              className="inline-flex items-center gap-1 rounded-md px-2 py-[3px] text-[12px] mono text-[var(--qz-fg-1)]"
              style={inputStyle}
            >
              {d}
              <button
                type="button"
                onClick={() => onChange(domains.filter((x) => x !== d))}
                className="text-[var(--qz-fg-4)] hover:text-[var(--qz-danger)]"
                title="Remove"
              >
                <Trash2 size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
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
  { key: "ssl", header: "SSL Inspection", width: 200 },
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

  if (state === "loading") return <div className="text-[13px] text-[var(--qz-fg-4)]">Loading firewall rules…</div>;
  if (state === "error")
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-[13px] text-[var(--qz-danger)]">
          <AlertTriangle size={15} />
          {errorMsg}
        </div>
        <div>
          <Button kind="secondary" icon={RotateCw} onClick={loadFw}>
            Retry
          </Button>
        </div>
      </div>
    );

  const eligible = fw.rules.filter((r) => r.chain === "forward" && r.action === "accept");

  return (
    <div className="flex flex-col gap-3 max-w-[1000px]">
      <p className="text-[13px] text-[var(--qz-fg-4)] m-0">
        Attach SSL inspection to a forward Allow rule to decrypt (<span className="mono">Inspect</span>)
        or explicitly spare (<span className="mono">Splice</span>) the HTTPS it matches. Only forward
        Allow rules are eligible. SSL inspection won&apos;t enable until at least one rule is set to
        Inspect. Rules that match on an outbound interface can&apos;t carry inspection — scope by
        source or destination instead.
      </p>

      <div className="rounded-md overflow-hidden" style={{ border: "1px solid var(--qz-border)" }}>
        <table ref={resize.tableRef} className="qz-table" style={{ width: "100%", tableLayout: resize.tableLayout }}>
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
                <td colSpan={5} className="text-center text-[var(--qz-fg-4)]" style={{ cursor: "default" }}>
                  No eligible forward Allow rules — create them under{" "}
                  <Link href="/firewall/rules" className="text-[var(--qz-fg-3)]">
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
                    <td className="mono text-[var(--qz-fg-3)]">{r.rule}</td>
                    <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.name ?? <span className="text-[var(--qz-fg-4)]">Rule {r.rule}</span>}
                    </td>
                    <td className="mono text-[12px] text-[var(--qz-fg-3)]">
                      {(r.from.iface ?? "any") + " → " + (r.to.iface ?? "any")}
                    </td>
                    <td>
                      <span className="badge badge-ok">Allow</span>
                    </td>
                    <td>
                      <div className="flex items-center gap-2">
                        <select
                          value={value}
                          disabled={busyRule !== null}
                          onChange={(e) => setRule(r.rule, e.target.value as "off" | SslPolicyAction)}
                          className="rounded-md px-2 py-[6px] text-[13px] text-[var(--qz-fg-1)] outline-none cursor-pointer w-full"
                          style={{ ...inputStyle, color: value === "off" ? "var(--qz-fg-4)" : "var(--qz-accent)" }}
                        >
                          <option value="off">None</option>
                          <option value="inspect">Inspect</option>
                          <option value="splice">Splice</option>
                        </select>
                        {problem && (
                          <span className="badge badge-warn flex-shrink-0" title={problem}>
                            !
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
  const toneColor = tone === "danger" ? "var(--qz-danger)" : "var(--qz-warn)";
  const toneSoft = tone === "danger" ? "var(--qz-danger-soft)" : "var(--qz-warn-soft)";
  const Icon = tone === "danger" ? AlertTriangle : ShieldAlert;
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
        <div
          className="flex gap-3 rounded-md px-3 py-3"
          style={{ background: toneSoft, border: `1px solid color-mix(in oklab, ${toneColor} 35%, transparent)` }}
        >
          <Icon size={16} className="flex-shrink-0 mt-[1px]" style={{ color: toneColor }} />
          <div className="text-[13px] text-[var(--qz-fg-2)] flex flex-col gap-2 [&_p]:m-0">{children}</div>
        </div>
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={close}
            disabled={working}
            className="px-4 py-[9px] rounded-md text-[13px] font-medium cursor-pointer disabled:opacity-50"
            style={{ background: "transparent", border: "1px solid var(--qz-border)", color: "var(--qz-fg-2)" }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={run}
            disabled={working}
            className="px-4 py-[9px] rounded-md text-[13px] font-semibold cursor-pointer border-0 disabled:opacity-70"
            style={{ background: toneColor, color: "white" }}
          >
            {working ? "Working…" : confirmLabel}
          </button>
        </div>
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
  const [tab, setTab] = useState<"settings" | "policies">("settings");

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
    return <div className="px-[36px] pt-[28px] text-[13px] text-[var(--qz-fg-4)]">Loading…</div>;
  }
  if (phase === "error") {
    return (
      <div className="px-[36px] pt-[28px] flex items-center gap-2 text-[13px] text-[var(--qz-danger)]">
        <AlertTriangle size={14} /> {errorMsg}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0 flex items-start gap-3">
        <div className="flex-1">
          <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
            SSL Inspection
          </h1>
          <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
            Decrypt, inspect, and re-encrypt outbound HTTPS on selected firewall rules (Squid ssl_bump)
          </p>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <span className="text-[13px] text-[var(--qz-fg-3)]">{config.enabled ? "Enabled" : "Disabled"}</span>
          <span aria-disabled={toggling} style={{ opacity: toggling ? 0.5 : 1 }}>
            <Switch on={config.enabled} onChange={onToggle} />
          </span>
        </div>
      </div>

      <div className="px-[36px] pb-4 flex-shrink-0">
        <Tabs
          items={[
            { value: "settings", label: "Settings" },
            { value: "policies", label: "Policies", count: config.policies.length },
          ]}
          value={tab}
          onChange={(v) => setTab(v as "settings" | "policies")}
        />
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-8">
        {tab === "policies" ? (
          <PoliciesTab config={config} status={status} onApplied={load} setToast={setToast} />
        ) : (
          <div className="flex flex-col gap-4 max-w-[1000px]">
        <StatusCard status={status} />
        <CaPanel status={status} onRegenerate={() => setConfirm("regenerate")} regenerating={regenerating} />

      {/* Inspection policy */}
      <section className="rounded-lg px-5 py-4 flex flex-col gap-4" style={cardStyle}>
        <h2 className="text-[13px] font-semibold text-[var(--qz-fg-1)] m-0">Inspection Policy</h2>

        <div className="flex flex-col gap-2">
          <span className="text-[11px] uppercase tracking-wide text-[var(--qz-fg-4)]">Default action</span>
          <Segmented
            items={[
              { value: "inspect", label: "Inspect all" },
              { value: "splice", label: "Splice all" },
            ]}
            value={draft.defaultAction}
            onChange={(v) => setDraft((d) => ({ ...d, defaultAction: v as "inspect" | "splice" }))}
          />
          <span className="text-[12px] text-[var(--qz-fg-4)]">
            Traffic not on the do-not-inspect list is {draft.defaultAction === "inspect" ? "decrypted" : "passed through"}.
          </span>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[11px] uppercase tracking-wide text-[var(--qz-fg-4)]">
            Do-not-inspect (spliced) domains
          </span>
          <NoInspectEditor domains={draft.noInspect} onChange={(next) => setDraft((d) => ({ ...d, noInspect: next }))} />
          <label className="flex items-center gap-2 text-[13px] text-[var(--qz-fg-2)] cursor-pointer mt-1">
            <input
              type="checkbox"
              checked={draft.defaultExclusions}
              onChange={(e) => setDraft((d) => ({ ...d, defaultExclusions: e.target.checked }))}
            />
            Apply the shipped baseline (banking, healthcare, government, cert-pinned/update endpoints)
          </label>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[11px] uppercase tracking-wide text-[var(--qz-fg-4)]">
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

        <div className="flex items-center gap-2">
          <Button kind="primary" size="sm" onClick={onSave} disabled={!dirty || saving}>
            {saving ? "Applying…" : "Apply changes"}
          </Button>
          {dirty && (
            <Button kind="secondary" size="sm" onClick={() => setDraft(config)} disabled={saving}>
              Discard
            </Button>
          )}
        </div>
      </section>

      {/* Content filter — inert seam */}
      <section className="rounded-lg px-5 py-4 flex flex-col gap-3 opacity-90" style={cardStyle}>
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-semibold text-[var(--qz-fg-1)] m-0">Content Filter (ICAP)</h2>
          <span className="badge badge-muted">Not attached</span>
        </div>
        <p className="text-[13px] text-[var(--qz-fg-3)] m-0">
          No content-filtering engine is attached yet. When one is added (e2guardian in ICAP mode, or
          c-icap/ClamAV), it runs <em>behind</em> Squid and receives already-decrypted plaintext HTTP —
          it never does its own TLS interception and never holds its own CA. These fields are the seam it
          will plug into.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-[var(--qz-fg-4)]">ICAP host</span>
            <input disabled value={draft.contentFilter?.icapHost ?? "127.0.0.1"} className="rounded-md px-3 py-[6px] text-[13px] mono opacity-60" style={inputStyle} />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-[var(--qz-fg-4)]">ICAP port</span>
            <input disabled value={draft.contentFilter?.icapPort ?? 1344} className="rounded-md px-3 py-[6px] text-[13px] mono opacity-60" style={inputStyle} />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-[var(--qz-fg-4)]">Fail mode</span>
            <input disabled value={draft.contentFilter?.failMode ?? "closed (fail closed)"} className="rounded-md px-3 py-[6px] text-[13px] mono opacity-60" style={inputStyle} />
          </div>
        </div>
      </section>
          </div>
        )}
      </div>

      {confirm === "enable" && (
        <ConfirmModal
          title="Enable SSL inspection?"
          tone="warn"
          confirmLabel="Enable inspection"
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
            (download it from the Inspection root CA section below) before enabling.
          </p>
        </ConfirmModal>
      )}

      {confirm === "regenerate" && (
        <ConfirmModal
          title="Regenerate the inspection CA?"
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
