"use client";

import { useState } from "react";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { applyDhcpRange, DhcpRange, DhcpServer } from "@/lib/services";

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

/// Create/edit an address range within a subnet. Renaming rebuilds the node.
export function RangeFormModal({
  server,
  servers,
  initial,
  onClose,
  onSaved,
}: {
  /** Shared network the range belongs to. */
  server: string;
  /** All shared networks, for the subnet picker and diffing. */
  servers: DhcpServer[];
  /** Present when editing; absent when creating. */
  initial?: { subnet: string; range: DhcpRange };
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const subnets = servers.find((s) => s.name === server)?.subnets ?? [];

  const [subnet, setSubnet] = useState(initial?.subnet ?? subnets[0]?.subnet ?? "");
  const [name, setName] = useState(initial?.range.name ?? "");
  const [start, setStart] = useState(initial?.range.start ?? "");
  const [stop, setStop] = useState(initial?.range.stop ?? "");

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    if (!subnet) {
      setError("Create a subnet first — ranges live inside one.");
      return;
    }
    const n = name.trim();
    if (!NAME_RE.test(n)) {
      setError("Range name may only use letters, digits, hyphens, and underscores.");
      return;
    }
    const clash = subnets
      .find((s) => s.subnet === subnet)
      ?.ranges.some((r) => r.name === n && !(isEdit && r.name === initial!.range.name));
    if (clash) {
      setError(`Range ${n} already exists in ${subnet}.`);
      return;
    }
    if (!IPV4_RE.test(start.trim()) || !IPV4_RE.test(stop.trim())) {
      setError("Start and stop must both be IPv4 addresses.");
      return;
    }

    setSaving(true);
    try {
      const applied = await applyDhcpRange(servers, {
        server,
        subnet,
        name: n,
        start: start.trim(),
        stop: stop.trim(),
        original_name: initial?.range.name ?? null,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to range ${n}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply range.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={480}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Create"} Address Range`}
        subtitle={`DHCP server ${server}`}
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Subnet" hint={isEdit ? "Ranges cannot move between subnets." : undefined}>
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
          <Field label="Range Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="pool-1"
              className="clr-input"
              style={mono}
            />
          </Field>
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Start">
            <input
              value={start}
              onChange={(e) => setStart(e.target.value)}
              placeholder="192.168.1.100"
              className="clr-input"
              style={mono}
            />
          </Field>
          <Field label="Stop">
            <input
              value={stop}
              onChange={(e) => setStop(e.target.value)}
              placeholder="192.168.1.199"
              className="clr-input"
              style={mono}
            />
          </Field>
        </div>

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
            {saving ? "Applying…" : isEdit ? "Apply Changes" : "Create Range"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
