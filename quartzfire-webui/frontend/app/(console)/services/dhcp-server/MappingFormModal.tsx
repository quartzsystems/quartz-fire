"use client";

import { useState } from "react";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { applyDhcpMapping, DhcpServer, DhcpStaticMapping } from "@/lib/services";

const wide = { maxWidth: "none" } as const;
const mono = { maxWidth: "none", fontFamily: "var(--qz-font-mono)" } as const;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="clr-form-control" style={{ marginTop: 0 }}>
      <label className="clr-control-label">{label}</label>
      {children}
      {hint && <div className="clr-subtext">{hint}</div>}
    </div>
  );
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;

/// Create/edit a static mapping (fixed IP reservation) within a subnet.
/// Renaming rebuilds the node.
export function MappingFormModal({
  server,
  servers,
  initial,
  onClose,
  onSaved,
}: {
  /** Shared network the mapping belongs to. */
  server: string;
  /** All shared networks, for the subnet picker and diffing. */
  servers: DhcpServer[];
  /** Present when editing; absent when creating. */
  initial?: { subnet: string; mapping: DhcpStaticMapping };
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const subnets = servers.find((s) => s.name === server)?.subnets ?? [];

  const [subnet, setSubnet] = useState(initial?.subnet ?? subnets[0]?.subnet ?? "");
  const [name, setName] = useState(initial?.mapping.name ?? "");
  const [ipAddress, setIpAddress] = useState(initial?.mapping.ip_address ?? "");
  const [macAddress, setMacAddress] = useState(initial?.mapping.mac_address ?? "");
  const [description, setDescription] = useState(initial?.mapping.description ?? "");

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    if (!subnet) {
      setError("Create a subnet first — static mappings live inside one.");
      return;
    }
    const n = name.trim();
    if (!NAME_RE.test(n)) {
      setError("Mapping name may only use letters, digits, hyphens, and underscores.");
      return;
    }
    const clash = subnets
      .find((s) => s.subnet === subnet)
      ?.static_mappings.some((m) => m.name === n && !(isEdit && m.name === initial!.mapping.name));
    if (clash) {
      setError(`Mapping ${n} already exists in ${subnet}.`);
      return;
    }
    if (!IPV4_RE.test(ipAddress.trim())) {
      setError("IP address must be an IPv4 address.");
      return;
    }
    if (!MAC_RE.test(macAddress.trim())) {
      setError("MAC address must look like aa:bb:cc:dd:ee:ff.");
      return;
    }

    setSaving(true);
    try {
      const applied = await applyDhcpMapping(servers, {
        server,
        subnet,
        name: n,
        ip_address: ipAddress.trim(),
        mac_address: macAddress.trim().toLowerCase(),
        description: description.trim() || null,
        original_name: initial?.mapping.name ?? null,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to mapping ${n}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply mapping.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={520}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Create"} Static Mapping`}
        subtitle={`DHCP server ${server}`}
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Subnet" hint={isEdit ? "Mappings cannot move between subnets." : undefined}>
            <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
              <select
                value={subnet}
                onChange={(e) => setSubnet(e.target.value)}
                disabled={isEdit}
                className="clr-select"
                style={mono}
              >
                {subnets.map((s) => (
                  <option key={s.subnet} value={s.subnet}>
                    {s.subnet}
                  </option>
                ))}
              </select>
            </div>
          </Field>
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="printer-1"
              className="clr-input"
              style={mono}
            />
          </Field>
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="IP Address" hint="The fixed address handed to this client.">
            <input
              value={ipAddress}
              onChange={(e) => setIpAddress(e.target.value)}
              placeholder="192.168.1.50"
              className="clr-input"
              style={mono}
            />
          </Field>
          <Field label="MAC Address">
            <input
              value={macAddress}
              onChange={(e) => setMacAddress(e.target.value)}
              placeholder="aa:bb:cc:dd:ee:ff"
              className="clr-input"
              style={mono}
            />
          </Field>
        </div>

        <Field label="Description">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Front-office printer"
            className="clr-input"
            style={wide}
          />
        </Field>

        {error && (
          <p className="text-[12px] m-0" style={{ color: "var(--cds-alias-status-danger)" }}>
            {error}
          </p>
        )}

        <ModalFooter>
          <button type="button" className="btn btn-neutral" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "Applying…" : isEdit ? "Apply Changes" : "Create Mapping"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
