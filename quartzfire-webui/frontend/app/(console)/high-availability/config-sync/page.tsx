"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { useDashboard } from "@/lib/DashboardContext";
import {
  ConfigSyncConfig,
  ConfigSyncSection,
  ConfigSyncTestResult,
  SYNC_SECTIONS,
  SyncMode,
  applyConfigSync,
  emptyConfig,
  fetchConfigSync,
  testConfigSync,
} from "@/lib/config-sync";
import { ErrorText, Field, TextInput, monoStyle, numOrNull } from "../formkit";

function SectionsEditor({
  sections,
  onChange,
}: {
  sections: ConfigSyncSection[];
  onChange: (s: ConfigSyncSection[]) => void;
}) {
  const setAt = (i: number, patch: Partial<ConfigSyncSection>) =>
    onChange(sections.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <div className="flex flex-col gap-2">
      {sections.map((s, i) => (
        <div key={i} className="flex items-center gap-2">
          <div className="clr-select-wrapper" style={{ maxWidth: 200 }}>
            <select
              value={s.section}
              onChange={(e) => setAt(i, { section: e.target.value })}
              className="clr-select"
              style={{ maxWidth: "none" }}
            >
              <option value="">— section —</option>
              {SYNC_SECTIONS.map((sec) => (
                <option key={sec} value={sec}>{sec}</option>
              ))}
            </select>
          </div>
          <input
            value={s.subpath ?? ""}
            onChange={(e) => setAt(i, { subpath: e.target.value || null })}
            placeholder="sub-element (optional, e.g. ospf)"
            className="clr-input"
            style={{ maxWidth: "none", ...monoStyle }}
          />
          <button
            type="button"
            onClick={() => onChange(sections.filter((_, j) => j !== i))}
            aria-label="Remove section"
            className="btn btn-sm btn-link-neutral btn-icon flex-shrink-0"
          >
            <Icon shape="trash" size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...sections, { section: "", subpath: null }])}
        className="btn btn-sm btn-neutral self-start"
      >
        <Icon shape="plus" size={13} /> Add Section
      </button>
    </div>
  );
}

export default function ConfigSyncPage() {
  const { setToast } = useDashboard();
  const [live, setLive] = useState<ConfigSyncConfig | null>(null);
  const [form, setForm] = useState<ConfigSyncConfig>(emptyConfig());
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConfigSyncTestResult | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const cs = await fetchConfigSync();
      setLive(cs);
      setForm(cs);
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load config-sync.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setSecondary = (patch: Partial<ConfigSyncConfig["secondary"]>) =>
    setForm((f) => ({ ...f, secondary: { ...f.secondary, ...patch } }));

  const save = async () => {
    if (!live) return;
    setErrorMsg("");
    if (!form.mode) return setErrorMsg("Choose a sync mode (load or set).");
    if (!form.secondary.address?.trim()) return setErrorMsg("Enter the secondary's address.");
    if (!form.secondary.has_key && !form.secondary.key?.trim()) return setErrorMsg("Enter the secondary's API key.");
    if (form.sections.filter((s) => s.section.trim()).length === 0) return setErrorMsg("Add at least one section to sync.");

    setSaving(true);
    try {
      const n = await applyConfigSync(live, form);
      setToast(n === 0 ? "No changes — config already matches." : `Applied ${n} change${n === 1 ? "" : "s"}.`);
      await load();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to apply config-sync.");
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTestResult(null);
    if (!form.secondary.address?.trim() || !form.secondary.key?.trim()) {
      setTestResult({ reachable: false, authenticated: false, version: null, error: "Enter the secondary address and key to test." });
      return;
    }
    setTesting(true);
    try {
      const res = await testConfigSync({
        address: form.secondary.address.trim(),
        port: form.secondary.port,
        key: form.secondary.key.trim(),
        timeout: form.secondary.timeout,
      });
      setTestResult(res);
    } catch (e) {
      setTestResult({ reachable: false, authenticated: false, version: null, error: e instanceof Error ? e.message : "Test failed." });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <div className="mr-auto">
          <h2 className="m-0">Config Sync</h2>
          <p className="clr-secondary" style={{ marginTop: 4 }}>
            Replicate chosen configuration sections from this firewall to its standby peer.
          </p>
        </div>
      </div>

      {status === "loading" && <div className="clr-secondary">Loading config-sync…</div>}
      {status === "error" && (
        <div className="alert alert-danger alert-sm">
          <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
          <div className="alert-text">{errorMsg}</div>
          <div className="alert-actions">
            <button type="button" className="alert-action" onClick={load}>
              Retry
            </button>
          </div>
        </div>
      )}
      {status === "ready" && live && (
        <div className="card" style={{ maxWidth: 720 }}>
          <div className="card-block flex flex-col gap-4">
            <div className="clr-form-control" style={{ marginTop: 0 }}>
              <label className="clr-control-label">Sync mode</label>
              <div className="flex flex-col gap-[6px]">
                <div className="clr-radio-wrapper">
                  <input
                    type="radio"
                    id="sync-mode-load"
                    name="sync-mode"
                    checked={(form.mode ?? "load") === "load"}
                    onChange={() => setForm((f) => ({ ...f, mode: "load" as SyncMode }))}
                  />
                  <label htmlFor="sync-mode-load">load — replace the section on the secondary</label>
                </div>
                <div className="clr-radio-wrapper">
                  <input
                    type="radio"
                    id="sync-mode-set"
                    name="sync-mode"
                    checked={form.mode === "set"}
                    onChange={() => setForm((f) => ({ ...f, mode: "set" as SyncMode }))}
                  />
                  <label htmlFor="sync-mode-set">set — merge, overwriting conflicting values</label>
                </div>
              </div>
            </div>

            <div className="grid gap-3" style={{ gridTemplateColumns: "2fr 1fr 1fr" }}>
              <Field label="Secondary address" hint="IPv4, IPv6, or FQDN.">
                <TextInput value={form.secondary.address ?? ""} onChange={(v) => setSecondary({ address: v || null })} placeholder="192.0.2.112" mono />
              </Field>
              <Field label="Port">
                <TextInput value={form.secondary.port?.toString() ?? ""} onChange={(v) => setSecondary({ port: numOrNull(v) })} placeholder="443" mono />
              </Field>
              <Field label="Timeout (s)">
                <TextInput value={form.secondary.timeout?.toString() ?? ""} onChange={(v) => setSecondary({ timeout: numOrNull(v) })} placeholder="60" mono />
              </Field>
            </div>

            <Field
              label="API key"
              hint={
                form.secondary.has_key
                  ? "A key is configured. Leave blank to keep it; enter a value to replace it (required to test)."
                  : "The secondary needs `service https api keys id <id> key '<key>'` matching this value."
              }
            >
              <TextInput value={form.secondary.key ?? ""} onChange={(v) => setSecondary({ key: v || null })} placeholder={form.secondary.has_key ? "•••••••• (unchanged)" : "shared-secret"} mono />
            </Field>
            <div className="flex items-center gap-3">
              <Button kind="secondary" icon="connect" onClick={runTest} disabled={testing}>
                {testing ? "Testing…" : "Test Connection"}
              </Button>
              {testResult && (
                <span className="inline-flex items-center gap-[6px]" style={{ fontSize: 12 }}>
                  {testResult.authenticated ? (
                    <>
                      <span className="badge badge-ok">Authenticated</span>
                      {testResult.version && (
                        <span style={{ color: "var(--cds-alias-typography-color-400)" }}>
                          <span className="mono">{testResult.version}</span>
                        </span>
                      )}
                    </>
                  ) : testResult.reachable ? (
                    <>
                      <span className="badge badge-warn">Key Rejected</span>
                      {testResult.error && (
                        <span style={{ color: "var(--cds-alias-typography-color-400)" }}>{testResult.error}</span>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="badge badge-crit">Unreachable</span>
                      {testResult.error && (
                        <span style={{ color: "var(--cds-alias-typography-color-400)" }}>{testResult.error}</span>
                      )}
                    </>
                  )}
                </span>
              )}
            </div>

            <Field label="Sections to sync" hint="Pick a top-level section, and optionally one sub-element (e.g. protocols → ospf).">
              <SectionsEditor sections={form.sections} onChange={(s) => setForm((f) => ({ ...f, sections: s }))} />
            </Field>

            <ErrorText msg={errorMsg} />
          </div>
          <div className="card-footer">
            <Button kind="primary" onClick={save} disabled={saving}>
              {saving ? "Applying…" : "Save Sync Settings"}
            </Button>
            <Button kind="ghost" icon="refresh" onClick={load}>Reload</Button>
          </div>
        </div>
      )}
    </div>
  );
}
