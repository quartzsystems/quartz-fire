"use client";

// Intrusion Prevention — WatchGuard-style IPS on top of Suricata.
//
// Settings tab: the engine policy (per-threat-level actions, scan mode,
// signature updates), stored as a desired-state file a root helper applies
// asynchronously. Policies tab: which firewall rules hand their traffic to
// the engine (`action queue` — inspection only happens for traffic hitting
// IPS-enabled Allow rules). Alerts tab: the live EVE alert stream from the
// journal. Exclusions tab: suppressed signature IDs.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { ColumnsMenu, useColumnVisibility } from "@/components/dashboard/ColumnsMenu";
import { useColumnResize } from "@/components/dashboard/ColumnResize";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Tabs } from "@/components/ui/Tabs";
import { Switch } from "@/components/ui/Switch";
import { useDashboard } from "@/lib/DashboardContext";
import {
  alertKey,
  fetchIpsAlertHistory,
  fetchIpsStatus,
  IpsAlert,
  IpsSettings,
  IpsStatus,
  LEVEL_ACTION_LABEL,
  LevelAction,
  requestIpsUpdate,
  saveIpsSettings,
  ScanMode,
  THREAT_LEVELS,
  ThreatLevel,
} from "@/lib/ips";
import {
  applyRuleIps,
  emptyFirewallConfig,
  fetchFirewall,
  FirewallConfig,
  FirewallRule,
} from "@/lib/firewall";

type Tab = "settings" | "policies" | "alerts" | "exclusions";

const dash = <span className="text-[var(--cds-alias-typography-color-200)]">—</span>;

/// Clarity status pill (mono uppercase), per the design reference.
const pillStyle = { fontFamily: "var(--qz-font-mono)", letterSpacing: "0.06em" } as const;

// ── Settings tab ──────────────────────────────────────────────────────────────

function SettingsTab({
  status,
  onSaved,
}: {
  status: IpsStatus;
  onSaved: () => void;
}) {
  const { setToast } = useDashboard();
  const [draft, setDraft] = useState<IpsSettings>(status.settings);
  const [saving, setSaving] = useState(false);
  const [updating, setUpdating] = useState(false);

  // A fresh status (after save/apply) becomes the new baseline.
  useEffect(() => {
    setDraft(status.settings);
  }, [status.settings]);

  const setLevel = (level: ThreatLevel, patch: Partial<IpsSettings[ThreatLevel]>) =>
    setDraft((d) => ({ ...d, [level]: { ...d[level], ...patch } }));

  const save = async () => {
    setSaving(true);
    try {
      await saveIpsSettings({
        ...draft,
        update_url: draft.update_url?.trim() || null,
      });
      setToast("IPS settings saved — applying on the device…");
      onSaved();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to save IPS settings.");
    } finally {
      setSaving(false);
    }
  };

  const updateNow = async () => {
    setUpdating(true);
    try {
      await requestIpsUpdate();
      setToast("Signature update requested — this can take a few minutes.");
      onSaved();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to request a signature update.");
    } finally {
      setUpdating(false);
    }
  };

  const apply = status.apply;
  const counts = apply?.rule_counts ?? null;
  const lastUpdate = apply?.last_update ?? null;
  const time = (ts: number) => new Date(ts * 1000).toLocaleString(undefined, { hour12: false });

  // Card-header meta, per the DC reference: "signature set <date> · <n> rules".
  const totalRules = counts ? Object.values(counts).reduce((a: number, b) => a + (b ?? 0), 0) : 0;
  const sigDate = lastUpdate?.ok ? new Date(lastUpdate.time * 1000).toISOString().slice(0, 10) : null;
  const meta = [sigDate ? `signature set ${sigDate}` : null, totalRules > 0 ? `${totalRules.toLocaleString()} rules` : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex flex-col gap-4 max-w-[860px]">
      {apply?.error && (
        <div className="alert alert-danger alert-sm">
          <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
          <div className="alert-text">{apply.error}</div>
        </div>
      )}
      {!apply && (
        <div className="alert alert-info alert-sm">
          <Icon shape="info-circle" size={14} className="alert-icon" />
          <div className="alert-text">
            The IPS service has not reported yet — on a device this appears after the first apply run.
          </div>
        </div>
      )}

      <section className="card" style={{ maxWidth: 760 }}>
        <div className="card-header">
          Verdicts by Threat Level
          {meta && (
            <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 400, color: "var(--cds-alias-typography-color-200)" }}>
              {meta}
            </span>
          )}
        </div>
        <div className="card-block flex flex-col gap-5">
          <div className="flex items-center gap-3">
            <Switch on={draft.enabled} onChange={(v) => setDraft((d) => ({ ...d, enabled: v }))} />
            <span className="text-[14px] font-semibold text-[var(--cds-alias-typography-color-450)]">
              Enable Intrusion Prevention
            </span>
          </div>

          <div className="clr-form-control" style={{ marginTop: 0 }}>
            <label className="clr-control-label">Scan mode</label>
            <div className="flex items-center gap-4">
              <Segmented
                items={[
                  { value: "full", label: "Full Scan" },
                  { value: "fast", label: "Fast Scan" },
                ]}
                value={draft.scan_mode}
                onChange={(v) => setDraft((d) => ({ ...d, scan_mode: v as ScanMode }))}
              />
              <span className="text-[12px] text-[var(--cds-alias-typography-color-200)]">
                {draft.scan_mode === "full"
                  ? "Inspect entire flows."
                  : "Stop inspecting long and encrypted flows early — faster, less thorough."}
              </span>
            </div>
          </div>

          {/* Threat level policy table */}
          <div>
            <table className="table table-noborder table-compact" style={{ tableLayout: "fixed" }}>
              <colgroup>
                <col style={{ width: 140 }} />
                <col style={{ width: 172 }} />
                <col style={{ width: 70 }} />
                <col style={{ width: 70 }} />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th>Threat level</th>
                  <th>Action</th>
                  <th style={{ textAlign: "center" }}>Alarm</th>
                  <th style={{ textAlign: "center" }}>Log</th>
                  <th style={{ textAlign: "right" }}>Signatures</th>
                </tr>
              </thead>
              <tbody>
                {THREAT_LEVELS.map(({ level, label, color }) => {
                  const pol = draft[level];
                  return (
                    <tr key={level}>
                      <td>
                        <span className="inline-flex items-center gap-2">
                          <span
                            className="inline-block w-[10px] h-[18px] rounded-[3px] flex-shrink-0"
                            style={{ background: color }}
                          />
                          <span className="text-[13px] text-[var(--cds-alias-typography-color-450)]">{label}</span>
                        </span>
                      </td>
                      <td>
                        <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
                          <select
                            value={pol.action}
                            onChange={(e) => setLevel(level, { action: e.target.value as LevelAction })}
                            className="clr-select"
                            style={{ maxWidth: "none" }}
                          >
                            {(Object.keys(LEVEL_ACTION_LABEL) as LevelAction[]).map((a) => (
                              <option key={a} value={a}>
                                {LEVEL_ACTION_LABEL[a]}
                              </option>
                            ))}
                          </select>
                        </div>
                      </td>
                      <td>
                        <span className="clr-checkbox-wrapper" style={{ justifyContent: "center" }}>
                          <input
                            type="checkbox"
                            checked={pol.alarm}
                            disabled={pol.action === "disable"}
                            onChange={(e) => setLevel(level, { alarm: e.target.checked })}
                            aria-label={`Alarm on ${label}`}
                          />
                        </span>
                      </td>
                      <td>
                        <span className="clr-checkbox-wrapper" style={{ justifyContent: "center" }}>
                          <input
                            type="checkbox"
                            checked={pol.log}
                            disabled={pol.action === "disable"}
                            onChange={(e) => setLevel(level, { log: e.target.checked })}
                            aria-label={`Log ${label}`}
                          />
                        </span>
                      </td>
                      <td className="text-right text-[12px] text-[var(--cds-alias-typography-color-200)]" style={{ textAlign: "right", fontFamily: "var(--qz-font-mono)" }}>
                        {counts?.[level] ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="text-[12px] text-[var(--cds-alias-typography-color-200)] mt-2 mb-0">
              Drop blocks matching traffic inline; Allow only records it; Disabled removes the level&apos;s
              signatures. Alarm and Log control the Alerts view. Levels map from signature priority
              (1 = Critical … 4 = Low; unclassified = Information).
            </p>
          </div>

        </div>
        <div className="card-footer">
          <Button kind="primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save IPS Settings"}
          </Button>
        </div>
      </section>

      {/* Signature updates */}
      <section className="card">
        <div className="card-header">Signature Updates</div>
        <div className="card-block flex flex-col gap-3">
          <div className="clr-form-control" style={{ marginTop: 0 }}>
            <label className="clr-control-label">Update server</label>
            <div className="flex items-center gap-4">
              <input
                value={draft.update_url ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, update_url: e.target.value || null }))}
                placeholder="Default (Emerging Threats Open)"
                className="clr-input flex-1"
                style={{ maxWidth: "none", fontFamily: "var(--qz-font-mono)" }}
              />
              <Button kind="secondary" onClick={updateNow} disabled={updating || !status.settings.enabled}>
                {updating ? "Requesting…" : "Update Now"}
              </Button>
            </div>
          </div>
          <p className="text-[12px] text-[var(--cds-alias-typography-color-200)] m-0">
            {lastUpdate
              ? lastUpdate.ok
                ? `Last update ${time(lastUpdate.time)} — OK.`
                : `Last update ${time(lastUpdate.time)} failed: ${lastUpdate.message ?? "unknown error"}`
              : "No signature update has run yet — signatures are fetched automatically when IPS is first enabled."}
            {!status.settings.enabled && " Enable IPS to update signatures."}
          </p>
        </div>
      </section>
    </div>
  );
}

// ── Exclusions tab ────────────────────────────────────────────────────────────

/// Add one excluded signature ID (mock: "Add IPS Exclusion"). The signature
/// name fills in from recent alert history when the SID has been seen.
function ExclusionModal({
  existing,
  sigNames,
  onClose,
  onAdd,
}: {
  existing: number[];
  sigNames: Record<number, string>;
  onClose: () => void;
  onAdd: (sid: number) => Promise<void>;
}) {
  const [sid, setSid] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const tok = sid.trim();
  const parsed = /^\d+$/.test(tok) ? Number(tok) : null;
  const signature = parsed != null ? sigNames[parsed] : undefined;

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    if (parsed == null) {
      setError("Exclusions are signature IDs (numbers) — take the SID from an alert.");
      return;
    }
    if (existing.includes(parsed)) {
      setError(`SID ${parsed} is already excluded.`);
      return;
    }
    setSaving(true);
    try {
      await onAdd(parsed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add the exclusion.");
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={460}>
      <ModalHeader title="Add IPS Exclusion" onClose={onClose} />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 12 }}>
          <div className="clr-form-control" style={{ marginTop: 0 }}>
            <label className="clr-control-label">SID *</label>
            <input
              value={sid}
              onChange={(e) => {
                setSid(e.target.value);
                setError("");
              }}
              inputMode="numeric"
              placeholder="2013028"
              autoFocus
              className="clr-input"
              style={{ maxWidth: "none", width: "100%", fontFamily: "var(--qz-font-mono)" }}
            />
          </div>
          <div className="clr-form-control" style={{ marginTop: 0 }}>
            <label className="clr-control-label">Signature</label>
            <input
              value={signature ?? ""}
              readOnly
              placeholder="Filled in from the alert you exclude"
              className="clr-input"
              style={{ maxWidth: "none", width: "100%" }}
            />
          </div>
        </div>

        {error && (
          <p className="text-[12px] m-0" style={{ color: "var(--cds-alias-status-danger)" }}>
            {error}
          </p>
        )}

        <ModalFooter>
          <button type="button" className="btn btn-neutral" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || !tok}>
            {saving ? "Applying…" : "Add Exclusion"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}

function ExclusionsTab({
  status,
  sigNames,
  onSaved,
}: {
  status: IpsStatus;
  /** SID → signature name, learned from alert history (for exclusion labels). */
  sigNames: Record<number, string>;
  onSaved: () => void;
}) {
  const { setToast } = useDashboard();
  const [adding, setAdding] = useState(false);
  const [busySid, setBusySid] = useState<number | null>(null);
  const exceptions = status.settings.exceptions;

  const persist = (next: number[]) =>
    saveIpsSettings({
      ...status.settings,
      exceptions: next,
      update_url: status.settings.update_url?.trim() || null,
    });

  const add = async (sid: number) => {
    await persist([...exceptions, sid].sort((a, b) => a - b));
    setAdding(false);
    setToast(`Excluded SID ${sid} — applying on the device…`);
    onSaved();
  };

  const remove = async (sid: number) => {
    setBusySid(sid);
    try {
      await persist(exceptions.filter((s) => s !== sid));
      setToast(`Removed exclusion ${sid} — applying on the device…`);
      onSaved();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to update the exclusions.");
    } finally {
      setBusySid(null);
    }
  };

  return (
    <div className="flex flex-col gap-3 max-w-[860px]">
      <div className="flex justify-end">
        <Button kind="primary" size="sm" onClick={() => setAdding(true)}>
          Add Exclusion
        </Button>
      </div>

      <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--cds-alias-object-border-color)" }}>
        <table className="qz-table" style={{ width: "100%" }}>
          <colgroup>
            <col style={{ width: 120 }} />
            <col />
            <col style={{ width: 70 }} />
          </colgroup>
          <thead>
            <tr>
              <th>SID</th>
              <th>Signature</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {exceptions.length === 0 ? (
              <tr>
                <td colSpan={3} className="text-center text-[var(--cds-alias-typography-color-200)]" style={{ cursor: "default" }}>
                  No exclusions — add a false positive&apos;s SID to stop it blocking traffic.
                </td>
              </tr>
            ) : (
              exceptions.map((sid) => {
                const name = sigNames[sid];
                return (
                  <tr key={sid} style={{ cursor: "default" }}>
                    <td className="mono text-[var(--cds-alias-typography-color-450)]">{sid}</td>
                    <td
                      className={
                        name
                          ? "text-[var(--cds-alias-typography-color-300)]"
                          : "text-[var(--cds-alias-typography-color-200)] italic"
                      }
                      style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      title={name ?? undefined}
                    >
                      {name ?? "Not in recent alerts"}
                    </td>
                    <td className="text-right">
                      <button
                        type="button"
                        title={`Remove exclusion ${sid}`}
                        aria-label={`Remove exclusion ${sid}`}
                        disabled={busySid === sid}
                        onClick={() => remove(sid)}
                        className="btn btn-sm btn-link-neutral btn-icon"
                      >
                        <Icon shape="trash" size={13} />
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: 12, color: "var(--cds-alias-typography-color-200)" }}>
        Excluded signatures are suppressed for their scope — matches still log at the informational level.
      </div>

      {adding && (
        <ExclusionModal existing={exceptions} sigNames={sigNames} onClose={() => setAdding(false)} onAdd={add} />
      )}
    </div>
  );
}

// ── Policies tab ──────────────────────────────────────────────────────────────

/// The rule's traffic match, for display.
function policyLabel(rule: FirewallRule): string {
  if (rule.policy) return rule.policy;
  if (rule.protocol === "icmp") return "Ping";
  return "Any";
}

/** Resizable columns of the Policies tab's rules table. */
const IPS_RULE_COLS = [
  { key: "rule", header: "#", width: 60, minWidth: 40 },
  { key: "name", header: "Name" },
  { key: "policy", header: "Policy", width: 160 },
  { key: "action", header: "Action", width: 100 },
  { key: "ips", header: "IPS", width: 130 },
];

function PoliciesTab() {
  const { setToast } = useDashboard();
  const rulesResize = useColumnResize("ips-rules", IPS_RULE_COLS);
  const [config, setConfig] = useState<FirewallConfig>(emptyFirewallConfig);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setConfig(await fetchFirewall());
      setState("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load the firewall config.");
      setState("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (changes: { rule: FirewallRule; enabled: boolean }[]) => {
    setBusy(true);
    try {
      const n = await applyRuleIps(changes, config);
      if (n > 0) setToast(`Updated IPS on ${changes.length} rule${changes.length === 1 ? "" : "s"}.`);
      await load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to update IPS on the rule.");
    } finally {
      setBusy(false);
    }
  };

  if (state === "loading")
    return <div className="text-[13px] text-[var(--cds-alias-typography-color-200)]">Loading firewall rules…</div>;
  if (state === "error")
    return (
      <div className="flex flex-col gap-3">
        <div className="alert alert-danger alert-sm">
          <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
          <div className="alert-text">{errorMsg}</div>
        </div>
        <div>
          <Button kind="secondary" icon="refresh" onClick={load}>Retry</Button>
        </div>
      </div>
    );

  const eligible = config.rules.filter((r) => r.action === "accept");

  return (
    <div className="flex flex-col gap-3 max-w-[860px]">
      <div className="flex items-center justify-end gap-3">
        <Button
          kind="secondary"
          size="sm"
          disabled={busy || eligible.every((r) => r.ips)}
          onClick={() => toggle(eligible.filter((r) => !r.ips).map((rule) => ({ rule, enabled: true })))}
        >
          Enable on All
        </Button>
        <Button
          kind="secondary"
          size="sm"
          disabled={busy || eligible.every((r) => !r.ips)}
          onClick={() => toggle(eligible.filter((r) => r.ips).map((rule) => ({ rule, enabled: false })))}
        >
          Disable on All
        </Button>
      </div>

      <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--cds-alias-object-border-color)" }}>
        <table ref={rulesResize.tableRef} className="qz-table" style={{ width: "100%", tableLayout: rulesResize.tableLayout }}>
          <colgroup>
            {IPS_RULE_COLS.map((c) => (
              <col key={c.key} style={{ width: rulesResize.colWidth(c.key) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {IPS_RULE_COLS.map((c, i) => (
                <th key={c.key} {...rulesResize.thProps(i)}>
                  {c.header}
                  {rulesResize.handle(i)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {config.rules.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center text-[var(--cds-alias-typography-color-200)]" style={{ cursor: "default" }}>
                  No firewall rules yet — create them under{" "}
                  <Link href="/firewall/rules" className="text-[var(--cds-alias-typography-color-300)]">Firewall → Rules</Link>.
                </td>
              </tr>
            ) : (
              config.rules.map((r) => (
                <tr key={`${r.chain}:${r.rule}`} style={{ cursor: "default", opacity: r.enabled ? 1 : 0.55 }}>
                  <td className="mono text-[var(--cds-alias-typography-color-300)]">{r.rule}</td>
                  <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.name ?? <span className="text-[var(--cds-alias-typography-color-200)]">Rule {r.rule}</span>}
                    {r.chain !== "forward" && (
                      <span className="text-[11px] text-[var(--cds-alias-typography-color-200)]"> · {r.chain}</span>
                    )}
                  </td>
                  <td className="mono">{policyLabel(r)}</td>
                  <td>
                    {r.action === "accept" ? (
                      <span className="badge badge-ok">Allow</span>
                    ) : r.action === "drop" ? (
                      <span className="badge badge-crit">Deny</span>
                    ) : r.action === "reject" ? (
                      <span className="badge badge-warn">Reject</span>
                    ) : (
                      dash
                    )}
                  </td>
                  <td onMouseDown={(e) => e.stopPropagation()}>
                    {r.action === "accept" ? (
                      <div className="flex items-center gap-2">
                        <Switch on={r.ips} onChange={(v) => !busy && toggle([{ rule: r, enabled: v }])} />
                        {r.ips ? (
                          <span className="badge badge-ok">Enabled</span>
                        ) : (
                          <span className="badge badge-muted">Disabled</span>
                        )}
                      </div>
                    ) : (
                      <span className="text-[12px] text-[var(--cds-alias-typography-color-200)]">n/a</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: 12, color: "var(--cds-alias-typography-color-200)" }}>
        IPS attaches per rule — toggle it when editing a rule under Firewall → Rules. Only traffic
        hitting IPS-enabled Allow rules is inspected; Deny rules never need inspection.
      </div>
    </div>
  );
}

// ── Alerts tab ────────────────────────────────────────────────────────────────

type AlertRow = IpsAlert & { id: number };

const MAX_ALERTS = 500;

function LevelPill({ level }: { level: ThreatLevel }) {
  const meta = THREAT_LEVELS.find((l) => l.level === level) ?? THREAT_LEVELS[4];
  const kind =
    level === "critical"
      ? " label-danger"
      : level === "high" || level === "medium"
        ? " label-warning"
        : level === "low"
          ? " label-info"
          : "";
  return (
    <span className={`label${kind}`} style={pillStyle}>
      {meta.label.toUpperCase()}
    </span>
  );
}

// Toggleable columns for the alerts log. The Level cell depends on the row's
// alarm state (settings-derived), so content is rendered by ipsAlertCell rather
// than a static value on the column.
interface IpsAlertCol {
  key: string;
  header: string;
  width?: number;
  className?: string;
  ellipsis?: boolean;
  title?: (r: AlertRow) => string | undefined;
}

const IPS_ALERT_COLUMNS: IpsAlertCol[] = [
  { key: "time", header: "Time", width: 90, className: "mono text-[var(--cds-alias-typography-color-300)]" },
  { key: "level", header: "Level", width: 110 },
  { key: "action", header: "Action", width: 95 },
  { key: "signature", header: "Signature", ellipsis: true, title: (r) => `SID ${r.sid}${r.category ? ` · ${r.category}` : ""}` },
  { key: "src", header: "Source", width: 150, className: "mono", ellipsis: true },
  { key: "dst", header: "Destination", width: 150, className: "mono", ellipsis: true },
  { key: "proto", header: "Proto", width: 80, className: "mono" },
];

function ipsAlertCell(key: string, r: AlertRow, alarm: boolean): React.ReactNode {
  switch (key) {
    case "time":
      return r.ts ? new Date(r.ts).toLocaleTimeString(undefined, { hour12: false }) : "—";
    case "level":
      return (
        <span className="inline-flex items-center gap-[5px]">
          {alarm && <span className="badge badge-crit">Alarm</span>}
          <LevelPill level={r.level} />
        </span>
      );
    case "action":
      return r.action === "blocked" ? (
        <span className="label label-danger" style={pillStyle}>BLOCKED</span>
      ) : (
        <span className="label label-success" style={pillStyle}>ALLOWED</span>
      );
    case "signature":
      return (
        <>
          {r.signature}
          <span className="text-[11px] text-[var(--cds-alias-typography-color-200)]"> · {r.sid}</span>
        </>
      );
    case "src":
      return (
        <>
          {r.src ?? dash}
          {r.spt != null && <span className="text-[var(--cds-alias-typography-color-200)]">:{r.spt}</span>}
        </>
      );
    case "dst":
      return (
        <>
          {r.dst ?? dash}
          {r.dpt != null && <span className="text-[var(--cds-alias-typography-color-200)]">:{r.dpt}</span>}
        </>
      );
    case "proto":
      return r.proto ?? "—";
    default:
      return null;
  }
}

function AlertsTab({ settings }: { settings: IpsSettings }) {
  const rowsRef = useRef<AlertRow[]>([]);
  const dirtyRef = useRef(false);
  const nextId = useRef(0);
  const [rows, setRows] = useState<AlertRow[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [stream, setStream] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [streamGen, setStreamGen] = useState(0);

  useEffect(() => {
    const es = new EventSource("/api/ips/alerts");
    es.onopen = () => setStream("live");
    es.onerror = () => setStream("reconnecting");
    let throttle: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (!dirtyRef.current || pausedRef.current) return;
      dirtyRef.current = false;
      setRows(rowsRef.current);
    };
    const scheduleFlush = () => {
      if (throttle) return;
      flush();
      throttle = setTimeout(() => {
        throttle = null;
        flush();
      }, 75);
    };
    es.onmessage = (ev) => {
      try {
        const alert = JSON.parse(ev.data) as IpsAlert;
        rowsRef.current = [{ ...alert, id: nextId.current++ }, ...rowsRef.current].slice(0, MAX_ALERTS);
        dirtyRef.current = true;
        scheduleFlush();
      } catch {
        // tolerate a malformed event rather than killing the stream
      }
    };

    // The SSE stream is live-only; history comes from the persistent alert
    // log on the device, so it's still here after a reboot. Deduped against
    // whatever the live stream delivered while the fetch was in flight.
    let cancelled = false;
    fetchIpsAlertHistory()
      .then((history) => {
        if (cancelled || history.length === 0) return;
        const seen = new Set(rowsRef.current.map(alertKey));
        const merged = [
          ...rowsRef.current,
          ...history.filter((a) => !seen.has(alertKey(a))).map((a) => ({ ...a, id: nextId.current++ })),
        ];
        merged.sort((a, b) => b.ts - a.ts);
        rowsRef.current = merged.slice(0, MAX_ALERTS);
        dirtyRef.current = true;
        scheduleFlush();
      })
      .catch(() => {
        // best-effort — the live stream still works without history
      });

    return () => {
      cancelled = true;
      if (throttle) clearTimeout(throttle);
      es.close();
    };
  }, [streamGen]);

  const [query, setQuery] = useState("");
  const [actionFilter, setActionFilter] = useState<"all" | "blocked" | "allowed">("all");
  const [levelFilter, setLevelFilter] = useState<"all" | ThreatLevel>("all");

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      rows.filter((r) => {
        if (!settings[r.level]?.log) return false; // Log unchecked for this level
        if (actionFilter !== "all" && r.action !== actionFilter) return false;
        if (levelFilter !== "all" && r.level !== levelFilter) return false;
        if (!q) return true;
        const hay = [r.signature, r.category, r.src, r.dst, r.sid, r.proto]
          .filter((v) => v != null && v !== "")
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      }),
    [rows, q, actionFilter, levelFilter, settings],
  );

  const togglePause = () =>
    setPaused((p) => {
      pausedRef.current = !p;
      if (p) setRows(rowsRef.current);
      return !p;
    });

  const clear = () => {
    rowsRef.current = [];
    dirtyRef.current = false;
    setRows([]);
  };

  const vis = useColumnVisibility("ips-alerts", IPS_ALERT_COLUMNS);
  const cols = IPS_ALERT_COLUMNS.filter((c) => vis.isVisible(c.key));
  const resize = useColumnResize("ips-alerts", cols.map((c) => ({ key: c.key, width: c.width })));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative">
          <Icon shape="search" size={14} className="absolute left-[10px] top-1/2 -translate-y-1/2 text-[var(--cds-alias-typography-color-200)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter alerts…"
            className="clr-input"
            style={{ width: 240, maxWidth: "none", paddingLeft: 30 }}
          />
        </div>
        <Segmented
          items={[
            { value: "all", label: "All" },
            { value: "blocked", label: "Blocked" },
            { value: "allowed", label: "Allowed" },
          ]}
          value={actionFilter}
          onChange={(v) => setActionFilter(v as typeof actionFilter)}
        />
        <div className="clr-select-wrapper" style={{ width: "auto" }}>
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value as typeof levelFilter)}
            title="Filter by threat level"
            className="clr-select"
          >
            <option value="all">All levels</option>
            {THREAT_LEVELS.map((l) => (
              <option key={l.level} value={l.level}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <ColumnsMenu vis={vis} />
          <Button kind="outline" size="sm" onClick={() => { clear(); setStream("connecting"); setStreamGen((g) => g + 1); }}>
            Refresh
          </Button>
          <Button kind="secondary" size="sm" icon={paused ? "play" : "pause"} onClick={togglePause}>
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button kind="secondary" size="sm" icon="times" onClick={clear}>
            Clear
          </Button>
          <span className="inline-flex items-center gap-[6px] text-[12px] text-[var(--cds-alias-typography-color-200)]">
            <span
              className="inline-block w-[7px] h-[7px] rounded-full"
              style={{
                background: paused
                  ? "var(--cds-alias-typography-color-200)"
                  : stream === "live"
                    ? "var(--cds-alias-status-success)"
                    : "var(--cds-alias-status-warning)",
              }}
            />
            {paused ? "Paused" : stream === "live" ? "Live" : stream === "connecting" ? "Connecting…" : "Reconnecting…"}
            {" · "}
            {visible.length} {visible.length === 1 ? "alert" : "alerts"}
          </span>
        </div>
      </div>

      <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--cds-alias-object-border-color)" }}>
        <table ref={resize.tableRef} className="qz-table" style={{ width: "100%", tableLayout: resize.tableLayout }}>
          <colgroup>
            {cols.map((c) => (
              <col key={c.key} style={{ width: resize.colWidth(c.key) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {cols.map((c, i) => (
                <th key={c.key} {...resize.thProps(i)}>
                  {c.header}
                  {resize.handle(i)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={cols.length} className="text-center text-[var(--cds-alias-typography-color-200)]" style={{ cursor: "default" }}>
                  {rows.length === 0
                    ? "No alerts yet — alerts appear when inspected traffic matches a signature."
                    : "No alerts match the filter."}
                </td>
              </tr>
            ) : (
              visible.map((r) => {
                const alarm = settings[r.level]?.alarm ?? false;
                return (
                  <tr
                    key={r.id}
                    style={{
                      cursor: "default",
                      background: alarm ? "var(--cds-alias-status-danger-tint)" : undefined,
                    }}
                  >
                    {cols.map((c) => (
                      <td
                        key={c.key}
                        className={c.className}
                        style={c.ellipsis ? { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } : undefined}
                        title={c.title?.(r)}
                      >
                        {ipsAlertCell(c.key, r, alarm)}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="text-[12px] text-[var(--cds-alias-typography-color-200)] m-0">
        Live alerts stream from the IPS engine; history is read from the persistent alert log on the
        device (survives reboots, rotated at 10&nbsp;MB). The newest {MAX_ALERTS} are shown. Levels
        with Log unchecked are hidden; levels with Alarm are highlighted. Add a false positive&apos;s SID
        to the Exceptions on the Settings tab to stop it blocking traffic — matches are still logged
        here.
      </p>
    </div>
  );
}

// ── page shell ────────────────────────────────────────────────────────────────

export default function IntrusionPreventionPage() {
  const [tab, setTab] = useState<Tab>("settings");
  const [status, setStatus] = useState<IpsStatus | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  // SID → signature name, learned from the EVE alert history so the Settings
  // tab can label exceptions. Accumulates across refreshes (a SID seen once
  // keeps its label even after it ages out of the tail).
  const [sigNames, setSigNames] = useState<Record<number, string>>({});

  // Deep-link support (?tab=alerts — used by the dashboard's IPS Alerts tile).
  // Read on mount instead of useSearchParams to avoid the Suspense boundary
  // the app router requires for search params during prerender.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t === "settings" || t === "policies" || t === "alerts" || t === "exclusions") setTab(t);
  }, []);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setState("loading");
    try {
      // History is best-effort — it only enriches exception labels, so its
      // failure must not block the status the page depends on.
      const [st, history] = await Promise.all([
        fetchIpsStatus(),
        fetchIpsAlertHistory().catch(() => [] as IpsAlert[]),
      ]);
      setStatus(st);
      if (history.length) {
        setSigNames((prev) => {
          const next = { ...prev };
          for (const a of history) if (a.sid && a.signature) next[a.sid] = a.signature;
          return next;
        });
      }
      setState("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load the IPS status.");
      setState("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // The root helper applies changes asynchronously — after a save, re-read
  // shortly so the page reflects the applied reality without manual refresh.
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSaved = useCallback(() => {
    load("refresh");
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => load("refresh"), 3000);
  }, [load]);
  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
  }, []);

  // Engine-state pill in the page header, per the DC reference.
  const pill = !status ? null : !status.settings.enabled ? (
    <span className="label" style={pillStyle}>DISABLED</span>
  ) : status.apply?.error ? (
    <span className="label label-danger" style={pillStyle} title={status.apply.error}>ERROR</span>
  ) : status.running ? (
    <span className="label label-success" style={pillStyle}>ENGINE RUNNING</span>
  ) : (
    <span className="label label-warning" style={pillStyle}>STARTING</span>
  );

  // Shared loading/error scaffolding for the status-backed tabs.
  const statusGate = (content: (st: IpsStatus) => React.ReactNode) => (
    <>
      {state === "loading" && (
        <div className="text-[13px] text-[var(--cds-alias-typography-color-200)]">Loading IPS status…</div>
      )}
      {state === "error" && (
        <div className="flex flex-col gap-3">
          <div className="alert alert-danger alert-sm">
            <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
            <div className="alert-text">{errorMsg}</div>
          </div>
          <div>
            <Button kind="secondary" icon="refresh" onClick={() => load()}>Retry</Button>
          </div>
        </div>
      )}
      {state === "ready" && status && content(status)}
    </>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <div className="mr-auto">
          <h2 className="m-0">Intrusion Prevention</h2>
          <p className="clr-secondary" style={{ marginTop: 4 }}>
            Signature inspection for traffic on rules that opt in — verdicts by threat level.
          </p>
        </div>
        <span className="flex items-center gap-2">
          {pill}
          <button type="button" className="btn" onClick={() => load("refresh")}>
            Refresh
          </button>
        </span>
      </div>

      <Tabs
        items={[
          { value: "settings", label: "Settings" },
          { value: "policies", label: "Policies" },
          { value: "alerts", label: "Alerts" },
          { value: "exclusions", label: "Exclusions", count: status?.settings.exceptions.length },
        ]}
        value={tab}
        onChange={(v) => setTab(v as Tab)}
      />

      <div>
        {tab === "settings" && statusGate((st) => <SettingsTab status={st} onSaved={onSaved} />)}
        {tab === "exclusions" && statusGate((st) => <ExclusionsTab status={st} sigNames={sigNames} onSaved={onSaved} />)}
        {tab === "policies" && <PoliciesTab />}
        {tab === "alerts" && (
          <AlertsTab settings={status?.settings ?? ({
            enabled: false,
            scan_mode: "full",
            critical: { action: "drop", alarm: true, log: true },
            high: { action: "drop", alarm: true, log: true },
            medium: { action: "drop", alarm: false, log: true },
            low: { action: "drop", alarm: false, log: true },
            information: { action: "allow", alarm: false, log: false },
            exceptions: [],
            update_url: null,
            update_seq: 0,
          } as IpsSettings)} />
        )}
      </div>
    </div>
  );
}
