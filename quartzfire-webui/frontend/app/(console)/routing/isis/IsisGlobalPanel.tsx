"use client";

import { useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Switch } from "@/components/ui/Switch";
import { Button } from "@/components/ui/Button";
import {
  applyIsisGlobal,
  IsisDefaultOriginate,
  IsisGlobal,
  IsisLevel,
  IsisMetricStyle,
  IsisRedistLevel,
  IsisRedistribute,
  ISIS_REDIST_IPV4,
  ISIS_REDIST_IPV6,
} from "@/lib/isis";

const inputStyle = { maxWidth: "none", width: "100%" } as const;
const monoStyle = { ...inputStyle, fontFamily: "var(--qz-font-mono)" } as const;

function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="clr-form-control" style={{ marginTop: 0 }}>
      <label className="clr-control-label">
        {label} {required && <span className="clr-required">*</span>}
      </label>
      {children}
      {hint && <div className="clr-subtext">{hint}</div>}
    </div>
  );
}

/// Section break inside the single settings card, styled after the DC
/// reference's "L2VPN EVPN" divider caption.
function DividerCaption({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        borderTop: "1px solid var(--cds-alias-object-border-subtle)",
        paddingTop: 12,
        fontSize: 12,
        fontWeight: 600,
        color: "var(--cds-alias-typography-color-450)",
      }}
    >
      {children}
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

const REDIST_LEVELS: IsisRedistLevel[] = ["level-1", "level-2"];

/// A checkbox matrix: one row per protocol, an L1 and L2 checkbox per row.
function RedistMatrix({ afi, protocols, entries, onToggle }: {
  afi: "ipv4" | "ipv6";
  protocols: readonly string[];
  entries: IsisRedistribute[];
  onToggle: (afi: "ipv4" | "ipv6", protocol: string, level: IsisRedistLevel) => void;
}) {
  const has = (protocol: string, level: IsisRedistLevel) =>
    entries.some((e) => e.afi === afi && e.protocol === protocol && e.level === level);
  return (
    <div className="flex flex-col gap-1">
      <div className="grid gap-2 items-center clr-subtext" style={{ gridTemplateColumns: "1fr 70px 70px", marginTop: 0 }}>
        <span style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>{afi}</span>
        <span className="text-center">L1</span>
        <span className="text-center">L2</span>
      </div>
      {protocols.map((proto) => (
        <div key={proto} className="grid gap-2 items-center" style={{ gridTemplateColumns: "1fr 70px 70px" }}>
          <span style={{ fontSize: 13, fontFamily: "var(--qz-font-mono)", color: "var(--cds-alias-typography-color-400)" }}>{proto}</span>
          {REDIST_LEVELS.map((level) => (
            <span key={level} className="clr-checkbox-wrapper" style={{ justifyContent: "center" }}>
              <input type="checkbox" checked={has(proto, level)} onChange={() => onToggle(afi, proto, level)} />
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/// Editable inline panel for the global `protocols isis` settings. Diffs against
/// `live` and applies under commit-confirm on Save.
export function IsisGlobalPanel({ live, onSaved }: { live: IsisGlobal; onSaved: (message: string) => void }) {
  const [net, setNet] = useState(live.net ?? "");
  const [level, setLevel] = useState<IsisLevel | "">(live.level ?? "");
  const [metricStyle, setMetricStyle] = useState<IsisMetricStyle | "">(live.metric_style ?? "");
  const [dynamicHostname, setDynamicHostname] = useState(live.dynamic_hostname);
  const [attachedBit, setAttachedBit] = useState(live.set_attached_bit);
  const [overloadBit, setOverloadBit] = useState(live.set_overload_bit);
  const [lspGen, setLspGen] = useState(numStr(live.lsp_gen_interval));
  const [lspRefresh, setLspRefresh] = useState(numStr(live.lsp_refresh_interval));
  const [spfInterval, setSpfInterval] = useState(numStr(live.spf_interval));

  const [redist, setRedist] = useState<IsisRedistribute[]>(live.redistribute);
  const [originate, setOriginate] = useState<IsisDefaultOriginate[]>(live.default_originate);

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const toggleRedist = (afi: "ipv4" | "ipv6", protocol: string, level: IsisRedistLevel) =>
    setRedist((p) => {
      const idx = p.findIndex((e) => e.afi === afi && e.protocol === protocol && e.level === level);
      return idx >= 0 ? p.filter((_, i) => i !== idx) : [...p, { afi, protocol, level }];
    });

  const hasOriginate = (afi: "ipv4" | "ipv6", level: IsisRedistLevel) =>
    originate.some((e) => e.afi === afi && e.level === level);
  const toggleOriginate = (afi: "ipv4" | "ipv6", level: IsisRedistLevel) =>
    setOriginate((p) => {
      const idx = p.findIndex((e) => e.afi === afi && e.level === level);
      return idx >= 0 ? p.filter((_, i) => i !== idx) : [...p, { afi, level }];
    });

  const desired: IsisGlobal = useMemo(() => ({
    net: net.trim() || null,
    level: level === "" ? null : level,
    metric_style: metricStyle === "" ? null : metricStyle,
    dynamic_hostname: dynamicHostname,
    set_attached_bit: attachedBit,
    set_overload_bit: overloadBit,
    lsp_gen_interval: numOrNull(lspGen),
    lsp_refresh_interval: numOrNull(lspRefresh),
    spf_interval: numOrNull(spfInterval),
    redistribute: redist,
    default_originate: originate,
  }), [net, level, metricStyle, dynamicHostname, attachedBit, overloadBit, lspGen, lspRefresh, spfInterval, redist, originate]);

  const save = async () => {
    setError("");
    if (!net.trim()) {
      setError("A Network Entity Title (NET) is required for IS-IS to run.");
      return;
    }
    setSaving(true);
    try {
      const applied = await applyIsisGlobal(live, desired);
      onSaved(applied === 0 ? "No changes — IS-IS config already matches." : `Applied ${applied} IS-IS change${applied === 1 ? "" : "s"}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to apply IS-IS settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: 720 }}>
      <div className="card-block flex flex-col gap-4">
        <Field label="Network Entity Title (NET)" required hint="Area + system-id + NSEL.">
          <input value={net} onChange={(e) => setNet(e.target.value)} placeholder="49.0001.1921.6800.1002.00" className="clr-input" style={monoStyle} />
        </Field>
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="IS type (level)">
            <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
              <select value={level} onChange={(e) => setLevel(e.target.value as IsisLevel | "")} className="clr-select" style={inputStyle}>
                <option value="">Default (level-1-2)</option>
                <option value="level-1">level-1</option>
                <option value="level-1-2">level-1-2</option>
                <option value="level-2">level-2</option>
              </select>
            </div>
          </Field>
          <Field label="Metric style">
            <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
              <select value={metricStyle} onChange={(e) => setMetricStyle(e.target.value as IsisMetricStyle | "")} className="clr-select" style={inputStyle}>
                <option value="">Default (narrow)</option>
                <option value="narrow">narrow</option>
                <option value="transition">transition</option>
                <option value="wide">wide</option>
              </select>
            </div>
          </Field>
        </div>

        <div className="flex flex-col" style={{ gap: 8 }}>
          <Toggle on={dynamicHostname} onChange={setDynamicHostname} label="Dynamic hostname — show peer hostnames instead of system-ids" />
          <Toggle on={attachedBit} onChange={setAttachedBit} label="Set attached bit" />
          <Toggle on={overloadBit} onChange={setOverloadBit} label="Set overload bit — advertise as transit-unusable (maintenance drain)" />
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
          <Field label="LSP gen interval"><input value={lspGen} onChange={(e) => setLspGen(e.target.value)} placeholder="30" className="clr-input" style={monoStyle} /></Field>
          <Field label="LSP refresh interval"><input value={lspRefresh} onChange={(e) => setLspRefresh(e.target.value)} placeholder="900" className="clr-input" style={monoStyle} /></Field>
          <Field label="SPF interval"><input value={spfInterval} onChange={(e) => setSpfInterval(e.target.value)} placeholder="1" className="clr-input" style={monoStyle} /></Field>
        </div>

        <DividerCaption>Redistribution</DividerCaption>
        <div className="grid gap-6" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <RedistMatrix afi="ipv4" protocols={ISIS_REDIST_IPV4} entries={redist} onToggle={toggleRedist} />
          <RedistMatrix afi="ipv6" protocols={ISIS_REDIST_IPV6} entries={redist} onToggle={toggleRedist} />
        </div>

        <DividerCaption>Originated Default Route</DividerCaption>
        <div className="flex flex-col gap-1">
          <div className="grid gap-2 items-center clr-subtext" style={{ gridTemplateColumns: "1fr 70px 70px", marginTop: 0 }}>
            <span />
            <span className="text-center">L1</span>
            <span className="text-center">L2</span>
          </div>
          {(["ipv4", "ipv6"] as const).map((afi) => (
            <div key={afi} className="grid gap-2 items-center" style={{ gridTemplateColumns: "1fr 70px 70px" }}>
              <span style={{ fontSize: 13, fontFamily: "var(--qz-font-mono)", color: "var(--cds-alias-typography-color-400)" }}>{afi}</span>
              {REDIST_LEVELS.map((level) => (
                <span key={level} className="clr-checkbox-wrapper" style={{ justifyContent: "center" }}>
                  <input type="checkbox" checked={hasOriginate(afi, level)} onChange={() => toggleOriginate(afi, level)} />
                </span>
              ))}
            </div>
          ))}
        </div>

        {error && (
          <div className="alert alert-danger alert-sm">
            <Icon shape="exclamation-circle" size={14} className="alert-icon" />
            <div className="alert-text">{error}</div>
          </div>
        )}
      </div>
      <div className="card-footer">
        <Button kind="primary" onClick={save} disabled={saving}>
          {saving ? "Applying…" : "Save IS-IS Settings"}
        </Button>
      </div>
    </div>
  );
}
