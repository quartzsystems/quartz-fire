"use client";

import { useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Switch } from "@/components/ui/Switch";
import { Button } from "@/components/ui/Button";
import { applyBgpGlobal, BgpGlobal } from "@/lib/bgp";

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

interface ListRow { key: string; value: string; }
let keyCounter = 0;
const nextKey = () => `bgp-net-${keyCounter++}`;
const toRows = (values: string[]): ListRow[] => values.map((value) => ({ key: nextKey(), value }));

/// The redistribute sources BGP accepts, per family.
const REDIST: Record<"ipv4-unicast" | "ipv6-unicast", string[]> = {
  "ipv4-unicast": ["connected", "static", "kernel", "ospf"],
  "ipv6-unicast": ["connected", "static", "kernel", "ospfv3"],
};

/// Editable inline panel for the global `protocols bgp` settings, including the
/// L2VPN-EVPN address family. Diffs against `live` and applies under commit-
/// confirm on Save.
export function BgpGlobalPanel({ live, onSaved }: { live: BgpGlobal; onSaved: (message: string) => void }) {
  const [systemAs, setSystemAs] = useState(live.system_as ?? "");
  const [routerId, setRouterId] = useState(live.router_id ?? "");
  const [clusterId, setClusterId] = useState(live.cluster_id ?? "");
  const [noV4, setNoV4] = useState(live.default_no_ipv4_unicast);
  const [multipathRelax, setMultipathRelax] = useState(live.bestpath_as_path_multipath_relax);
  const [compareRouterId, setCompareRouterId] = useState(live.bestpath_compare_routerid);
  const [logChanges, setLogChanges] = useState(live.log_neighbor_changes);

  const [v4Networks, setV4Networks] = useState<ListRow[]>(toRows(live.ipv4_unicast.networks));
  const [v4Redist, setV4Redist] = useState<string[]>(live.ipv4_unicast.redistribute);
  const [v6Networks, setV6Networks] = useState<ListRow[]>(toRows(live.ipv6_unicast.networks));
  const [v6Redist, setV6Redist] = useState<string[]>(live.ipv6_unicast.redistribute);

  const [advAllVni, setAdvAllVni] = useState(live.evpn.advertise_all_vni);
  const [advV4, setAdvV4] = useState(live.evpn.advertise_ipv4_unicast);
  const [advV6, setAdvV6] = useState(live.evpn.advertise_ipv6_unicast);

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const toggleRedist = (fam: "ipv4-unicast" | "ipv6-unicast", proto: string) => {
    const [get, set] = fam === "ipv4-unicast" ? [v4Redist, setV4Redist] : [v6Redist, setV6Redist];
    set(get.includes(proto) ? get.filter((p) => p !== proto) : [...get, proto]);
  };

  const netEditor = (rows: ListRow[], setRows: (u: (p: ListRow[]) => ListRow[]) => void, placeholder: string) => (
    <div className="clr-form-control" style={{ marginTop: 0 }}>
      <div className="flex items-center justify-between">
        <label className="clr-control-label" style={{ marginBottom: 0 }}>Advertised networks</label>
        <button
          type="button"
          onClick={() => setRows((p) => [...p, { key: nextKey(), value: "" }])}
          className="btn btn-sm btn-link-neutral"
        >
          <Icon shape="plus" size={12} /> Add Network
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="clr-subtext" style={{ margin: 0 }}>No networks originated into BGP.</p>
      ) : (
        <div className="flex flex-col gap-2" style={{ marginTop: 6 }}>
          {rows.map((r) => (
            <div key={r.key} className="flex items-center gap-2">
              <input
                value={r.value}
                onChange={(e) => setRows((p) => p.map((x) => (x.key === r.key ? { ...x, value: e.target.value } : x)))}
                placeholder={placeholder}
                className="clr-input"
                style={monoStyle}
              />
              <button
                type="button"
                onClick={() => setRows((p) => p.filter((x) => x.key !== r.key))}
                title="Remove network"
                aria-label="Remove network"
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

  const desired: BgpGlobal = useMemo(() => ({
    system_as: systemAs.trim() || null,
    router_id: routerId.trim() || null,
    cluster_id: clusterId.trim() || null,
    default_no_ipv4_unicast: noV4,
    bestpath_as_path_multipath_relax: multipathRelax,
    bestpath_compare_routerid: compareRouterId,
    log_neighbor_changes: logChanges,
    ipv4_unicast: { networks: v4Networks.map((r) => r.value.trim()).filter(Boolean), redistribute: v4Redist },
    ipv6_unicast: { networks: v6Networks.map((r) => r.value.trim()).filter(Boolean), redistribute: v6Redist },
    evpn: {
      advertise_all_vni: advAllVni,
      advertise_ipv4_unicast: advV4,
      advertise_ipv6_unicast: advV6,
    },
  }), [systemAs, routerId, clusterId, noV4, multipathRelax, compareRouterId, logChanges, v4Networks, v4Redist, v6Networks, v6Redist, advAllVni, advV4, advV6]);

  const save = async () => {
    setError("");
    const asNum = Number(systemAs.trim());
    if (!systemAs.trim() || !Number.isInteger(asNum) || asNum < 1 || asNum > 4294967295) {
      setError("System AS must be a whole number between 1 and 4294967295.");
      return;
    }
    setSaving(true);
    try {
      const applied = await applyBgpGlobal(live, desired);
      onSaved(applied === 0 ? "No changes — BGP config already matches." : `Applied ${applied} BGP change${applied === 1 ? "" : "s"}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to apply BGP settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 max-w-[720px]">
      <Section title="Router" subtitle="Local autonomous system and identity.">
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="System AS" required hint="This router's ASN.">
            <input value={systemAs} onChange={(e) => setSystemAs(e.target.value)} placeholder="65001" className="clr-input" style={monoStyle} />
          </Field>
          <Field label="Router ID" hint="Usually a loopback address.">
            <input value={routerId} onChange={(e) => setRouterId(e.target.value)} placeholder="192.0.2.1" className="clr-input" style={monoStyle} />
          </Field>
        </div>
        <Field label="Cluster ID" hint="Route-reflector cluster id (only when acting as an RR).">
          <input value={clusterId} onChange={(e) => setClusterId(e.target.value)} placeholder="192.0.2.1" className="clr-input" style={monoStyle} />
        </Field>
        <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Toggle on={noV4} onChange={setNoV4} label="No IPv4-unicast by default" hint="Peers activate address families explicitly (EVPN fabric norm)." />
          <Toggle on={multipathRelax} onChange={setMultipathRelax} label="AS-path multipath-relax" hint="ECMP across equal-length paths from different neighbours." />
          <Toggle on={compareRouterId} onChange={setCompareRouterId} label="Compare router-id" />
          <Toggle on={logChanges} onChange={setLogChanges} label="Log neighbor changes" />
        </div>
      </Section>

      <Section title="IPv4 Unicast" subtitle="Underlay IPv4 origination and redistribution.">
        {netEditor(v4Networks, setV4Networks, "10.0.0.0/24")}
        <Field label="Redistribute">
          <div className="flex flex-wrap gap-4">
            {REDIST["ipv4-unicast"].map((proto) => (
              <div key={proto} className="clr-checkbox-wrapper">
                <input
                  type="checkbox"
                  id={`bgp-redist-v4-${proto}`}
                  checked={v4Redist.includes(proto)}
                  onChange={() => toggleRedist("ipv4-unicast", proto)}
                />
                <label htmlFor={`bgp-redist-v4-${proto}`} style={{ fontFamily: "var(--qz-font-mono)" }}>{proto}</label>
              </div>
            ))}
          </div>
        </Field>
      </Section>

      <Section title="IPv6 Unicast" subtitle="Underlay IPv6 origination and redistribution.">
        {netEditor(v6Networks, setV6Networks, "2001:db8::/64")}
        <Field label="Redistribute">
          <div className="flex flex-wrap gap-4">
            {REDIST["ipv6-unicast"].map((proto) => (
              <div key={proto} className="clr-checkbox-wrapper">
                <input
                  type="checkbox"
                  id={`bgp-redist-v6-${proto}`}
                  checked={v6Redist.includes(proto)}
                  onChange={() => toggleRedist("ipv6-unicast", proto)}
                />
                <label htmlFor={`bgp-redist-v6-${proto}`} style={{ fontFamily: "var(--qz-font-mono)" }}>{proto}</label>
              </div>
            ))}
          </div>
        </Field>
      </Section>

      <Section title="L2VPN EVPN" subtitle="The overlay control plane that carries VXLAN MAC/IP routes.">
        <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Toggle on={advAllVni} onChange={setAdvAllVni} label="Advertise all VNIs" hint="Auto-advertise every locally configured VNI." />
          <Toggle on={advV4} onChange={setAdvV4} label="Advertise IPv4 unicast" hint="Inject IPv4 routes into EVPN (type-5)." />
          <Toggle on={advV6} onChange={setAdvV6} label="Advertise IPv6 unicast" />
        </div>
        <p className="clr-subtext" style={{ margin: 0 }}>
          Route-distinguisher and route-target are configured per-VNI or per-VRF, not on the global instance.
        </p>
      </Section>

      {error && (
        <div className="alert alert-danger alert-sm">
          <Icon shape="exclamation-circle" size={14} className="alert-icon" />
          <div className="alert-text">{error}</div>
        </div>
      )}

      <div className="flex justify-end">
        <Button kind="primary" onClick={save} disabled={saving}>
          {saving ? "Applying…" : "Save BGP Settings"}
        </Button>
      </div>
    </div>
  );
}
