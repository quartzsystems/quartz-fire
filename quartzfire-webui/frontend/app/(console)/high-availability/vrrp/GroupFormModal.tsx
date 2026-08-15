"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import {
  Advanced,
  ErrorText,
  Field,
  ModalFooter,
  StringListEditor,
  TextInput,
  monoStyle,
  numOrNull,
} from "../formkit";
import {
  AuthType,
  VrrpGroup,
  VrrpVip,
  applyGroup,
  emptyGroup,
} from "@/lib/vrrp";

const sectionHead: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--cds-alias-typography-color-450)",
  marginTop: 4,
};

const switchLabel = "flex items-center gap-2 cursor-pointer select-none";
const switchLabelStyle: React.CSSProperties = { fontSize: 13, color: "var(--cds-alias-typography-color-400)" };

/// Editor for the virtual-address rows (each an IP/CIDR with an optional
/// interface override).
function VipEditor({
  vips,
  onChange,
}: {
  vips: VrrpVip[];
  onChange: (v: VrrpVip[]) => void;
}) {
  const setAt = (i: number, patch: Partial<VrrpVip>) =>
    onChange(vips.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  return (
    <div className="flex flex-col gap-2">
      {vips.map((v, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            value={v.address}
            onChange={(e) => setAt(i, { address: e.target.value })}
            placeholder="10.0.0.1/24"
            className="clr-input"
            style={{ maxWidth: "none", ...monoStyle }}
          />
          <input
            value={v.interface ?? ""}
            list="vrrp-interfaces"
            onChange={(e) => setAt(i, { interface: e.target.value || null })}
            placeholder="interface (opt.)"
            className="clr-input"
            style={{ maxWidth: "none", ...monoStyle }}
          />
          <button
            type="button"
            onClick={() => onChange(vips.filter((_, j) => j !== i))}
            aria-label="Remove"
            className="btn btn-sm btn-link-neutral btn-icon flex-shrink-0"
          >
            <Icon shape="times" size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...vips, { address: "", interface: null }])}
        className="btn btn-sm btn-neutral self-start"
      >
        <Icon shape="plus" size={13} /> Add Virtual Address
      </button>
    </div>
  );
}

export function GroupFormModal({
  initial,
  existingNames,
  interfaces,
  onClose,
  onSaved,
}: {
  initial?: VrrpGroup;
  existingNames: string[];
  interfaces: string[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const [g, setG] = useState<VrrpGroup>(initial ?? emptyGroup());
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const set = (patch: Partial<VrrpGroup>) => setG((p) => ({ ...p, ...patch }));
  const setHc = (patch: Partial<VrrpGroup["health_check"]>) =>
    setG((p) => ({ ...p, health_check: { ...p.health_check, ...patch } }));
  const setTs = (patch: Partial<VrrpGroup["transition_script"]>) =>
    setG((p) => ({ ...p, transition_script: { ...p.transition_script, ...patch } }));
  const setGarp = (patch: Partial<VrrpGroup["garp"]>) =>
    setG((p) => ({ ...p, garp: { ...p.garp, ...patch } }));

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    const name = g.name.trim();
    if (!name) return setError("Enter a group name.");
    if (!isEdit && existingNames.includes(name)) return setError(`${name} already exists.`);
    if (!g.interface?.trim()) return setError("A VRRP group needs an interface.");
    if (g.vrid == null || g.vrid < 1 || g.vrid > 255) return setError("VRID must be between 1 and 255.");
    if (g.priority != null && (g.priority < 1 || g.priority > 255)) return setError("Priority must be between 1 and 255.");
    if (g.addresses.every((a) => a.address.trim() === "")) return setError("Add at least one virtual address.");

    const desired: VrrpGroup = {
      ...g,
      name,
      interface: g.interface.trim(),
      description: g.description?.trim() || null,
      hello_source_address: g.hello_source_address?.trim() || null,
      peer_address: g.peer_address?.trim() || null,
      addresses: g.addresses
        .filter((a) => a.address.trim() !== "")
        .map((a) => ({ address: a.address.trim(), interface: a.interface?.trim() || null })),
      excluded_addresses: g.excluded_addresses.map((a) => a.trim()).filter(Boolean),
      track_interfaces: g.track_interfaces.map((a) => a.trim()).filter(Boolean),
    };

    setSaving(true);
    try {
      const applied = await applyGroup(initial ?? null, desired);
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

  const authItems = [
    { value: "none", label: "None" },
    { value: "plaintext-password", label: "Plaintext" },
    { value: "ah", label: "AH" },
  ];

  return (
    <ModalShell onClose={onClose} maxWidth={640}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Add"} VRRP Group`}
        subtitle={isEdit ? g.name : "A virtual router (floating gateway) on an interface"}
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <datalist id="vrrp-interfaces">{interfaces.map((n) => <option key={n} value={n} />)}</datalist>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Name">
            <TextInput value={g.name} onChange={(v) => set({ name: v })} placeholder="LAN" mono disabled={isEdit} />
          </Field>
          <Field label="Interface" hint="The interface VRRP runs on.">
            <TextInput value={g.interface ?? ""} onChange={(v) => set({ interface: v || null })} placeholder="eth1" mono list="vrrp-interfaces" />
          </Field>
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
          <Field label="VRID" hint="1–255">
            <TextInput value={g.vrid?.toString() ?? ""} onChange={(v) => set({ vrid: numOrNull(v) })} placeholder="10" mono />
          </Field>
          <Field label="Priority" hint="1–255 (default 100)">
            <TextInput value={g.priority?.toString() ?? ""} onChange={(v) => set({ priority: numOrNull(v) })} placeholder="100" mono />
          </Field>
          <Field label="Advertise interval" hint="seconds">
            <TextInput value={g.advertise_interval?.toString() ?? ""} onChange={(v) => set({ advertise_interval: numOrNull(v) })} placeholder="1" mono />
          </Field>
        </div>

        <Field label="Description">
          <TextInput value={g.description ?? ""} onChange={(v) => set({ description: v || null })} placeholder="LAN gateway" />
        </Field>

        <Field label="Virtual addresses" hint="Floating IP(s) the master owns.">
          <VipEditor vips={g.addresses} onChange={(v) => set({ addresses: v })} />
        </Field>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Protocol version">
            <Segmented
              items={[
                { value: "inherit", label: "Inherit" },
                { value: "2", label: "v2" },
                { value: "3", label: "v3" },
              ]}
              value={g.version == null ? "inherit" : String(g.version)}
              onChange={(v) => set({ version: v === "inherit" ? null : Number(v) })}
            />
          </Field>
          <Field label="Preempt delay" hint="seconds before retaking master">
            <TextInput value={g.preempt_delay?.toString() ?? ""} onChange={(v) => set({ preempt_delay: numOrNull(v) })} placeholder="0" mono />
          </Field>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <label className={switchLabel} style={switchLabelStyle}>
            <Switch on={g.enabled} onChange={(v) => set({ enabled: v })} />
            Enabled
          </label>
          <label className={switchLabel} style={switchLabelStyle}>
            <Switch on={g.no_preempt} onChange={(v) => set({ no_preempt: v })} />
            No preempt
          </label>
          <label className={switchLabel} style={switchLabelStyle}>
            <Switch on={g.rfc3768_compatibility} onChange={(v) => set({ rfc3768_compatibility: v })} />
            RFC 3768 compatibility
          </label>
        </div>

        <Advanced label="Authentication, tracking & scripts">
          <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <Field label="Hello source address">
              <TextInput value={g.hello_source_address ?? ""} onChange={(v) => set({ hello_source_address: v || null })} placeholder="10.0.0.2" mono />
            </Field>
            <Field label="Peer address" hint="Unicast VRRP peer">
              <TextInput value={g.peer_address ?? ""} onChange={(v) => set({ peer_address: v || null })} placeholder="10.0.0.3" mono />
            </Field>
          </div>

          <Field label="Authentication">
            <Segmented
              items={authItems}
              value={g.auth.type ?? "none"}
              onChange={(v) => set({ auth: { ...g.auth, type: v === "none" ? null : (v as AuthType) } })}
            />
          </Field>
          {g.auth.type && (
            <Field label="Password" hint="Left blank keeps the current password unchanged.">
              <TextInput value={g.auth.password ?? ""} onChange={(v) => set({ auth: { ...g.auth, password: v || null } })} placeholder="••••••••" mono />
            </Field>
          )}

          <Field label="Track interfaces" hint="Go to fault state if a tracked interface goes down.">
            <StringListEditor values={g.track_interfaces} onChange={(v) => set({ track_interfaces: v })} placeholder="eth2" addLabel="Add Interface" list="vrrp-interfaces" />
          </Field>
          <label className={switchLabel} style={switchLabelStyle}>
            <Switch on={g.track_exclude_vrrp_interface} onChange={(v) => set({ track_exclude_vrrp_interface: v })} />
            Exclude the VRRP interface from tracking
          </label>

          <Field label="Excluded addresses" hint="Addresses moved with the group but not advertised.">
            <StringListEditor values={g.excluded_addresses} onChange={(v) => set({ excluded_addresses: v })} placeholder="10.0.0.9/24" addLabel="Add Address" />
          </Field>

          <div style={sectionHead}>Health check</div>
          <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <Field label="Script path">
              <TextInput value={g.health_check.script ?? ""} onChange={(v) => setHc({ script: v || null })} placeholder="/config/scripts/chk.sh" mono />
            </Field>
            <Field label="Interval (s)">
              <TextInput value={g.health_check.interval?.toString() ?? ""} onChange={(v) => setHc({ interval: numOrNull(v) })} placeholder="60" mono />
            </Field>
            <Field label="Failure count">
              <TextInput value={g.health_check.failure_count?.toString() ?? ""} onChange={(v) => setHc({ failure_count: numOrNull(v) })} placeholder="3" mono />
            </Field>
            <Field label="Timeout (s)">
              <TextInput value={g.health_check.timeout?.toString() ?? ""} onChange={(v) => setHc({ timeout: numOrNull(v) })} placeholder="5" mono />
            </Field>
          </div>

          <div style={sectionHead}>Transition scripts</div>
          <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <Field label="Master">
              <TextInput value={g.transition_script.master ?? ""} onChange={(v) => setTs({ master: v || null })} placeholder="/config/scripts/master.sh" mono />
            </Field>
            <Field label="Backup">
              <TextInput value={g.transition_script.backup ?? ""} onChange={(v) => setTs({ backup: v || null })} placeholder="/config/scripts/backup.sh" mono />
            </Field>
            <Field label="Fault">
              <TextInput value={g.transition_script.fault ?? ""} onChange={(v) => setTs({ fault: v || null })} placeholder="/config/scripts/fault.sh" mono />
            </Field>
            <Field label="Stop">
              <TextInput value={g.transition_script.stop ?? ""} onChange={(v) => setTs({ stop: v || null })} placeholder="/config/scripts/stop.sh" mono />
            </Field>
          </div>

          <div style={sectionHead}>Gratuitous ARP</div>
          <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
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
        </Advanced>

        <ErrorText msg={error} />
        <ModalFooter onCancel={onClose} saving={saving} submitLabel={isEdit ? "Apply Changes" : "Add Group"} />
      </form>
    </ModalShell>
  );
}
