"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  IpsecAuthMode,
  L2TP_AUTH_PROTOCOLS,
  L2tpAuthMode,
  L2tpAuthProtocol,
  L2tpGeneral,
  applyL2tpGeneral,
} from "@/lib/l2tp";

const inputSt = { maxWidth: "none" } as const;
const monoSt = { maxWidth: "none", fontFamily: "var(--qz-font-mono)" } as const;

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
    <div className="card">
      <div className="card-header flex-col items-start gap-0">
        <span className="text-[14px]">{title}</span>
        {subtitle && <span className="text-[12px] font-normal" style={{ color: "var(--cds-alias-typography-color-300)" }}>{subtitle}</span>}
      </div>
      <div className="card-block flex flex-col gap-4">{children}</div>
    </div>
  );
}

const numOrNull = (s: string) => {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isInteger(n) ? n : null;
};
const numStr = (n: number | null) => (n == null ? "" : String(n));
const toList = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

/// Editable inline panel for the server-wide `vpn l2tp remote-access` settings.
/// Diffs against `live` and applies on Save.
export function GeneralPanel({ live, pools, onSaved }: {
  live: L2tpGeneral;
  /** Configured pool names, offered for the default-pool picker. */
  pools: string[];
  onSaved: (message: string) => void;
}) {
  const [outside, setOutside] = useState(live.outside_address ?? "");
  const [gateway, setGateway] = useState(live.gateway_address ?? "");
  const [nameServers, setNameServers] = useState(live.name_servers.join(", "));
  const [mtu, setMtu] = useState(numStr(live.mtu));
  const [authMode, setAuthMode] = useState<L2tpAuthMode | "">(live.auth_mode ?? "");
  const [protocols, setProtocols] = useState<L2tpAuthProtocol[]>(live.auth_protocols);
  const [defaultPool, setDefaultPool] = useState(live.default_pool ?? "");
  const [ipsecMode, setIpsecMode] = useState<IpsecAuthMode | "">(live.ipsec_auth_mode ?? "");
  const [psk, setPsk] = useState(live.ipsec_pre_shared_secret ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const toggleProto = (proto: L2tpAuthProtocol) =>
    setProtocols((p) => (p.includes(proto) ? p.filter((x) => x !== proto) : [...p, proto]));

  const desired: L2tpGeneral = useMemo(() => ({
    outside_address: outside.trim() || null,
    gateway_address: gateway.trim() || null,
    name_servers: toList(nameServers),
    mtu: numOrNull(mtu),
    auth_mode: authMode || null,
    auth_protocols: protocols,
    default_pool: defaultPool.trim() || null,
    ipsec_auth_mode: ipsecMode || null,
    ipsec_pre_shared_secret: psk.trim() || null,
  }), [outside, gateway, nameServers, mtu, authMode, protocols, defaultPool, ipsecMode, psk]);

  const save = async () => {
    setError("");
    setSaving(true);
    try {
      const applied = await applyL2tpGeneral(live, desired);
      onSaved(applied === 0 ? "No changes — L2TP config already matches." : `Applied ${applied} L2TP change${applied === 1 ? "" : "s"}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to apply L2TP settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 max-w-[720px]">
      <datalist id="l2tp-pools">{pools.map((n) => <option key={n} value={n} />)}</datalist>

      <Section title="Server" subtitle="Where the L2TP server listens and what it hands clients.">
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Outside address" hint="Public address the server binds to.">
            <input value={outside} onChange={(e) => setOutside(e.target.value)} placeholder="203.0.113.1" className="clr-input" style={monoSt} />
          </Field>
          <Field label="Gateway address" hint="Server's address inside the tunnel.">
            <input value={gateway} onChange={(e) => setGateway(e.target.value)} placeholder="10.10.0.1" className="clr-input" style={monoSt} />
          </Field>
          <Field label="Name servers" hint="DNS pushed to clients, comma-separated.">
            <input value={nameServers} onChange={(e) => setNameServers(e.target.value)} placeholder="10.10.0.1, 1.1.1.1" className="clr-input" style={monoSt} />
          </Field>
          <Field label="Default pool" hint="client-ip-pool clients draw from by default.">
            <input list="l2tp-pools" value={defaultPool} onChange={(e) => setDefaultPool(e.target.value)} placeholder="l2tp-pool" className="clr-input" style={monoSt} />
          </Field>
          <Field label="MTU">
            <input value={mtu} onChange={(e) => setMtu(e.target.value)} placeholder="1400" className="clr-input" style={monoSt} />
          </Field>
        </div>
      </Section>

      <Section title="Authentication" subtitle="How clients prove who they are.">
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Mode">
            <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
              <select value={authMode} onChange={(e) => setAuthMode(e.target.value as L2tpAuthMode | "")} className="clr-select" style={monoSt}>
                <option value="">Default (local)</option>
                <option value="local">local</option>
                <option value="radius">radius</option>
              </select>
            </div>
          </Field>
        </div>
        <Field label="Protocols" hint="Allowed PPP authentication protocols.">
          <div className="flex flex-wrap gap-3">
            {L2TP_AUTH_PROTOCOLS.map((proto) => (
              <div key={proto} className="clr-checkbox-wrapper">
                <input id={`l2tp-proto-${proto}`} type="checkbox" checked={protocols.includes(proto)} onChange={() => toggleProto(proto)} />
                <label htmlFor={`l2tp-proto-${proto}`} style={{ fontFamily: "var(--qz-font-mono)" }}>{proto}</label>
              </div>
            ))}
          </div>
        </Field>
      </Section>

      <Section title="IPsec" subtitle="L2TP is carried inside an IPsec transport tunnel.">
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Authentication mode">
            <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
              <select value={ipsecMode} onChange={(e) => setIpsecMode(e.target.value as IpsecAuthMode | "")} className="clr-select" style={monoSt}>
                <option value="">None</option>
                <option value="pre-shared-secret">pre-shared-secret</option>
                <option value="x509">x509</option>
              </select>
            </div>
          </Field>
          {ipsecMode === "pre-shared-secret" && (
            <Field label="Pre-shared secret" hint="Leave blank to keep the current secret.">
              <input value={psk} onChange={(e) => setPsk(e.target.value)} type="password" placeholder="shared secret" className="clr-input" style={inputSt} />
            </Field>
          )}
        </div>
      </Section>

      {error && <p className="text-[12px] m-0" style={{ color: "var(--cds-alias-status-danger)" }}>{error}</p>}

      <div className="flex justify-end">
        <Button kind="primary" icon="check" onClick={save} disabled={saving}>
          {saving ? "Applying…" : "Save L2TP Settings"}
        </Button>
      </div>
    </div>
  );
}
