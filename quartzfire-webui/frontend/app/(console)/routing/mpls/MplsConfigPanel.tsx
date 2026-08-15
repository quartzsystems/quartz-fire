"use client";

import { useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Switch } from "@/components/ui/Switch";
import { Button } from "@/components/ui/Button";
import {
  applyMpls,
  emptyTargeted,
  LdpNeighbor,
  MplsConfig,
  TargetedAf,
} from "@/lib/mpls";

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

// Keyed rows so React reconciles list edits without index churn.
let keyCounter = 0;
const nextKey = () => `mpls-row-${keyCounter++}`;

const numOrNull = (s: string) => {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isInteger(n) ? n : null;
};
const numStr = (n: number | null) => (n == null ? "" : String(n));

// ── LDP interface rows ──────────────────────────────────────────────────────

interface IfRow { key: string; name: string; disableHello: boolean }
interface NeighborRow { key: string; address: string; password: string; holdtime: string; ttl: string }

export function MplsConfigPanel({ live, onSaved }: { live: MplsConfig; onSaved: (message: string) => void }) {
  // MPLS forwarding + global parameters.
  const [interfaces, setInterfaces] = useState<{ key: string; value: string }[]>(
    live.interfaces.map((v) => ({ key: nextKey(), value: v })),
  );
  const [noPropagateTtl, setNoPropagateTtl] = useState(live.no_propagate_ttl);
  const [maximumTtl, setMaximumTtl] = useState(numStr(live.maximum_ttl));

  // LDP global.
  const [routerId, setRouterId] = useState(live.ldp_router_id ?? "");
  const [ciscoInterop, setCiscoInterop] = useState(live.cisco_interop_tlv);
  const [orderedControl, setOrderedControl] = useState(live.ordered_control);
  const [preferIpv4, setPreferIpv4] = useState(live.transport_prefer_ipv4);

  const [ldpIfs, setLdpIfs] = useState<IfRow[]>(
    live.ldp_interfaces.map((i) => ({ key: nextKey(), name: i.name, disableHello: i.disable_establish_hello })),
  );

  // Discovery.
  const [transportV4, setTransportV4] = useState(live.transport_ipv4_address ?? "");
  const [transportV6, setTransportV6] = useState(live.transport_ipv6_address ?? "");
  const [helloV4Int, setHelloV4Int] = useState(numStr(live.hello_ipv4_interval));
  const [helloV4Hold, setHelloV4Hold] = useState(numStr(live.hello_ipv4_holdtime));
  const [sessV4Hold, setSessV4Hold] = useState(numStr(live.session_ipv4_holdtime));
  const [helloV6Int, setHelloV6Int] = useState(numStr(live.hello_ipv6_interval));
  const [helloV6Hold, setHelloV6Hold] = useState(numStr(live.hello_ipv6_holdtime));
  const [sessV6Hold, setSessV6Hold] = useState(numStr(live.session_ipv6_holdtime));

  // Neighbors.
  const [neighbors, setNeighbors] = useState<NeighborRow[]>(
    live.neighbors.map((n) => ({
      key: nextKey(),
      address: n.address,
      password: n.password ?? "",
      holdtime: numStr(n.session_holdtime),
      ttl: n.ttl_security ?? "",
    })),
  );

  // Targeted neighbors.
  const [t4, setT4] = useState<TargetedAf>(live.targeted_ipv4);
  const [t6, setT6] = useState<TargetedAf>(live.targeted_ipv6);

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const desired: MplsConfig = useMemo(() => ({
    interfaces: interfaces.map((r) => r.value.trim()).filter(Boolean),
    no_propagate_ttl: noPropagateTtl,
    maximum_ttl: numOrNull(maximumTtl),
    ldp_router_id: routerId.trim() || null,
    ldp_interfaces: ldpIfs
      .filter((r) => r.name.trim())
      .map((r) => ({ name: r.name.trim(), disable_establish_hello: r.disableHello })),
    transport_ipv4_address: transportV4.trim() || null,
    transport_ipv6_address: transportV6.trim() || null,
    hello_ipv4_interval: numOrNull(helloV4Int),
    hello_ipv4_holdtime: numOrNull(helloV4Hold),
    session_ipv4_holdtime: numOrNull(sessV4Hold),
    hello_ipv6_interval: numOrNull(helloV6Int),
    hello_ipv6_holdtime: numOrNull(helloV6Hold),
    session_ipv6_holdtime: numOrNull(sessV6Hold),
    neighbors: neighbors
      .filter((r) => r.address.trim())
      .map((r): LdpNeighbor => ({
        address: r.address.trim(),
        password: r.password.trim() || null,
        session_holdtime: numOrNull(r.holdtime),
        ttl_security: r.ttl.trim() || null,
      })),
    cisco_interop_tlv: ciscoInterop,
    ordered_control: orderedControl,
    transport_prefer_ipv4: preferIpv4,
    targeted_ipv4: t4,
    targeted_ipv6: t6,
  }), [interfaces, noPropagateTtl, maximumTtl, routerId, ldpIfs, transportV4, transportV6, helloV4Int, helloV4Hold, sessV4Hold, helloV6Int, helloV6Hold, sessV6Hold, neighbors, ciscoInterop, orderedControl, preferIpv4, t4, t6]);

  const save = async () => {
    setError("");
    // Reject duplicate LDP neighbor / MPLS interface keys — VyOS would silently
    // collapse them, and the diff keys by name/address.
    const addrs = desired.neighbors.map((n) => n.address);
    if (new Set(addrs).size !== addrs.length) {
      setError("Duplicate LDP neighbor address.");
      return;
    }
    setSaving(true);
    try {
      const applied = await applyMpls(live, desired);
      onSaved(applied === 0 ? "No changes — MPLS config already matches." : `Applied ${applied} MPLS change${applied === 1 ? "" : "s"}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to apply MPLS settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 max-w-[1100px]">
      {/* The section stack is long, so on wide screens flow it into two balanced
          columns (single column below xl). Each section is kept intact across
          the column break; the per-section bottom margin is the inter-section
          gap the flex `gap-4` gives in single-column mode. */}
      <div className="columns-1 xl:columns-2 [column-gap:16px] [&>*]:mb-4 [&>*]:break-inside-avoid">
      <Section title="MPLS Forwarding" subtitle="Interfaces that push/pop MPLS labels, and label-header parameters.">
        <ListEditor
          label="MPLS interfaces"
          addLabel="Add Interface"
          placeholder="eth1"
          mono
          emptyText="No interfaces have MPLS forwarding enabled."
          rows={interfaces}
          onAdd={() => setInterfaces((p) => [...p, { key: nextKey(), value: "" }])}
          onChange={(key, value) => setInterfaces((p) => p.map((r) => (r.key === key ? { ...r, value } : r)))}
          onRemove={(key) => setInterfaces((p) => p.filter((r) => r.key !== key))}
        />
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Maximum TTL" hint="MPLS header TTL ceiling (1–255, default 255).">
            <input value={maximumTtl} onChange={(e) => setMaximumTtl(e.target.value)} placeholder="255" className="clr-input" style={monoStyle} />
          </Field>
          <div className="flex items-end">
            <Toggle on={noPropagateTtl} onChange={setNoPropagateTtl} label="Do not propagate TTL" hint="Hide the LSP hop-count from traceroute (uniform → pipe model)." />
          </div>
        </div>
      </Section>

      <Section title="LDP Router" subtitle="Label Distribution Protocol identity and protocol behaviour.">
        <Field label="LDP Router ID" hint="The LSR-id, usually a loopback address.">
          <input value={routerId} onChange={(e) => setRouterId(e.target.value)} placeholder="192.0.2.1" className="clr-input" style={monoStyle} />
        </Field>
        <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Toggle on={orderedControl} onChange={setOrderedControl} label="Ordered control" hint="Only advertise a label once the downstream label is known." />
          <Toggle on={preferIpv4} onChange={setPreferIpv4} label="Prefer IPv4 transport" hint="For dual-stack sessions, use the IPv4 transport address." />
          <Toggle on={ciscoInterop} onChange={setCiscoInterop} label="Cisco interop TLV" hint="Non-compliant dual-stack TLV negotiation for Cisco peers." />
        </div>
      </Section>

      <Section title="LDP Interfaces" subtitle="Interfaces that run LDP and form hello adjacencies.">
        <div className="flex items-center justify-between">
          <span className="clr-control-label" style={{ marginBottom: 0 }}>Interfaces</span>
          <button
            type="button"
            onClick={() => setLdpIfs((p) => [...p, { key: nextKey(), name: "", disableHello: false }])}
            className="btn btn-sm btn-link-neutral"
          >
            <Icon shape="plus" size={12} /> Add Interface
          </button>
        </div>
        {ldpIfs.length === 0 ? (
          <p className="clr-subtext" style={{ margin: 0 }}>No interfaces run LDP.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {ldpIfs.map((r) => (
              <div key={r.key} className="flex items-center gap-3">
                <input value={r.name} onChange={(e) => setLdpIfs((p) => p.map((x) => (x.key === r.key ? { ...x, name: e.target.value } : x)))} placeholder="eth1" className="clr-input" style={monoStyle} />
                <label className="flex items-center gap-2 whitespace-nowrap cursor-pointer select-none" style={{ fontSize: 12, color: "var(--cds-alias-typography-color-300)" }}>
                  <Switch on={r.disableHello} onChange={(v) => setLdpIfs((p) => p.map((x) => (x.key === r.key ? { ...x, disableHello: v } : x)))} />
                  No triggered hello
                </label>
                <button
                  type="button"
                  onClick={() => setLdpIfs((p) => p.filter((x) => x.key !== r.key))}
                  title="Remove interface"
                  aria-label="Remove interface"
                  className="btn btn-sm btn-link-neutral btn-icon"
                >
                  <Icon shape="trash" size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Discovery" subtitle="Transport addresses and hello / session timers.">
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="IPv4 Transport Address"><input value={transportV4} onChange={(e) => setTransportV4(e.target.value)} placeholder="192.0.2.1" className="clr-input" style={monoStyle} /></Field>
          <Field label="IPv6 Transport Address"><input value={transportV6} onChange={(e) => setTransportV6(e.target.value)} placeholder="2001:db8::1" className="clr-input" style={monoStyle} /></Field>
        </div>
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
          <Field label="IPv4 Hello Interval"><input value={helloV4Int} onChange={(e) => setHelloV4Int(e.target.value)} placeholder="5" className="clr-input" style={monoStyle} /></Field>
          <Field label="IPv4 Hello Holdtime"><input value={helloV4Hold} onChange={(e) => setHelloV4Hold(e.target.value)} placeholder="15" className="clr-input" style={monoStyle} /></Field>
          <Field label="IPv4 Session Holdtime"><input value={sessV4Hold} onChange={(e) => setSessV4Hold(e.target.value)} placeholder="180" className="clr-input" style={monoStyle} /></Field>
          <Field label="IPv6 Hello Interval"><input value={helloV6Int} onChange={(e) => setHelloV6Int(e.target.value)} placeholder="5" className="clr-input" style={monoStyle} /></Field>
          <Field label="IPv6 Hello Holdtime"><input value={helloV6Hold} onChange={(e) => setHelloV6Hold(e.target.value)} placeholder="15" className="clr-input" style={monoStyle} /></Field>
          <Field label="IPv6 Session Holdtime"><input value={sessV6Hold} onChange={(e) => setSessV6Hold(e.target.value)} placeholder="180" className="clr-input" style={monoStyle} /></Field>
        </div>
      </Section>

      <Section title="LDP Neighbors" subtitle="Per-peer authentication and session tuning (keyed by LSR-id).">
        <div className="flex items-center justify-between">
          <span className="clr-control-label" style={{ marginBottom: 0 }}>Neighbors</span>
          <button
            type="button"
            onClick={() => setNeighbors((p) => [...p, { key: nextKey(), address: "", password: "", holdtime: "", ttl: "" }])}
            className="btn btn-sm btn-link-neutral"
          >
            <Icon shape="plus" size={12} /> Add Neighbor
          </button>
        </div>
        {neighbors.length === 0 ? (
          <p className="clr-subtext" style={{ margin: 0 }}>No per-neighbor LDP settings.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid gap-2 clr-subtext" style={{ gridTemplateColumns: "1.4fr 1.4fr 1fr 1fr 36px", marginTop: 0 }}>
              <span>Address</span><span>Password</span><span>Session holdtime</span><span>TTL security</span><span />
            </div>
            {neighbors.map((r) => (
              <div key={r.key} className="grid gap-2 items-center" style={{ gridTemplateColumns: "1.4fr 1.4fr 1fr 1fr 36px" }}>
                <input value={r.address} onChange={(e) => setNeighbors((p) => p.map((x) => (x.key === r.key ? { ...x, address: e.target.value } : x)))} placeholder="192.0.2.2" className="clr-input" style={monoStyle} />
                <input value={r.password} onChange={(e) => setNeighbors((p) => p.map((x) => (x.key === r.key ? { ...x, password: e.target.value } : x)))} placeholder="secret" type="password" className="clr-input" style={inputStyle} />
                <input value={r.holdtime} onChange={(e) => setNeighbors((p) => p.map((x) => (x.key === r.key ? { ...x, holdtime: e.target.value } : x)))} placeholder="180" className="clr-input" style={monoStyle} />
                <input value={r.ttl} onChange={(e) => setNeighbors((p) => p.map((x) => (x.key === r.key ? { ...x, ttl: e.target.value } : x)))} placeholder="disable / 1-254" className="clr-input" style={monoStyle} />
                <button
                  type="button"
                  onClick={() => setNeighbors((p) => p.filter((x) => x.key !== r.key))}
                  title="Remove neighbor"
                  aria-label="Remove neighbor"
                  className="btn btn-sm btn-link-neutral btn-icon"
                >
                  <Icon shape="trash" size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>

      <TargetedSection af="IPv4" value={t4} onChange={setT4} placeholder="192.0.2.9" />
      <TargetedSection af="IPv6" value={t6} onChange={setT6} placeholder="2001:db8::9" />
      </div>

      {error && (
        <div className="alert alert-danger alert-sm">
          <Icon shape="exclamation-circle" size={14} className="alert-icon" />
          <div className="alert-text">{error}</div>
        </div>
      )}

      <div className="flex justify-end">
        <Button kind="primary" onClick={save} disabled={saving}>
          {saving ? "Applying…" : "Save MPLS Settings"}
        </Button>
      </div>
    </div>
  );
}

// ── reusable list editor (single-value rows) ────────────────────────────────

function ListEditor({
  label, addLabel, placeholder, emptyText, mono, rows, onAdd, onChange, onRemove,
}: {
  label: string;
  addLabel: string;
  placeholder: string;
  emptyText: string;
  mono?: boolean;
  rows: { key: string; value: string }[];
  onAdd: () => void;
  onChange: (key: string, value: string) => void;
  onRemove: (key: string) => void;
}) {
  return (
    <div className="clr-form-control" style={{ marginTop: 0 }}>
      <div className="flex items-center justify-between">
        <label className="clr-control-label" style={{ marginBottom: 0 }}>{label}</label>
        <button type="button" onClick={onAdd} className="btn btn-sm btn-link-neutral">
          <Icon shape="plus" size={12} /> {addLabel}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="clr-subtext" style={{ margin: 0 }}>{emptyText}</p>
      ) : (
        <div className="flex flex-col gap-2" style={{ marginTop: 6 }}>
          {rows.map((r) => (
            <div key={r.key} className="flex items-center gap-2">
              <input value={r.value} onChange={(e) => onChange(r.key, e.target.value)} placeholder={placeholder} className="clr-input" style={mono ? monoStyle : inputStyle} />
              <button
                type="button"
                onClick={() => onRemove(r.key)}
                title="Remove"
                aria-label="Remove"
                className="btn btn-sm btn-link-neutral btn-icon"
              >
                <Icon shape="trash" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── targeted-neighbor section (per address family) ──────────────────────────

function TargetedSection({ af, value, onChange, placeholder }: { af: "IPv4" | "IPv6"; value: TargetedAf; onChange: (v: TargetedAf) => void; placeholder: string }) {
  const set = (partial: Partial<TargetedAf>) => onChange({ ...value, ...partial });
  const addrRows = value.addresses.map((a, i) => ({ key: `${af}-${i}-${a}`, value: a }));
  return (
    <Section title={`Targeted Neighbors — ${af}`} subtitle="Extended (targeted) LDP discovery for non-directly-connected peers.">
      <Toggle on={value.enable} onChange={(v) => set({ enable: v })} label={`Accept targeted ${af} sessions`} />
      <ListEditor
        label="Targeted addresses"
        addLabel="Add Address"
        placeholder={placeholder}
        mono
        emptyText="No targeted addresses — sessions are accepted only."
        rows={addrRows}
        onAdd={() => set({ addresses: [...value.addresses, ""] })}
        onChange={(key, v) => {
          const idx = addrRows.findIndex((r) => r.key === key);
          const next = [...value.addresses];
          next[idx] = v;
          set({ addresses: next });
        }}
        onRemove={(key) => {
          const idx = addrRows.findIndex((r) => r.key === key);
          set({ addresses: value.addresses.filter((_, i) => i !== idx) });
        }}
      />
      <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <Field label="Hello Interval">
          <input value={numStr(value.hello_interval)} onChange={(e) => set({ hello_interval: numOrNull(e.target.value) })} placeholder="10" className="clr-input" style={monoStyle} />
        </Field>
        <Field label="Hello Holdtime">
          <input value={numStr(value.hello_holdtime)} onChange={(e) => set({ hello_holdtime: numOrNull(e.target.value) })} placeholder="30" className="clr-input" style={monoStyle} />
        </Field>
      </div>
    </Section>
  );
}
