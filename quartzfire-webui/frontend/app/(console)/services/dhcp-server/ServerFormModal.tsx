"use client";

import { useState } from "react";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { applyDhcpServer, DhcpFirstSubnet, DhcpServer } from "@/lib/services";

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

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/([0-9]|[12][0-9]|3[0-2])$/;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

const ipToInt = (ip: string) => ip.split(".").reduce((acc, o) => acc * 256 + Number(o), 0);

function inSubnet(ip: string, cidr: string): boolean {
  const [net, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const shift = 32 - bits;
  return Math.floor(ipToInt(ip) / 2 ** shift) === Math.floor(ipToInt(net) / 2 ** shift);
}

/// Create/edit a DHCP shared network. The name is the config-node identity, so
/// it is locked while editing.
///
/// Creating also collects the first subnet and its lease range — VyOS refuses
/// to commit a shared network without a subnet, and a shared network whose
/// subnets have no range, so a bare server node can never exist on its own.
export function ServerFormModal({
  initial,
  existing,
  onClose,
  onSaved,
}: {
  /** Present when editing an existing shared network; absent when creating. */
  initial?: DhcpServer;
  /** All existing shared networks, for duplicate detection and diffing. */
  existing: DhcpServer[];
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [authoritative, setAuthoritative] = useState(initial?.authoritative ?? true);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  // First subnet — create mode only.
  const [subnet, setSubnet] = useState("");
  const [gateway, setGateway] = useState("");
  const [rangeStart, setRangeStart] = useState("");
  const [rangeStop, setRangeStop] = useState("");
  const [nameServersText, setNameServersText] = useState("");

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const n = name.trim();
    if (!NAME_RE.test(n)) {
      setError("Name must start with a letter and use only letters, digits, hyphens, and underscores.");
      return;
    }
    if (!isEdit && existing.some((s) => s.name === n)) {
      setError(`A DHCP server named ${n} already exists.`);
      return;
    }

    let firstSubnet: DhcpFirstSubnet | null = null;
    if (!isEdit) {
      const cidr = subnet.trim();
      if (!CIDR_RE.test(cidr)) {
        setError("Subnet must be an IPv4 network in CIDR notation (e.g. 192.168.1.0/24).");
        return;
      }
      const gw = gateway.trim();
      if (gw && !IPV4_RE.test(gw)) {
        setError("Gateway must be an IPv4 address.");
        return;
      }
      const start = rangeStart.trim();
      const stop = rangeStop.trim();
      if (!IPV4_RE.test(start) || !IPV4_RE.test(stop)) {
        setError("Range start and stop must both be IPv4 addresses.");
        return;
      }
      if (!inSubnet(start, cidr) || !inSubnet(stop, cidr)) {
        setError(`Range addresses must be inside ${cidr}.`);
        return;
      }
      if (ipToInt(start) > ipToInt(stop)) {
        setError("Range start must not be above range stop.");
        return;
      }
      const nameServers = nameServersText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const badNs = nameServers.find((s) => !IPV4_RE.test(s));
      if (badNs) {
        setError(`"${badNs}" is not a valid name server address.`);
        return;
      }
      firstSubnet = {
        subnet: cidr,
        default_router: gw || null,
        name_servers: nameServers,
        range_start: start,
        range_stop: stop,
      };
    }

    setSaving(true);
    try {
      const applied = await applyDhcpServer(existing, {
        name: n,
        description: description.trim() || null,
        authoritative,
        enabled,
        first_subnet: firstSubnet,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to DHCP server ${n}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply DHCP server.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={520}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Create"} DHCP Server`}
        subtitle="A shared network grouping one or more subnets"
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name" hint={isEdit ? "The name is the config identity and cannot be changed." : undefined}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="LAN"
            disabled={isEdit}
            className="clr-input"
            style={mono}
          />
        </Field>

        <Field label="Description">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Office LAN pool"
            className="clr-input"
            style={wide}
          />
        </Field>

        {!isEdit && (
          <>
            <div style={{ borderTop: "1px solid var(--cds-alias-object-border-subtle)", paddingTop: 12 }}>
              <div className="text-[12px] font-semibold" style={{ color: "var(--cds-alias-typography-color-450)" }}>
                First subnet
              </div>
              <p className="clr-subtext" style={{ marginTop: 3 }}>
                A server needs at least one subnet with a lease range to exist. More subnets can be added afterwards.
              </p>
            </div>

            <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <Field label="Subnet">
                <input
                  value={subnet}
                  onChange={(e) => setSubnet(e.target.value)}
                  placeholder="192.168.1.0/24"
                  className="clr-input"
                  style={mono}
                />
              </Field>
              <Field label="Gateway" hint="Handed to clients as their default router.">
                <input
                  value={gateway}
                  onChange={(e) => setGateway(e.target.value)}
                  placeholder="192.168.1.1"
                  className="clr-input"
                  style={mono}
                />
              </Field>
            </div>

            <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <Field label="Range Start">
                <input
                  value={rangeStart}
                  onChange={(e) => setRangeStart(e.target.value)}
                  placeholder="192.168.1.100"
                  className="clr-input"
                  style={mono}
                />
              </Field>
              <Field label="Range Stop">
                <input
                  value={rangeStop}
                  onChange={(e) => setRangeStop(e.target.value)}
                  placeholder="192.168.1.200"
                  className="clr-input"
                  style={mono}
                />
              </Field>
            </div>

            <Field label="DNS Servers" hint="Optional — one IPv4 address per line, handed to clients.">
              <textarea
                value={nameServersText}
                onChange={(e) => setNameServersText(e.target.value)}
                placeholder={"192.168.1.1\n1.1.1.1"}
                rows={2}
                className="clr-textarea"
                style={{ ...mono, minHeight: 0 }}
              />
            </Field>
          </>
        )}

        <label className="clr-toggle-wrapper cursor-pointer select-none">
          <Switch on={authoritative} onChange={setAuthoritative} />
          <span style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>
            Authoritative — answer clients as the definitive server for these subnets
          </span>
        </label>

        <label className="clr-toggle-wrapper cursor-pointer select-none">
          <Switch on={enabled} onChange={setEnabled} />
          <span style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>Enabled</span>
        </label>

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
            {saving ? "Applying…" : isEdit ? "Apply Changes" : "Create Server"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
