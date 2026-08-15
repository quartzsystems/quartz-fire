"use client";

import { useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Switch } from "@/components/ui/Switch";
import { Button } from "@/components/ui/Button";
import { applyOspfGlobal, OspfGlobal, OSPF_REDISTRIBUTE, OspfRedistribute } from "@/lib/ospf";

const inputStyle = { maxWidth: "none", width: "100%" } as const;
const monoStyle = { ...inputStyle, fontFamily: "var(--qz-font-mono)" } as const;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="clr-form-control" style={{ marginTop: 0 }}>
      <label className="clr-control-label">{label}</label>
      {children}
      {hint && <div className="clr-subtext">{hint}</div>}
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ marginTop: 0 }}>
      <div className="card-header">{title}</div>
      <div className="card-block flex flex-col gap-4">
        {subtitle && <p className="clr-secondary" style={{ margin: 0 }}>{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}

function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex items-start gap-[10px] cursor-pointer select-none">
      <div className="pt-[1px]"><Switch on={on} onChange={onChange} /></div>
      <span style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>
        {label}
        {hint && <span className="block clr-subtext" style={{ marginTop: 0 }}>{hint}</span>}
      </span>
    </label>
  );
}

const numOrNull = (s: string) => {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isInteger(n) ? n : null;
};
const numStr = (n: number | null) => (n == null ? "" : String(n));

/// Editable inline panel for the global `protocols ospf` settings. Diffs against
/// `live` and applies under commit-confirm on Save.
export function OspfGlobalPanel({ live, onSaved }: { live: OspfGlobal; onSaved: (message: string) => void }) {
  const [routerId, setRouterId] = useState(live.router_id ?? "");
  const [defaultMetric, setDefaultMetric] = useState(numStr(live.default_metric));
  const [refBw, setRefBw] = useState(numStr(live.reference_bandwidth));
  const [distance, setDistance] = useState(numStr(live.distance));
  const [maxPaths, setMaxPaths] = useState(numStr(live.maximum_paths));
  const [passiveDefault, setPassiveDefault] = useState(live.passive_default);
  const [logChanges, setLogChanges] = useState(live.log_adjacency_changes);
  const [logDetail, setLogDetail] = useState(live.log_adjacency_changes_detail);

  const [di, setDi] = useState(live.default_information);
  const [diAlways, setDiAlways] = useState(live.default_information_always);
  const [diMetric, setDiMetric] = useState(numStr(live.default_information_metric));
  const [diMetricType, setDiMetricType] = useState<"1" | "2" | "">(live.default_information_metric_type ?? "");

  const [redist, setRedist] = useState<OspfRedistribute[]>(live.redistribute);

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const toggleRedist = (proto: OspfRedistribute) =>
    setRedist((p) => (p.includes(proto) ? p.filter((x) => x !== proto) : [...p, proto]));

  const desired: OspfGlobal = useMemo(() => ({
    router_id: routerId.trim() || null,
    default_information: di,
    default_information_always: diAlways,
    default_information_metric: numOrNull(diMetric),
    default_information_metric_type: diMetricType === "" ? null : diMetricType,
    default_metric: numOrNull(defaultMetric),
    reference_bandwidth: numOrNull(refBw),
    distance: numOrNull(distance),
    maximum_paths: numOrNull(maxPaths),
    log_adjacency_changes: logChanges,
    log_adjacency_changes_detail: logChanges && logDetail,
    passive_default: passiveDefault,
    redistribute: redist,
  }), [routerId, di, diAlways, diMetric, diMetricType, defaultMetric, refBw, distance, maxPaths, logChanges, logDetail, passiveDefault, redist]);

  const save = async () => {
    setError("");
    setSaving(true);
    try {
      const applied = await applyOspfGlobal(live, desired);
      onSaved(applied === 0 ? "No changes — OSPF config already matches." : `Applied ${applied} OSPF change${applied === 1 ? "" : "s"}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to apply OSPF settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 max-w-[720px]">
      <Section title="Router" subtitle="Process identity and path selection.">
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Router ID" hint="Usually a loopback address.">
            <input value={routerId} onChange={(e) => setRouterId(e.target.value)} placeholder="192.0.2.1" className="clr-input" style={monoStyle} />
          </Field>
          <Field label="Reference bandwidth" hint="auto-cost reference-bandwidth (Mbit/s).">
            <input value={refBw} onChange={(e) => setRefBw(e.target.value)} placeholder="100" className="clr-input" style={monoStyle} />
          </Field>
          <Field label="Administrative distance" hint="distance global (1–255).">
            <input value={distance} onChange={(e) => setDistance(e.target.value)} placeholder="110" className="clr-input" style={monoStyle} />
          </Field>
          <Field label="Maximum paths" hint="ECMP width (1–64).">
            <input value={maxPaths} onChange={(e) => setMaxPaths(e.target.value)} placeholder="4" className="clr-input" style={monoStyle} />
          </Field>
        </div>
        <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Toggle on={passiveDefault} onChange={setPassiveDefault} label="Passive by default" hint="Every interface passive unless it opts in." />
          <Toggle on={logChanges} onChange={setLogChanges} label="Log adjacency changes" />
          {logChanges && <Toggle on={logDetail} onChange={setLogDetail} label="…with detail" />}
        </div>
      </Section>

      <Section title="Originated Default Route" subtitle="default-information originate — advertise a default into the area.">
        <Toggle on={di} onChange={setDi} label="Originate default route" />
        {di && (
          <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
            <div className="flex items-end">
              <Toggle on={diAlways} onChange={setDiAlways} label="Always" hint="Even without a default in the RIB." />
            </div>
            <Field label="Metric">
              <input value={diMetric} onChange={(e) => setDiMetric(e.target.value)} placeholder="20" className="clr-input" style={monoStyle} />
            </Field>
            <Field label="Metric type">
              <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
                <select value={diMetricType} onChange={(e) => setDiMetricType(e.target.value as "1" | "2" | "")} className="clr-select" style={inputStyle}>
                  <option value="">Default (2)</option>
                  <option value="1">Type 1</option>
                  <option value="2">Type 2</option>
                </select>
              </div>
            </Field>
          </div>
        )}
      </Section>

      <Section title="Redistribution" subtitle="Inject routes from other protocols into OSPF.">
        <div className="flex flex-wrap gap-4">
          {OSPF_REDISTRIBUTE.map((proto) => (
            <div key={proto} className="clr-checkbox-wrapper">
              <input
                type="checkbox"
                id={`ospf-redist-${proto}`}
                checked={redist.includes(proto)}
                onChange={() => toggleRedist(proto)}
              />
              <label htmlFor={`ospf-redist-${proto}`} style={{ fontFamily: "var(--qz-font-mono)" }}>{proto}</label>
            </div>
          ))}
        </div>
        <Field label="Default metric" hint="Metric applied to redistributed routes with none of their own.">
          <input value={defaultMetric} onChange={(e) => setDefaultMetric(e.target.value)} placeholder="20" className="clr-input" style={{ ...monoStyle, maxWidth: 160 }} />
        </Field>
      </Section>

      {error && (
        <div className="alert alert-danger alert-sm">
          <Icon shape="exclamation-circle" size={14} className="alert-icon" />
          <div className="alert-text">{error}</div>
        </div>
      )}

      <div className="flex justify-end">
        <Button kind="primary" onClick={save} disabled={saving}>
          {saving ? "Applying…" : "Save OSPF Settings"}
        </Button>
      </div>
    </div>
  );
}
