"use client";

import { useMemo, useState } from "react";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  IpsecAuthMode,
  L2TP_AUTH_PROTOCOLS,
  L2tpAuthMode,
  L2tpAuthProtocol,
  L2tpGeneral,
  applyL2tpGeneral,
} from "@/lib/l2tp";

const inputCls = "w-full rounded-md px-3 py-[9px] text-[13px] text-[var(--qz-fg-1)] outline-none";
const inputSt = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;
const monoSt = { ...inputSt, fontFamily: "var(--qz-font-mono)" } as const;

function focusBorder(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) {
  e.currentTarget.style.borderColor = "var(--qz-accent)";
}
function blurBorder(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) {
  e.currentTarget.style.borderColor = "var(--qz-border)";
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[12px] text-[var(--qz-fg-3)] mb-[6px]">{label}</label>
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
            <input value={outside} onChange={(e) => setOutside(e.target.value)} placeholder="203.0.113.1" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
          </Field>
          <Field label="Gateway address" hint="Server's address inside the tunnel.">
            <input value={gateway} onChange={(e) => setGateway(e.target.value)} placeholder="10.10.0.1" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
          </Field>
          <Field label="Name servers" hint="DNS pushed to clients, comma-separated.">
            <input value={nameServers} onChange={(e) => setNameServers(e.target.value)} placeholder="10.10.0.1, 1.1.1.1" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
          </Field>
          <Field label="Default pool" hint="client-ip-pool clients draw from by default.">
            <input list="l2tp-pools" value={defaultPool} onChange={(e) => setDefaultPool(e.target.value)} placeholder="l2tp-pool" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
          </Field>
          <Field label="MTU">
            <input value={mtu} onChange={(e) => setMtu(e.target.value)} placeholder="1400" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
          </Field>
        </div>
      </Section>

      <Section title="Authentication" subtitle="How clients prove who they are.">
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Mode">
            <select value={authMode} onChange={(e) => setAuthMode(e.target.value as L2tpAuthMode | "")} className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder}>
              <option value="">Default (local)</option>
              <option value="local">local</option>
              <option value="radius">radius</option>
            </select>
          </Field>
        </div>
        <Field label="Protocols" hint="Allowed PPP authentication protocols.">
          <div className="flex flex-wrap gap-3">
            {L2TP_AUTH_PROTOCOLS.map((proto) => (
              <label key={proto} className="flex items-center gap-2 cursor-pointer select-none text-[13px] text-[var(--qz-fg-2)]">
                <input type="checkbox" checked={protocols.includes(proto)} onChange={() => toggleProto(proto)} style={{ accentColor: "var(--qz-accent)" }} />
                <span style={{ fontFamily: "var(--qz-font-mono)" }}>{proto}</span>
              </label>
            ))}
          </div>
        </Field>
      </Section>

      <Section title="IPsec" subtitle="L2TP is carried inside an IPsec transport tunnel.">
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Authentication mode">
            <select value={ipsecMode} onChange={(e) => setIpsecMode(e.target.value as IpsecAuthMode | "")} className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder}>
              <option value="">None</option>
              <option value="pre-shared-secret">pre-shared-secret</option>
              <option value="x509">x509</option>
            </select>
          </Field>
          {ipsecMode === "pre-shared-secret" && (
            <Field label="Pre-shared secret" hint="Leave blank to keep the current secret.">
              <input value={psk} onChange={(e) => setPsk(e.target.value)} type="password" placeholder="shared secret" className={inputCls} style={inputSt} onFocus={focusBorder} onBlur={blurBorder} />
            </Field>
          )}
        </div>
      </Section>

      {error && <p className="text-[12px] m-0" style={{ color: "var(--qz-danger)" }}>{error}</p>}

      <div className="flex justify-end">
        <Button kind="primary" icon={Save} onClick={save} disabled={saving}>
          {saving ? "Applying…" : "Save L2TP settings"}
        </Button>
      </div>
    </div>
  );
}
