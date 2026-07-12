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
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  Plus,
  RotateCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { useDashboard } from "@/lib/DashboardContext";
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
  SslPolicy,
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

// ── inspection policy editor (per firewall rule) ─────────────────────────────

function PolicyEditor({
  policies,
  status,
  onChange,
}: {
  policies: SslPolicy[];
  status: SslStatusReport | null;
  onChange: (next: SslPolicy[]) => void;
}) {
  const [ruleDraft, setRuleDraft] = useState("");
  const [actionDraft, setActionDraft] = useState<SslPolicyAction>("inspect");
  const [err, setErr] = useState<string | null>(null);

  const problemFor = (rule: number) => status?.problems?.find((p) => p.policy === rule)?.error ?? null;
  const patch = (rule: number, fields: Partial<SslPolicy>) =>
    onChange(policies.map((x) => (x.rule === rule ? { ...x, ...fields } : x)));

  const add = () => {
    const rule = Number(ruleDraft);
    if (!Number.isInteger(rule) || rule < 1 || rule > 999999) {
      setErr("Enter a firewall rule number (1–999999).");
      return;
    }
    if (policies.some((p) => p.rule === rule)) {
      setErr("That rule already has an inspection binding.");
      return;
    }
    onChange(
      [...policies, { rule, ruleset: "forward", action: actionDraft, enabled: true }].sort(
        (a, b) => a.rule - b.rule,
      ),
    );
    setRuleDraft("");
    setErr(null);
  };

  const actionItems = [
    { value: "inspect", label: "Inspect" },
    { value: "splice", label: "Splice" },
  ];

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] uppercase tracking-wide text-[var(--qz-fg-4)]">Inspection policies</span>
      {policies.length === 0 ? (
        <span className="text-[12px] text-[var(--qz-fg-4)]">
          No bindings yet — nothing is inspected until you attach inspection to a firewall
          forward-filter rule below.
        </span>
      ) : (
        <div className="flex flex-col gap-1">
          {policies.map((p) => {
            const problem = problemFor(p.rule);
            return (
              <div key={p.rule} className="flex flex-col gap-1 rounded-md px-3 py-2" style={inputStyle}>
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-[13px] text-[var(--qz-fg-1)] mono">forward rule {p.rule}</span>
                  <Segmented items={actionItems} value={p.action} onChange={(v) => patch(p.rule, { action: v as SslPolicyAction })} />
                  <label className="flex items-center gap-1 text-[12px] text-[var(--qz-fg-3)] cursor-pointer">
                    <input type="checkbox" checked={p.enabled} onChange={(e) => patch(p.rule, { enabled: e.target.checked })} />
                    Enabled
                  </label>
                  {problem && <span className="badge badge-warn" title={problem}>Unresolved</span>}
                  <button
                    type="button"
                    onClick={() => onChange(policies.filter((x) => x.rule !== p.rule))}
                    className="ml-auto text-[var(--qz-fg-4)] hover:text-[var(--qz-danger)]"
                    title="Remove binding"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                {problem && (
                  <span className="text-[12px] text-[var(--qz-danger)] flex items-center gap-1">
                    <AlertTriangle size={12} /> {problem}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={ruleDraft}
          onChange={(e) => {
            setRuleDraft(e.target.value.replace(/[^0-9]/g, ""));
            setErr(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
          placeholder="Rule #"
          className="rounded-md px-3 py-[6px] text-[13px] text-[var(--qz-fg-1)] outline-none w-[100px] mono"
          style={inputStyle}
        />
        <Segmented items={actionItems} value={actionDraft} onChange={(v) => setActionDraft(v as SslPolicyAction)} />
        <Button kind="secondary" size="sm" icon={Plus} onClick={add}>
          Add binding
        </Button>
      </div>
      {err && <span className="text-[12px] text-[var(--qz-danger)]">{err}</span>}
      <span className="text-[12px] text-[var(--qz-fg-4)]">
        Inspection applies to HTTPS matched by the chosen firewall forward-filter rule (source,
        destination, port). A <span className="mono">splice</span> binding is an explicit
        do-not-inspect carve-out. Rules that match on an outbound interface can&apos;t carry
        inspection — scope by source or destination instead.
      </span>
    </div>
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

  const onToggle = async (enabled: boolean) => {
    // Enabling starts intercepting LAN HTTPS immediately. Any client that has
    // not installed the QuartzFire CA will get certificate errors and be unable
    // to load HTTPS sites, so require an explicit acknowledgement first.
    if (
      enabled &&
      !window.confirm(
        "Enable SSL inspection?\n\n" +
          "Outbound HTTPS matched by your inspection policies will be intercepted and re-signed with " +
          "the QuartzFire inspection CA. Any client that does NOT trust this CA will get certificate " +
          "errors and be unable to load HTTPS sites.\n\n" +
          "Make sure the inspection CA has already been distributed to and installed on your " +
          "clients (download it from the Inspection root CA section below) before enabling.",
      )
    )
      return;
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

  const onRegenerate = async () => {
    if (
      !window.confirm(
        "Regenerate the inspection CA?\n\nAll previously distributed CAs become INVALID — every " +
          "client must reinstall the new certificate before it can browse HTTPS through the firewall.",
      )
    )
      return;
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

      <div className="px-[36px] pb-8 flex flex-col gap-4 overflow-auto max-w-[1000px]">
        <StatusCard status={status} />
        <CaPanel status={status} onRegenerate={onRegenerate} regenerating={regenerating} />

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

        <PolicyEditor
          policies={draft.policies}
          status={status}
          onChange={(next) => setDraft((d) => ({ ...d, policies: next }))}
        />

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
    </div>
  );
}
