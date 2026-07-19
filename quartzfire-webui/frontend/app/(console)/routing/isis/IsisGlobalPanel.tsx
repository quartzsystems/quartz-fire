"use client";

import { useMemo, useState } from "react";
import { Save } from "lucide-react";
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

const inputCls = "w-full rounded-md px-3 py-[9px] text-[13px] text-[var(--qz-fg-1)] outline-none";
const inputSt = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;
const monoSt = { ...inputSt, fontFamily: "var(--qz-font-mono)" } as const;

function focusBorder(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) {
  e.currentTarget.style.borderColor = "var(--qz-accent)";
}
function blurBorder(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) {
  e.currentTarget.style.borderColor = "var(--qz-border)";
}

function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[12px] text-[var(--qz-fg-3)] mb-[6px]">
        {label} {required && <span style={{ color: "var(--qz-danger)" }}>*</span>}
      </label>
      {children}
      {hint && <p className="text-[11px] text-[var(--qz-fg-4)] m-0 mt-[5px]">{hint}</p>}
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg p-5 flex flex-col gap-4" style={{ background: "var(--qz-surface)", border: "1px solid var(--qz-border)" }}>
      <div>
        <h3 className="text-[14px] font-semibold text-[var(--qz-fg-1)] m-0">{title}</h3>
        {subtitle && <p className="text-[12px] text-[var(--qz-fg-4)] m-0 mt-[2px]">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex items-start gap-[10px] cursor-pointer select-none">
      <div className="pt-[1px]"><Switch on={on} onChange={onChange} /></div>
      <span className="text-[13px] text-[var(--qz-fg-2)]">
        {label}
        {hint && <span className="block text-[11px] text-[var(--qz-fg-4)]">{hint}</span>}
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
      <div className="grid gap-2 items-center text-[11px] text-[var(--qz-fg-4)]" style={{ gridTemplateColumns: "1fr 70px 70px" }}>
        <span className="uppercase tracking-wider">{afi}</span>
        <span className="text-center">L1</span>
        <span className="text-center">L2</span>
      </div>
      {protocols.map((proto) => (
        <div key={proto} className="grid gap-2 items-center" style={{ gridTemplateColumns: "1fr 70px 70px" }}>
          <span className="text-[13px] text-[var(--qz-fg-2)]" style={{ fontFamily: "var(--qz-font-mono)" }}>{proto}</span>
          {REDIST_LEVELS.map((level) => (
            <span key={level} className="text-center">
              <input type="checkbox" checked={has(proto, level)} onChange={() => onToggle(afi, proto, level)} style={{ accentColor: "var(--qz-accent)" }} />
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
    <div className="flex flex-col gap-4 max-w-[720px]">
      <Section title="Router" subtitle="IS-IS identity and level.">
        <Field label="Network Entity Title (NET)" required hint="e.g. 49.0001.1921.6800.1002.00 — the area + system-id + NSEL.">
          <input value={net} onChange={(e) => setNet(e.target.value)} placeholder="49.0001.1921.6800.1002.00" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
        </Field>
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="IS type (level)" hint="Which levels this router participates in.">
            <select value={level} onChange={(e) => setLevel(e.target.value as IsisLevel | "")} className={inputCls} style={inputSt} onFocus={focusBorder} onBlur={blurBorder}>
              <option value="">Default (level-1-2)</option>
              <option value="level-1">level-1</option>
              <option value="level-1-2">level-1-2</option>
              <option value="level-2">level-2</option>
            </select>
          </Field>
          <Field label="Metric style" hint="wide is required for anything but the smallest legacy network.">
            <select value={metricStyle} onChange={(e) => setMetricStyle(e.target.value as IsisMetricStyle | "")} className={inputCls} style={inputSt} onFocus={focusBorder} onBlur={blurBorder}>
              <option value="">Default (narrow)</option>
              <option value="narrow">narrow</option>
              <option value="transition">transition</option>
              <option value="wide">wide</option>
            </select>
          </Field>
        </div>
        <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Toggle on={dynamicHostname} onChange={setDynamicHostname} label="Dynamic hostname" hint="Show peer hostnames instead of system-ids." />
          <Toggle on={attachedBit} onChange={setAttachedBit} label="Set attached bit" hint="Signal L1/L2 attachment to the L2 backbone." />
          <Toggle on={overloadBit} onChange={setOverloadBit} label="Set overload bit" hint="Advertise as transit-unusable (maintenance drain)." />
        </div>
      </Section>

      <Section title="Timers" subtitle="LSP generation / refresh and SPF pacing (seconds).">
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
          <Field label="LSP gen interval"><input value={lspGen} onChange={(e) => setLspGen(e.target.value)} placeholder="30" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} /></Field>
          <Field label="LSP refresh interval"><input value={lspRefresh} onChange={(e) => setLspRefresh(e.target.value)} placeholder="900" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} /></Field>
          <Field label="SPF interval"><input value={spfInterval} onChange={(e) => setSpfInterval(e.target.value)} placeholder="1" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} /></Field>
        </div>
      </Section>

      <Section title="Redistribution" subtitle="Inject routes from other protocols, per address family and level.">
        <div className="grid gap-6" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <RedistMatrix afi="ipv4" protocols={ISIS_REDIST_IPV4} entries={redist} onToggle={toggleRedist} />
          <RedistMatrix afi="ipv6" protocols={ISIS_REDIST_IPV6} entries={redist} onToggle={toggleRedist} />
        </div>
      </Section>

      <Section title="Originated Default Route" subtitle="default-information originate — advertise a default per family and level.">
        <div className="grid gap-2 items-center text-[11px] text-[var(--qz-fg-4)]" style={{ gridTemplateColumns: "1fr 70px 70px" }}>
          <span />
          <span className="text-center">L1</span>
          <span className="text-center">L2</span>
        </div>
        {(["ipv4", "ipv6"] as const).map((afi) => (
          <div key={afi} className="grid gap-2 items-center" style={{ gridTemplateColumns: "1fr 70px 70px" }}>
            <span className="text-[13px] text-[var(--qz-fg-2)]" style={{ fontFamily: "var(--qz-font-mono)" }}>{afi}</span>
            {REDIST_LEVELS.map((level) => (
              <span key={level} className="text-center">
                <input type="checkbox" checked={hasOriginate(afi, level)} onChange={() => toggleOriginate(afi, level)} style={{ accentColor: "var(--qz-accent)" }} />
              </span>
            ))}
          </div>
        ))}
      </Section>

      {error && <p className="text-[12px] m-0" style={{ color: "var(--qz-danger)" }}>{error}</p>}

      <div className="flex justify-end">
        <Button kind="primary" icon={Save} onClick={save} disabled={saving}>
          {saving ? "Applying…" : "Save IS-IS settings"}
        </Button>
      </div>
    </div>
  );
}
