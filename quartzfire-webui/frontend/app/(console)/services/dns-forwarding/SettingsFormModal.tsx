"use client";

import { useState } from "react";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { applyDnsForwarding, DnsForwardingConfig } from "@/lib/services";

const mono = { maxWidth: "none", fontFamily: "var(--qz-font-mono)" } as const;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="clr-form-control" style={{ marginTop: 0 }}>
      <label className="clr-control-label">{label}</label>
      {children}
      {hint && <div className="clr-subtext">{hint}</div>}
    </div>
  );
}

const IP_RE = /^[0-9a-f.:]+$/i;
const IP_OR_CIDR_RE = /^[0-9a-f.:/]+$/i;

// VyOS `dnssec` mode values.
const DNSSEC_MODES = ["", "off", "process-no-validate", "process", "log-fail", "validate"];

/// Edit the recursive DNS forwarder settings. Diffs against the live config
/// and commits immediately (the boot-config save runs in the background).
export function SettingsFormModal({
  live,
  onClose,
  onSaved,
}: {
  live: DnsForwardingConfig;
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const [listenText, setListenText] = useState(live.listen_addresses.join("\n"));
  const [allowText, setAllowText] = useState(live.allow_from.join("\n"));
  const [serversText, setServersText] = useState(live.name_servers.join("\n"));
  const [system, setSystem] = useState(live.system);
  const [cacheSize, setCacheSize] = useState(live.cache_size ?? "");
  const [dnssec, setDnssec] = useState(live.dnssec ?? "");

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const lines = (text: string) => text.split("\n").map((s) => s.trim()).filter(Boolean);
    const listen = lines(listenText);
    const allow = lines(allowText);
    const servers = lines(serversText);

    if (listen.length === 0) {
      setError("Add at least one listen address — the forwarder must bind somewhere.");
      return;
    }
    if (allow.length === 0) {
      setError("Add at least one allow-from network — VyOS requires it.");
      return;
    }
    const badListen = listen.find((s) => !IP_RE.test(s));
    if (badListen) {
      setError(`"${badListen}" is not a valid listen address.`);
      return;
    }
    const badAllow = allow.find((s) => !IP_OR_CIDR_RE.test(s));
    if (badAllow) {
      setError(`"${badAllow}" is not a valid network.`);
      return;
    }
    const badServer = servers.find((s) => !IP_RE.test(s));
    if (badServer) {
      setError(`"${badServer}" is not a valid name server address.`);
      return;
    }
    if (cacheSize.trim() && !/^\d+$/.test(cacheSize.trim())) {
      setError("Cache size must be a whole number of entries.");
      return;
    }

    setSaving(true);
    try {
      const applied = await applyDnsForwarding(live, {
        listen_addresses: listen,
        allow_from: allow,
        name_servers: servers,
        system,
        cache_size: cacheSize.trim() || null,
        dnssec: dnssec || null,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to DNS forwarding.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply DNS forwarding settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={560}>
      <ModalHeader
        title="Edit DNS Forwarding"
        subtitle="Recursive DNS forwarder / cache configuration"
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Listen addresses" hint="One address per line the forwarder binds to.">
            <textarea
              value={listenText}
              onChange={(e) => setListenText(e.target.value)}
              placeholder={"192.168.1.1"}
              rows={3}
              className="clr-textarea"
              style={mono}
            />
          </Field>
          <Field label="Allow from" hint="One client network (CIDR) per line.">
            <textarea
              value={allowText}
              onChange={(e) => setAllowText(e.target.value)}
              placeholder={"192.168.1.0/24"}
              rows={3}
              className="clr-textarea"
              style={mono}
            />
          </Field>
        </div>

        <Field label="Upstream name servers" hint="One address per line. Leave empty to recurse from the roots or use system servers.">
          <textarea
            value={serversText}
            onChange={(e) => setServersText(e.target.value)}
            placeholder={"1.1.1.1\n8.8.8.8"}
            rows={3}
            className="clr-textarea"
            style={mono}
          />
        </Field>

        <label className="clr-toggle-wrapper cursor-pointer select-none">
          <Switch on={system} onChange={setSystem} />
          <span style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>
            Also forward to the system name servers
          </span>
        </label>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Cache size" hint="Entries; defaults to 10000 when unset.">
            <input
              type="number"
              min={0}
              value={cacheSize}
              onChange={(e) => setCacheSize(e.target.value)}
              placeholder="10000"
              className="clr-input"
              style={mono}
            />
          </Field>
          <Field label="DNSSEC">
            <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
              <select
                value={dnssec}
                onChange={(e) => setDnssec(e.target.value)}
                className="clr-select"
                style={mono}
              >
                {DNSSEC_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m === "" ? "default (process-no-validate)" : m}
                  </option>
                ))}
              </select>
            </div>
          </Field>
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
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "Applying…" : "Apply Changes"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
