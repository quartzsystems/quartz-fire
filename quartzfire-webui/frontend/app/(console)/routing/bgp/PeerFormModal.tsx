"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import {
  ADDRESS_FAMILIES,
  AddressFamily,
  applyBgpNeighbor,
  applyBgpPeerGroup,
  BgpPeer,
  emptyAf,
  emptyPeer,
  NeighborAf,
} from "@/lib/bgp";

const inputCls = "w-full rounded-md px-3 py-[9px] text-[13px] text-[var(--qz-fg-1)] outline-none";
const inputSt = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;
const monoSt = { ...inputSt, fontFamily: "var(--qz-font-mono)" } as const;

function focusBorder(e: React.FocusEvent<HTMLInputElement>) {
  e.currentTarget.style.borderColor = "var(--qz-accent)";
}
function blurBorder(e: React.FocusEvent<HTMLInputElement>) {
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

const AF_LABEL: Record<AddressFamily, string> = {
  "ipv4-unicast": "IPv4 Unicast",
  "ipv6-unicast": "IPv6 Unicast",
  "l2vpn-evpn": "L2VPN EVPN",
};

const V46_ADDR_RE = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i;

/// Per-address-family block: an activation toggle that reveals the per-AF knobs.
function AfBlock({
  af,
  value,
  onChange,
  routeMaps,
}: {
  af: AddressFamily;
  value: NeighborAf;
  onChange: (v: NeighborAf) => void;
  routeMaps: string[];
}) {
  const [open, setOpen] = useState(value.enabled);
  const set = (partial: Partial<NeighborAf>) => onChange({ ...value, ...partial });
  const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s));

  return (
    <div className="rounded-md" style={inputSt}>
      <div className="flex items-center justify-between px-3 py-[10px]">
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 bg-transparent border-0 p-0 cursor-pointer text-[13px] font-medium text-[var(--qz-fg-1)]">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {AF_LABEL[af]}
        </button>
        <label className="flex items-center gap-[8px] cursor-pointer select-none">
          <span className="text-[12px] text-[var(--qz-fg-4)]">Activate</span>
          <Switch on={value.enabled} onChange={(on) => { set({ enabled: on }); if (on) setOpen(true); }} />
        </label>
      </div>

      {open && value.enabled && (
        <div className="px-3 pb-3 flex flex-col gap-3 border-t" style={{ borderColor: "var(--qz-border)" }}>
          <div className="grid gap-3 pt-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <label className="flex items-center gap-2 cursor-pointer select-none text-[13px] text-[var(--qz-fg-2)]">
              <Switch on={value.route_reflector_client} onChange={(v) => set({ route_reflector_client: v })} />
              Route-reflector client
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none text-[13px] text-[var(--qz-fg-2)]">
              <Switch on={value.nexthop_self} onChange={(v) => set({ nexthop_self: v })} />
              Next-hop self
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none text-[13px] text-[var(--qz-fg-2)]">
              <Switch on={value.soft_reconfiguration_inbound} onChange={(v) => set({ soft_reconfiguration_inbound: v })} />
              Soft-reconfiguration inbound
            </label>
          </div>
          <div className="grid gap-3" style={{ gridTemplateColumns: af === "l2vpn-evpn" ? "1fr" : "1fr 1fr" }}>
            <Field label="allowas-in" hint="Accept our own AS up to n times (blank = off).">
              <input value={value.allowas_in ?? ""} onChange={(e) => set({ allowas_in: numOrNull(e.target.value) })} placeholder="1" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
            </Field>
            {af !== "l2vpn-evpn" && (
              <Field label="maximum-prefix">
                <input value={value.maximum_prefix ?? ""} onChange={(e) => set({ maximum_prefix: numOrNull(e.target.value) })} placeholder="unlimited" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
              </Field>
            )}
          </div>
          <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <Field label="Route-map in">
              <input list="bgp-route-maps" value={value.route_map_import ?? ""} onChange={(e) => set({ route_map_import: e.target.value || null })} placeholder="RM-IN" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
            </Field>
            <Field label="Route-map out">
              <input list="bgp-route-maps" value={value.route_map_export ?? ""} onChange={(e) => set({ route_map_export: e.target.value || null })} placeholder="RM-OUT" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
            </Field>
          </div>
          {routeMaps.length === 0 && <p className="text-[11px] text-[var(--qz-fg-4)] m-0">Tip: define route-maps under Routing → Policy to reference them here.</p>}
        </div>
      )}
    </div>
  );
}

/// Create/edit a BGP neighbor or peer-group. Diffs against the live config and
/// commits under commit-confirm.
export function PeerFormModal({
  kind,
  initial,
  existingNames,
  peerGroups,
  interfaces,
  routeMaps,
  onClose,
  onSaved,
}: {
  kind: "neighbor" | "peer-group";
  initial?: BgpPeer;
  /** Existing peers of this kind, for duplicate detection. */
  existingNames: string[];
  /** Configured peer-group names (neighbor peer-group picker). */
  peerGroups: string[];
  /** Interface names (unnumbered neighbor / update-source pickers). */
  interfaces: string[];
  /** Route-map names for the per-AF pickers. */
  routeMaps: string[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const isNeighbor = kind === "neighbor";
  const [peer, setPeer] = useState<BgpPeer>(initial ?? emptyPeer());
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const set = (partial: Partial<BgpPeer>) => setPeer((p) => ({ ...p, ...partial }));
  const setAf = (af: AddressFamily, v: NeighborAf) => setPeer((p) => ({ ...p, afi: { ...p.afi, [af]: v } }));

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const name = peer.name.trim();
    if (!name) {
      setError(isNeighbor ? "Enter the neighbor address or interface." : "Enter a peer-group name.");
      return;
    }
    if (isNeighbor && !peer.is_interface && !V46_ADDR_RE.test(name)) {
      setError("Neighbor must be an IPv4 or IPv6 address (or switch to an unnumbered interface).");
      return;
    }
    if (!isEdit && existingNames.includes(name)) {
      setError(`${name} already exists.`);
      return;
    }
    const ras = peer.remote_as?.trim() ?? "";
    if (ras && !["external", "internal"].includes(ras)) {
      const n = Number(ras);
      if (!Number.isInteger(n) || n < 1 || n > 4294967295) {
        setError("Remote AS must be a number (1–4294967295) or 'external' / 'internal'.");
        return;
      }
    }
    if (isNeighbor && !ras && !peer.peer_group?.trim()) {
      setError("A neighbor needs a remote-as, or membership in a peer-group that sets one.");
      return;
    }
    if (peer.ebgp_multihop != null && (!Number.isInteger(peer.ebgp_multihop) || peer.ebgp_multihop < 1 || peer.ebgp_multihop > 255)) {
      setError("eBGP multihop must be a whole number between 1 and 255.");
      return;
    }

    const desired: BgpPeer = {
      ...peer,
      name,
      is_interface: isNeighbor ? peer.is_interface : false,
      remote_as: ras || null,
      peer_group: isNeighbor ? peer.peer_group?.trim() || null : null,
      update_source: peer.update_source?.trim() || null,
      description: peer.description?.trim() || null,
    };

    setSaving(true);
    try {
      const applied = isNeighbor
        ? await applyBgpNeighbor(initial ?? null, desired)
        : await applyBgpPeerGroup(initial ?? null, desired);
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to ${name}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply changes.");
    } finally {
      setSaving(false);
    }
  };

  const noun = isNeighbor ? "Neighbor" : "Peer-Group";

  return (
    <ModalShell onClose={onClose} maxWidth={600}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Add"} ${noun}`}
        subtitle={isEdit ? peer.name : isNeighbor ? "BGP neighbor / peering session" : "Reusable neighbor template"}
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <datalist id="bgp-route-maps">{routeMaps.map((n) => <option key={n} value={n} />)}</datalist>
        <datalist id="bgp-peer-groups">{peerGroups.map((n) => <option key={n} value={n} />)}</datalist>
        <datalist id="bgp-interfaces">{interfaces.map((n) => <option key={n} value={n} />)}</datalist>

        {isNeighbor && !isEdit && (
          <Field label="Peer Type" hint="Unnumbered peers over an interface use IPv6 link-local + extended-nexthop.">
            <Segmented
              items={[
                { value: "ip", label: "IP address" },
                { value: "iface", label: "Unnumbered (interface)" },
              ]}
              value={peer.is_interface ? "iface" : "ip"}
              onChange={(v) => set({ is_interface: v === "iface", extended_nexthop: v === "iface" ? true : peer.extended_nexthop })}
            />
          </Field>
        )}

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label={isNeighbor ? (peer.is_interface ? "Interface" : "Neighbor Address") : "Peer-Group Name"}>
            <input
              list={isNeighbor && peer.is_interface ? "bgp-interfaces" : undefined}
              value={peer.name}
              disabled={isEdit}
              onChange={(e) => set({ name: e.target.value })}
              placeholder={isNeighbor ? (peer.is_interface ? "eth1" : "192.0.2.2") : "fabric"}
              className={`${inputCls} disabled:opacity-70`}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
          <Field label="Remote AS" hint="ASN, or 'external' / 'internal'.">
            <input
              value={peer.remote_as ?? ""}
              onChange={(e) => set({ remote_as: e.target.value || null })}
              placeholder="external"
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          {isNeighbor && (
            <Field label="Peer Group" hint="Inherit settings from a peer-group.">
              <input list="bgp-peer-groups" value={peer.peer_group ?? ""} onChange={(e) => set({ peer_group: e.target.value || null })} placeholder="fabric" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
            </Field>
          )}
          <Field label="Update Source" hint="Source address/interface for the session.">
            <input list="bgp-interfaces" value={peer.update_source ?? ""} onChange={(e) => set({ update_source: e.target.value || null })} placeholder="lo" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
          </Field>
          <Field label="eBGP Multihop" hint="Max hops to an eBGP peer (blank = directly connected).">
            <input value={peer.ebgp_multihop ?? ""} onChange={(e) => set({ ebgp_multihop: e.target.value.trim() === "" ? null : Number(e.target.value) })} placeholder="2" className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
          </Field>
        </div>

        <Field label="Description">
          <input value={peer.description ?? ""} onChange={(e) => set({ description: e.target.value || null })} placeholder="Spine 1" className={inputCls} style={inputSt} onFocus={focusBorder} onBlur={blurBorder} />
        </Field>

        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <label className="flex items-center gap-2 cursor-pointer select-none text-[13px] text-[var(--qz-fg-2)]">
            <Switch on={peer.extended_nexthop} onChange={(v) => set({ extended_nexthop: v })} />
            Capability extended-nexthop
          </label>
          <label className="flex items-center gap-2 cursor-pointer select-none text-[13px] text-[var(--qz-fg-2)]">
            <Switch on={peer.bfd} onChange={(v) => set({ bfd: v })} />
            BFD
          </label>
          <label className="flex items-center gap-2 cursor-pointer select-none text-[13px] text-[var(--qz-fg-2)]">
            <Switch on={peer.enabled} onChange={(v) => set({ enabled: v })} />
            Enabled
          </label>
        </div>

        <div>
          <label className="block text-[12px] text-[var(--qz-fg-3)] mb-[8px]">Address Families</label>
          <div className="flex flex-col gap-2">
            {ADDRESS_FAMILIES.map((af) => (
              <AfBlock key={af} af={af} value={peer.afi[af] ?? emptyAf()} onChange={(v) => setAf(af, v)} routeMaps={routeMaps} />
            ))}
          </div>
        </div>

        {error && <p className="text-[12px] m-0" style={{ color: "var(--qz-danger)" }}>{error}</p>}

        <div className="flex gap-2 justify-end mt-1">
          <button type="button" onClick={onClose} className="px-4 py-[9px] rounded-md text-[13px] font-medium cursor-pointer" style={{ background: "transparent", border: "1px solid var(--qz-border)", color: "var(--qz-fg-2)" }}>
            Cancel
          </button>
          <button type="submit" disabled={saving} className="px-4 py-[9px] rounded-md text-[13px] font-semibold cursor-pointer border-0" style={{ background: "var(--qz-accent)", color: "var(--qz-fg-on-accent)", opacity: saving ? 0.7 : 1 }}>
            {saving ? "Applying…" : isEdit ? "Apply changes" : `Add ${noun.toLowerCase()}`}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
