"use client";

import { useState } from "react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import {
  Advanced,
  ErrorText,
  Field,
  ModalFooter,
  StringListEditor,
  TextInput,
  numOrNull,
} from "../formkit";
import { VrrpSyncGroup, applySyncGroup, emptySyncGroup } from "@/lib/vrrp";

export function SyncGroupFormModal({
  initial,
  existingNames,
  groupNames,
  onClose,
  onSaved,
}: {
  initial?: VrrpSyncGroup;
  existingNames: string[];
  /** Configured VRRP group names (members must reference these). */
  groupNames: string[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const [sg, setSg] = useState<VrrpSyncGroup>(initial ?? emptySyncGroup());
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const setHc = (patch: Partial<VrrpSyncGroup["health_check"]>) =>
    setSg((p) => ({ ...p, health_check: { ...p.health_check, ...patch } }));
  const setTs = (patch: Partial<VrrpSyncGroup["transition_script"]>) =>
    setSg((p) => ({ ...p, transition_script: { ...p.transition_script, ...patch } }));

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    const name = sg.name.trim();
    if (!name) return setError("Enter a sync-group name.");
    if (!isEdit && existingNames.includes(name)) return setError(`${name} already exists.`);
    const members = sg.members.map((m) => m.trim()).filter(Boolean);
    if (members.length < 2) return setError("A sync-group needs at least two member groups.");

    setSaving(true);
    try {
      const applied = await applySyncGroup(initial ?? null, { ...sg, name, members });
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

  return (
    <ModalShell onClose={onClose} maxWidth={560}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Add"} Sync Group`}
        subtitle={isEdit ? sg.name : "Fail groups over together"}
        onClose={onClose}
      />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <datalist id="vrrp-group-names">{groupNames.map((n) => <option key={n} value={n} />)}</datalist>

        <Field label="Name">
          <TextInput value={sg.name} onChange={(v) => setSg((p) => ({ ...p, name: v }))} placeholder="failover" mono disabled={isEdit} />
        </Field>

        <Field label="Member groups" hint="Two or more VRRP groups that transition state together.">
          <StringListEditor
            values={sg.members}
            onChange={(v) => setSg((p) => ({ ...p, members: v }))}
            placeholder="LAN"
            addLabel="Add member"
            list="vrrp-group-names"
          />
        </Field>

        <Advanced label="Health check & transition scripts">
          <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <Field label="Health-check script">
              <TextInput value={sg.health_check.script ?? ""} onChange={(v) => setHc({ script: v || null })} placeholder="/config/scripts/chk.sh" mono />
            </Field>
            <Field label="Interval (s)">
              <TextInput value={sg.health_check.interval?.toString() ?? ""} onChange={(v) => setHc({ interval: numOrNull(v) })} placeholder="60" mono />
            </Field>
            <Field label="Failure count">
              <TextInput value={sg.health_check.failure_count?.toString() ?? ""} onChange={(v) => setHc({ failure_count: numOrNull(v) })} placeholder="3" mono />
            </Field>
            <Field label="Timeout (s)">
              <TextInput value={sg.health_check.timeout?.toString() ?? ""} onChange={(v) => setHc({ timeout: numOrNull(v) })} placeholder="5" mono />
            </Field>
          </div>
          <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <Field label="Master script">
              <TextInput value={sg.transition_script.master ?? ""} onChange={(v) => setTs({ master: v || null })} placeholder="/config/scripts/master.sh" mono />
            </Field>
            <Field label="Backup script">
              <TextInput value={sg.transition_script.backup ?? ""} onChange={(v) => setTs({ backup: v || null })} placeholder="/config/scripts/backup.sh" mono />
            </Field>
            <Field label="Fault script">
              <TextInput value={sg.transition_script.fault ?? ""} onChange={(v) => setTs({ fault: v || null })} placeholder="/config/scripts/fault.sh" mono />
            </Field>
            <Field label="Stop script">
              <TextInput value={sg.transition_script.stop ?? ""} onChange={(v) => setTs({ stop: v || null })} placeholder="/config/scripts/stop.sh" mono />
            </Field>
          </div>
        </Advanced>

        <ErrorText msg={error} />
        <ModalFooter onCancel={onClose} saving={saving} submitLabel={isEdit ? "Apply changes" : "Add sync-group"} />
      </form>
    </ModalShell>
  );
}
