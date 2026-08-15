"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import {
  ErrorText,
  Field,
  ModalFooter,
  TextInput,
  monoStyle,
  numOrNull,
} from "../formkit";
import {
  ALGORITHMS,
  Algorithm,
  FORWARD_METHODS,
  ForwardMethod,
  Protocol,
  RealServer,
  VirtualServer,
  applyVirtualServer,
  emptyRealServer,
  emptyVirtualServer,
} from "@/lib/virtual-server";

const ALGO_LABEL: Record<Algorithm, string> = {
  "round-robin": "Round robin",
  "weighted-round-robin": "Weighted round robin",
  "least-connection": "Least connection",
  "weighted-least-connection": "Weighted least connection",
  "source-hashing": "Source hashing",
  "destination-hashing": "Destination hashing",
  "locality-based-least-connection": "Locality-based least connection",
};

function RealServerRow({
  rs,
  onChange,
  onRemove,
}: {
  rs: RealServer;
  onChange: (r: RealServer) => void;
  onRemove: () => void;
}) {
  const set = (patch: Partial<RealServer>) => onChange({ ...rs, ...patch });
  return (
    <div
      className="p-3 flex flex-col gap-3"
      style={{
        border: "1px solid var(--cds-alias-object-border-subtle)",
        borderRadius: "var(--clr-base-border-radius-s)",
      }}
    >
      <div className="flex items-center gap-2">
        <input
          value={rs.address}
          onChange={(e) => set({ address: e.target.value })}
          placeholder="192.0.2.11"
          className="clr-input"
          style={{ maxWidth: "none", ...monoStyle }}
        />
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove real server"
          className="btn btn-sm btn-link-neutral btn-icon flex-shrink-0"
        >
          <Icon shape="trash" size={14} />
        </button>
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
        <Field label="Port">
          <TextInput value={rs.port?.toString() ?? ""} onChange={(v) => set({ port: numOrNull(v) })} placeholder="80" mono />
        </Field>
        <Field label="Weight" hint="1–256">
          <TextInput value={rs.weight?.toString() ?? ""} onChange={(v) => set({ weight: numOrNull(v) })} placeholder="1" mono />
        </Field>
        <Field label="Conn. timeout (s)">
          <TextInput value={rs.connection_timeout?.toString() ?? ""} onChange={(v) => set({ connection_timeout: numOrNull(v) })} placeholder="5" mono />
        </Field>
      </div>
      <Field label="Health-check script" hint="Optional keepalived script path.">
        <TextInput value={rs.health_check_script ?? ""} onChange={(v) => set({ health_check_script: v || null })} placeholder="/config/scripts/check.sh" mono />
      </Field>
    </div>
  );
}

export function VirtualServerFormModal({
  initial,
  existingIds,
  onClose,
  onSaved,
}: {
  initial?: VirtualServer;
  existingIds: string[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const [vs, setVs] = useState<VirtualServer>(initial ?? emptyVirtualServer());
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const set = (patch: Partial<VirtualServer>) => setVs((p) => ({ ...p, ...patch }));
  const setRs = (i: number, r: RealServer) => setVs((p) => ({ ...p, real_servers: p.real_servers.map((x, j) => (j === i ? r : x)) }));

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    const id = vs.id.trim();
    if (!id) return setError("Enter the virtual IP (or a name when using fwmark).");
    if (!isEdit && existingIds.includes(id)) return setError(`${id} already exists.`);
    const reals = vs.real_servers.filter((r) => r.address.trim() !== "");
    if (reals.length === 0) return setError("Add at least one real server.");

    setSaving(true);
    try {
      const applied = await applyVirtualServer(initial ?? null, {
        ...vs,
        id,
        real_servers: reals.map((r) => ({ ...r, address: r.address.trim() })),
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to ${id}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={640}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Add"} Virtual Server`}
        subtitle={isEdit ? vs.id : "An L4 load-balanced service (IPVS)"}
        onClose={onClose}
      />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4" style={{ gridTemplateColumns: "2fr 1fr 1fr" }}>
          <Field label="Virtual IP / name" hint="The service address, or a name if matching a fwmark.">
            <TextInput value={vs.id} onChange={(v) => set({ id: v })} placeholder="203.0.113.1" mono disabled={isEdit} />
          </Field>
          <Field label="Port">
            <TextInput value={vs.port?.toString() ?? ""} onChange={(v) => set({ port: numOrNull(v) })} placeholder="80" mono />
          </Field>
          <Field label="Fwmark" hint="firewall mark">
            <TextInput value={vs.fwmark?.toString() ?? ""} onChange={(v) => set({ fwmark: numOrNull(v) })} placeholder="—" mono />
          </Field>
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Protocol">
            <Segmented
              items={[
                { value: "none", label: "—" },
                { value: "tcp", label: "TCP" },
                { value: "udp", label: "UDP" },
              ]}
              value={vs.protocol ?? "none"}
              onChange={(v) => set({ protocol: v === "none" ? null : (v as Protocol) })}
            />
          </Field>
          <Field label="Forward method">
            <Segmented
              items={[
                { value: "none", label: "—" },
                ...FORWARD_METHODS.map((m) => ({ value: m, label: m.toUpperCase() })),
              ]}
              value={vs.forward_method ?? "none"}
              onChange={(v) => set({ forward_method: v === "none" ? null : (v as ForwardMethod) })}
            />
          </Field>
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: "2fr 1fr 1fr" }}>
          <Field label="Algorithm">
            <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
              <select
                value={vs.algorithm ?? ""}
                onChange={(e) => set({ algorithm: (e.target.value || null) as Algorithm | null })}
                className="clr-select"
                style={{ maxWidth: "none" }}
              >
                <option value="">— (default)</option>
                {ALGORITHMS.map((a) => (
                  <option key={a} value={a}>{ALGO_LABEL[a]}</option>
                ))}
              </select>
            </div>
          </Field>
          <Field label="Delay loop (s)">
            <TextInput value={vs.delay_loop?.toString() ?? ""} onChange={(v) => set({ delay_loop: numOrNull(v) })} placeholder="10" mono />
          </Field>
          <Field label="Persistence (s)">
            <TextInput value={vs.persistence_timeout?.toString() ?? ""} onChange={(v) => set({ persistence_timeout: numOrNull(v) })} placeholder="300" mono />
          </Field>
        </div>

        <div className="clr-form-control" style={{ marginTop: 0 }}>
          <label className="clr-control-label">Real servers</label>
          <div className="flex flex-col gap-2">
            {vs.real_servers.map((r, i) => (
              <RealServerRow
                key={i}
                rs={r}
                onChange={(nr) => setRs(i, nr)}
                onRemove={() => set({ real_servers: vs.real_servers.filter((_, j) => j !== i) })}
              />
            ))}
            <button
              type="button"
              onClick={() => set({ real_servers: [...vs.real_servers, emptyRealServer()] })}
              className="btn btn-sm btn-neutral self-start"
            >
              <Icon shape="plus" size={13} /> Add Real Server
            </button>
          </div>
        </div>

        <ErrorText msg={error} />
        <ModalFooter onCancel={onClose} saving={saving} submitLabel={isEdit ? "Apply Changes" : "Add Virtual Server"} />
      </form>
    </ModalShell>
  );
}
