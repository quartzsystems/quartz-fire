"use client";

import { useState } from "react";
import { Field, TextInput, ErrorText, numOrNull } from "../formkit";
import { VrrpGlobalParameters, applyGlobal } from "@/lib/vrrp";

/// The single `high-availability vrrp global-parameters` node — startup delay,
/// default protocol version, and gratuitous-ARP tuning applied to every group.
export function GlobalParametersPanel({
  live,
  onSaved,
}: {
  live: VrrpGlobalParameters;
  onSaved: (message: string) => void;
}) {
  const [g, setG] = useState<VrrpGlobalParameters>(live);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const setGarp = (patch: Partial<VrrpGlobalParameters["garp"]>) =>
    setG((p) => ({ ...p, garp: { ...p.garp, ...patch } }));

  const save = async () => {
    setError("");
    setSaving(true);
    try {
      const applied = await applyGlobal(live, g);
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to global parameters.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <div className="card-block flex flex-col gap-4">
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Startup delay (s)">
            <TextInput value={g.startup_delay?.toString() ?? ""} onChange={(v) => setG((p) => ({ ...p, startup_delay: numOrNull(v) }))} placeholder="0" mono />
          </Field>
          <Field label="Version">
            <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
              <select
                value={g.version == null ? "" : String(g.version)}
                onChange={(e) =>
                  setG((p) => ({ ...p, version: e.target.value === "" ? null : Number(e.target.value) }))
                }
                className="clr-select"
                style={{ maxWidth: "none", width: "100%" }}
              >
                <option value="">Default</option>
                <option value="3">3</option>
                <option value="2">2</option>
              </select>
            </div>
          </Field>
        </div>

        <div className="clr-smallcaption">
          Gratuitous ARP
        </div>
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
          <Field label="Interval (s)">
            <TextInput value={g.garp.interval ?? ""} onChange={(v) => setGarp({ interval: v || null })} placeholder="0.000" mono />
          </Field>
          <Field label="Master delay">
            <TextInput value={g.garp.master_delay?.toString() ?? ""} onChange={(v) => setGarp({ master_delay: numOrNull(v) })} placeholder="5" mono />
          </Field>
          <Field label="Master repeat">
            <TextInput value={g.garp.master_repeat?.toString() ?? ""} onChange={(v) => setGarp({ master_repeat: numOrNull(v) })} placeholder="5" mono />
          </Field>
          <Field label="Master refresh">
            <TextInput value={g.garp.master_refresh?.toString() ?? ""} onChange={(v) => setGarp({ master_refresh: numOrNull(v) })} placeholder="0" mono />
          </Field>
          <Field label="Refresh repeat">
            <TextInput value={g.garp.master_refresh_repeat?.toString() ?? ""} onChange={(v) => setGarp({ master_refresh_repeat: numOrNull(v) })} placeholder="1" mono />
          </Field>
        </div>

        <ErrorText msg={error} />
      </div>
      <div className="card-footer">
        <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? "Applying…" : "Save VRRP Settings"}
        </button>
      </div>
    </div>
  );
}
