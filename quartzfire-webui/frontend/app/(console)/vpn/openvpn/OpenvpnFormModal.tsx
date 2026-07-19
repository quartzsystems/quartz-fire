"use client";

import { useState } from "react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import {
  OPENVPN_DEVICE_TYPES,
  OPENVPN_PROTOCOLS,
  OPENVPN_TOPOLOGIES,
  OpenvpnDeviceType,
  OpenvpnInterface,
  OpenvpnMode,
  OpenvpnProtocol,
  OpenvpnTopology,
  applyOpenvpn,
  emptyOpenvpn,
} from "@/lib/openvpn";

const inputCls = "w-full rounded-md px-3 py-[9px] text-[13px] text-[var(--qz-fg-1)] outline-none";
const inputSt = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;
const monoSt = { ...inputSt, fontFamily: "var(--qz-font-mono)" } as const;

function focusBorder(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) {
  e.currentTarget.style.borderColor = "var(--qz-accent)";
}
function blurBorder(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) {
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-[12px] font-semibold text-[var(--qz-fg-2)] uppercase tracking-wide mt-1">{children}</span>;
}

const numOrNull = (s: string) => {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isInteger(n) ? n : null;
};
const numStr = (n: number | null) => (n == null ? "" : String(n));
const toList = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

const selectOrNull = <T extends string>(s: string) => (s === "" ? null : (s as T));

/// Create/edit one OpenVPN interface. The form surfaces only the leaves that
/// matter for the selected mode; diffing handles cleaning up the rest.
export function OpenvpnFormModal({ initial, existingNames, onClose, onSaved }: {
  initial?: OpenvpnInterface;
  existingNames: string[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const base = initial ?? emptyOpenvpn();
  const [name, setName] = useState(base.name);
  const [mode, setMode] = useState<OpenvpnMode>(base.mode);
  const [description, setDescription] = useState(base.description ?? "");
  const [deviceType, setDeviceType] = useState<OpenvpnDeviceType | "">(base.device_type ?? "");
  const [protocol, setProtocol] = useState<OpenvpnProtocol | "">(base.protocol ?? "");
  const [localHost, setLocalHost] = useState(base.local_host ?? "");
  const [localPort, setLocalPort] = useState(numStr(base.local_port));
  const [persistent, setPersistent] = useState(base.persistent_tunnel);
  const [enabled, setEnabled] = useState(base.enabled);

  const [cipher, setCipher] = useState(base.encryption_cipher ?? "");
  const [hash, setHash] = useState(base.hash ?? "");

  const [caCert, setCaCert] = useState(base.tls_ca_certificate ?? "");
  const [cert, setCert] = useState(base.tls_certificate ?? "");
  const [dhParams, setDhParams] = useState(base.tls_dh_params ?? "");
  const [tlsRole, setTlsRole] = useState<"active" | "passive" | "">(base.tls_role ?? "");

  const [localAddress, setLocalAddress] = useState(base.local_address ?? "");
  const [remoteAddress, setRemoteAddress] = useState(base.remote_address ?? "");
  const [sharedSecretKey, setSharedSecretKey] = useState(base.shared_secret_key ?? "");

  const [remoteHost, setRemoteHost] = useState(base.remote_host ?? "");
  const [remotePort, setRemotePort] = useState(numStr(base.remote_port));
  const [authUser, setAuthUser] = useState(base.auth_username ?? "");
  const [authPass, setAuthPass] = useState(base.auth_password ?? "");

  const [serverSubnet, setServerSubnet] = useState(base.server_subnet ?? "");
  const [serverTopology, setServerTopology] = useState<OpenvpnTopology | "">(base.server_topology ?? "");
  const [pushRoutes, setPushRoutes] = useState(base.server_push_routes.join(", "));
  const [nameServers, setNameServers] = useState(base.server_name_servers.join(", "));
  const [maxConnections, setMaxConnections] = useState(numStr(base.server_max_connections));

  const [options, setOptions] = useState(base.openvpn_options.join("\n"));

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    const ifName = name.trim();
    if (!ifName) return setError("Enter an interface name (e.g. vtun0).");
    if (!/^vtun\d+$/.test(ifName)) return setError("Interface name must be vtun followed by a number (e.g. vtun0).");
    if (!isEdit && existingNames.includes(ifName)) return setError(`Interface ${ifName} already exists.`);

    const desired: OpenvpnInterface = {
      ...emptyOpenvpn(),
      name: ifName,
      mode,
      description: description.trim() || null,
      device_type: selectOrNull<OpenvpnDeviceType>(deviceType),
      protocol: selectOrNull<OpenvpnProtocol>(protocol),
      local_host: localHost.trim() || null,
      local_port: numOrNull(localPort),
      persistent_tunnel: persistent,
      enabled,
      encryption_cipher: cipher.trim() || null,
      hash: hash.trim() || null,
      tls_ca_certificate: caCert.trim() || null,
      tls_certificate: cert.trim() || null,
      tls_dh_params: mode === "site-to-site" ? null : dhParams.trim() || null,
      tls_role: mode === "site-to-site" ? (tlsRole || null) : null,
      local_address: mode === "site-to-site" ? localAddress.trim() || null : null,
      remote_address: mode === "site-to-site" ? remoteAddress.trim() || null : null,
      shared_secret_key: mode === "site-to-site" ? sharedSecretKey.trim() || null : null,
      remote_host: mode === "server" ? null : remoteHost.trim() || null,
      remote_port: mode === "client" ? numOrNull(remotePort) : null,
      auth_username: mode === "client" ? authUser.trim() || null : null,
      auth_password: mode === "client" ? authPass.trim() || null : null,
      server_subnet: mode === "server" ? serverSubnet.trim() || null : null,
      server_topology: mode === "server" ? (serverTopology || null) : null,
      server_push_routes: mode === "server" ? toList(pushRoutes) : [],
      server_name_servers: mode === "server" ? toList(nameServers) : [],
      server_max_connections: mode === "server" ? numOrNull(maxConnections) : null,
      openvpn_options: options.split("\n").map((x) => x.trim()).filter(Boolean),
    };

    setSaving(true);
    try {
      const applied = await applyOpenvpn(initial ?? null, desired);
      onSaved(applied === 0 ? "No changes — config already matches." : `Applied ${applied} change${applied === 1 ? "" : "s"} to ${ifName}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={640}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Add"} OpenVPN Interface`}
        subtitle={isEdit ? initial!.name : "TLS or static-key tunnel"}
        onClose={onClose}
      />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Interface" required hint="vtun0, vtun1, …">
            <input value={name} disabled={isEdit} onChange={(e) => setName(e.target.value)} placeholder="vtun0" className={`${inputCls} disabled:opacity-70`} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
          </Field>
          <Field label="Mode">
            <Segmented
              items={[
                { value: "site-to-site", label: "Site-to-site" },
                { value: "client", label: "Client" },
                { value: "server", label: "Server" },
              ]}
              value={mode}
              onChange={(v) => setMode(v as OpenvpnMode)}
            />
          </Field>
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
          <Field label="Device type" hint="Default tun (L3).">
            <select value={deviceType} onChange={(e) => setDeviceType(e.target.value as OpenvpnDeviceType | "")} className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder}>
              <option value="">Default</option>
              {OPENVPN_DEVICE_TYPES.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>
          <Field label="Protocol">
            <select value={protocol} onChange={(e) => setProtocol(e.target.value as OpenvpnProtocol | "")} className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder}>
              <option value="">Default (udp)</option>
              {OPENVPN_PROTOCOLS.map((pr) => <option key={pr} value={pr}>{pr}</option>)}
            </select>
          </Field>
          <Field label="Local port" hint="Listen port.">
            <input value={localPort} onChange={(e) => setLocalPort(e.target.value)} placeholder="1194" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
          </Field>
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Local host" hint="Address to bind to (optional).">
            <input value={localHost} onChange={(e) => setLocalHost(e.target.value)} placeholder="203.0.113.1" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
          </Field>
          <Field label="Description">
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Branch office link" className={inputCls} style={inputSt} onFocus={focusBorder} onBlur={blurBorder} />
          </Field>
        </div>

        {/* Mode-specific */}
        {mode === "site-to-site" && (
          <>
            <SectionLabel>Site-to-site</SectionLabel>
            <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <Field label="Local tunnel address" hint="This side of the /30 (tun).">
                <input value={localAddress} onChange={(e) => setLocalAddress(e.target.value)} placeholder="10.255.0.1" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
              </Field>
              <Field label="Remote tunnel address">
                <input value={remoteAddress} onChange={(e) => setRemoteAddress(e.target.value)} placeholder="10.255.0.2" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
              </Field>
              <Field label="Remote host" hint="Peer's public address (TLS initiator).">
                <input value={remoteHost} onChange={(e) => setRemoteHost(e.target.value)} placeholder="peer.example.com" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
              </Field>
              <Field label="TLS role">
                <select value={tlsRole} onChange={(e) => setTlsRole(e.target.value as "active" | "passive" | "")} className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder}>
                  <option value="">None (static key)</option>
                  <option value="active">active</option>
                  <option value="passive">passive</option>
                </select>
              </Field>
            </div>
            <Field label="Shared secret key" hint="PKI static-key name (`generate pki openvpn shared-secret`). Leave blank when using TLS.">
              <input value={sharedSecretKey} onChange={(e) => setSharedSecretKey(e.target.value)} placeholder="ovpn-key-0" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
            </Field>
          </>
        )}

        {mode === "client" && (
          <>
            <SectionLabel>Client</SectionLabel>
            <div className="grid gap-4" style={{ gridTemplateColumns: "2fr 1fr" }}>
              <Field label="Remote host" required hint="Server to connect to.">
                <input value={remoteHost} onChange={(e) => setRemoteHost(e.target.value)} placeholder="vpn.example.com" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
              </Field>
              <Field label="Remote port">
                <input value={remotePort} onChange={(e) => setRemotePort(e.target.value)} placeholder="1194" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
              </Field>
            </div>
            <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <Field label="Username" hint="For user/password auth (optional).">
                <input value={authUser} onChange={(e) => setAuthUser(e.target.value)} placeholder="user" className={inputCls} style={inputSt} onFocus={focusBorder} onBlur={blurBorder} />
              </Field>
              <Field label="Password" hint="Leave blank to keep the current one.">
                <input value={authPass} onChange={(e) => setAuthPass(e.target.value)} type="password" placeholder="••••••" className={inputCls} style={inputSt} onFocus={focusBorder} onBlur={blurBorder} />
              </Field>
            </div>
          </>
        )}

        {mode === "server" && (
          <>
            <SectionLabel>Server</SectionLabel>
            <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <Field label="Server subnet" required hint="Pool clients draw from (e.g. 10.8.0.0/24).">
                <input value={serverSubnet} onChange={(e) => setServerSubnet(e.target.value)} placeholder="10.8.0.0/24" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
              </Field>
              <Field label="Topology">
                <select value={serverTopology} onChange={(e) => setServerTopology(e.target.value as OpenvpnTopology | "")} className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder}>
                  <option value="">Default (subnet)</option>
                  {OPENVPN_TOPOLOGIES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>
            </div>
            <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <Field label="Push routes" hint="Routes to push to clients, comma-separated.">
                <input value={pushRoutes} onChange={(e) => setPushRoutes(e.target.value)} placeholder="192.168.1.0/24" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
              </Field>
              <Field label="Name servers" hint="DNS pushed to clients, comma-separated.">
                <input value={nameServers} onChange={(e) => setNameServers(e.target.value)} placeholder="10.8.0.1" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
              </Field>
            </div>
            <Field label="Max connections" hint="1–4096.">
              <input value={maxConnections} onChange={(e) => setMaxConnections(e.target.value)} placeholder="unlimited" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
            </Field>
          </>
        )}

        {/* Encryption + TLS/PKI */}
        <SectionLabel>Encryption &amp; certificates</SectionLabel>
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Cipher" hint="Data-channel cipher (e.g. aes-256-gcm).">
            <input value={cipher} onChange={(e) => setCipher(e.target.value)} placeholder="aes-256-gcm" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
          </Field>
          <Field label="Hash" hint="HMAC digest (e.g. sha256).">
            <input value={hash} onChange={(e) => setHash(e.target.value)} placeholder="sha256" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
          </Field>
          <Field label="CA certificate" hint="PKI CA name.">
            <input value={caCert} onChange={(e) => setCaCert(e.target.value)} placeholder="ca-name" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
          </Field>
          <Field label="Certificate" hint="PKI certificate name.">
            <input value={cert} onChange={(e) => setCert(e.target.value)} placeholder="cert-name" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
          </Field>
        </div>
        {mode !== "site-to-site" && (
          <Field label="DH parameters" hint="PKI dh-params name (server / TLS).">
            <input value={dhParams} onChange={(e) => setDhParams(e.target.value)} placeholder="dh-name" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
          </Field>
        )}

        <Field label="Extra OpenVPN options" hint="Raw directives, one per line — passed through verbatim.">
          <textarea value={options} onChange={(e) => setOptions(e.target.value)} rows={2} placeholder="reneg-sec 0" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
        </Field>

        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <label className="flex items-center gap-2 cursor-pointer select-none text-[13px] text-[var(--qz-fg-2)]">
            <Switch on={persistent} onChange={setPersistent} />
            Persistent tunnel
          </label>
          <label className="flex items-center gap-2 cursor-pointer select-none text-[13px] text-[var(--qz-fg-2)]">
            <Switch on={enabled} onChange={setEnabled} />
            Interface enabled
          </label>
        </div>

        {error && <p className="text-[12px] m-0" style={{ color: "var(--qz-danger)" }}>{error}</p>}

        <div className="flex gap-2 justify-end mt-1">
          <button type="button" onClick={onClose} className="px-4 py-[9px] rounded-md text-[13px] font-medium cursor-pointer" style={{ background: "transparent", border: "1px solid var(--qz-border)", color: "var(--qz-fg-2)" }}>
            Cancel
          </button>
          <button type="submit" disabled={saving} className="px-4 py-[9px] rounded-md text-[13px] font-semibold cursor-pointer border-0" style={{ background: "var(--qz-accent)", color: "var(--qz-fg-on-accent)", opacity: saving ? 0.7 : 1 }}>
            {saving ? "Applying…" : isEdit ? "Apply changes" : "Add interface"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
