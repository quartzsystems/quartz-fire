"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import {
  applyZone,
  FirewallConfig,
  FirewallZone,
  interfaceZone,
  localZone,
  RuleAction,
  sanitizeAliasName,
  ZoneDefaultAction,
} from "@/lib/firewall";

const monoFont = { fontFamily: "var(--qz-font-mono)" } as const;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="clr-form-control" style={{ marginTop: 0 }}>
      <label className="clr-control-label">{label}</label>
      {children}
      {hint && <div className="clr-subtext">{hint}</div>}
    </div>
  );
}

// Friendly names may contain spaces — the backing VyOS zone name can't, so
// spaces become hyphens on save (see sanitizeAliasName).
const NAME_RE = /^[A-Za-z][A-Za-z0-9 _-]*$/;

/// Create/edit a firewall zone. Diffs against the live config and commits
/// immediately (the boot-config save runs in the background).
export function ZoneFormModal({
  initial,
  config,
  interfaces,
  descriptions,
  usedByRules,
  onClose,
  onSaved,
}: {
  /** Present when editing an existing zone; absent when creating. */
  initial?: FirewallZone;
  /** Live firewall config — existing zones, for validation and diffing. */
  config: FirewallConfig;
  /** Assignable interface names. */
  interfaces: string[];
  descriptions: Record<string, string>;
  /** How many rules sit in this zone's pairs — locks the identity fields. */
  usedByRules: number;
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  // Renaming a zone or turning it into the Firewall zone would strand the
  // pairs its rules live in, so identity is locked while rules exist.
  const locked = isEdit && usedByRules > 0;

  const [name, setName] = useState(initial?.display ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [local, setLocal] = useState(initial?.local ?? false);
  const [members, setMembers] = useState<string[]>(initial?.interfaces ?? []);
  const [defaultAction, setDefaultAction] = useState<ZoneDefaultAction>(initial?.default_action ?? "drop");
  const [defaultLog, setDefaultLog] = useState(initial?.default_log ?? false);
  const [intraZone, setIntraZone] = useState<RuleAction | "">(initial?.intra_zone ?? "");

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Only one Firewall zone is allowed, so hide the option when another zone
  // already is it.
  const otherLocal = localZone(config.zones.filter((z) => z.name !== initial?.name));
  const ifaceLabel = (n: string) => (descriptions[n] ? `${descriptions[n]} (${n})` : n);
  // An interface can only be in one zone — VyOS rejects the commit otherwise.
  const addable = interfaces.filter(
    (n) => !members.includes(n) && interfaceZone(config.zones, n, initial?.name ?? null) === null,
  );

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const display = name.trim().replace(/\s+/g, " ");
    if (!NAME_RE.test(display)) {
      setError("Name must start with a letter and use only letters, digits, spaces, hyphens, and underscores.");
      return;
    }
    const n = sanitizeAliasName(display);
    const clash = config.zones.some((z) => z.name === n && !(isEdit && z.name === initial!.name));
    if (clash) {
      setError(`A zone named ${display} already exists (device name ${n}).`);
      return;
    }

    setSaving(true);
    try {
      // diffZone re-runs the same validation VyOS enforces at commit and throws
      // a readable message — no need to duplicate those checks here.
      const applied = await applyZone(config, {
        name: n,
        display,
        description: description.trim() || null,
        local,
        interfaces: local ? [] : members,
        default_action: defaultAction,
        default_log: defaultLog,
        intra_zone: local || intraZone === "" ? null : intraZone,
        original_name: initial?.name ?? null,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to zone ${display} — confirm the change in the banner.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply zone.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={520}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Create"} Zone`}
        subtitle="A named group of interfaces for zone-based rules"
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field
          label="Name"
          hint={
            locked
              ? `In use by ${usedByRules} rule${usedByRules === 1 ? "" : "s"} — the name and kind are locked.`
              : /\s/.test(name.trim())
                ? `Spaces are fine here — stored on the device as ${sanitizeAliasName(name)}.`
                : undefined
          }
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="LAN"
            disabled={locked}
            className="clr-input"
            style={{ maxWidth: "none", ...monoFont }}
          />
        </Field>

        {(!otherLocal || local) && (
          <Field
            label="Kind"
            hint={
              local
                ? "The firewall itself. It has no interfaces — pick it as a rule's From or To via the built-in Firewall endpoint."
                : "A group of interfaces."
            }
          >
            <div className="flex gap-4">
              <div className="clr-radio-wrapper">
                <input
                  type="radio"
                  id="zone-kind-network"
                  name="zone-kind"
                  checked={!local}
                  disabled={locked}
                  onChange={() => setLocal(false)}
                />
                <label htmlFor="zone-kind-network">Network zone</label>
              </div>
              <div className="clr-radio-wrapper">
                <input
                  type="radio"
                  id="zone-kind-local"
                  name="zone-kind"
                  checked={local}
                  disabled={locked}
                  onChange={() => setLocal(true)}
                />
                <label htmlFor="zone-kind-local">Firewall zone</label>
              </div>
            </div>
          </Field>
        )}

        {!local && (
          <Field
            label="Interfaces"
            hint="An interface can only belong to one zone — those already claimed aren't listed."
          >
            <div
              className="overflow-y-auto"
              style={{
                border: "1px solid var(--cds-alias-object-border-color)",
                borderRadius: 4,
                ...monoFont,
                minHeight: 84,
                maxHeight: 150,
                padding: members.length ? "4px 0" : 0,
              }}
            >
              {members.length === 0 ? (
                <div
                  className="flex items-center justify-center h-[84px]"
                  style={{ fontSize: 13, color: "var(--cds-alias-typography-color-200)" }}
                >
                  No interfaces
                </div>
              ) : (
                members.map((m) => (
                  <div
                    key={m}
                    className="flex items-center gap-2 px-3 py-[5px]"
                    style={{ fontSize: 13, color: "var(--cds-alias-typography-color-450)" }}
                  >
                    <span>{descriptions[m] ?? m}</span>
                    {descriptions[m] && (
                      <span style={{ fontSize: 11, color: "var(--cds-alias-typography-color-200)" }}>{m}</span>
                    )}
                    <button
                      type="button"
                      onClick={() => setMembers(members.filter((x) => x !== m))}
                      title={`Remove ${m}`}
                      className="btn btn-sm btn-link-neutral btn-icon ml-auto flex-shrink-0"
                      style={{ margin: "0 0 0 auto" }}
                    >
                      <Icon shape="times" size={12} />
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="clr-select-wrapper" style={{ maxWidth: "none", marginTop: 8 }}>
              <select
                value=""
                onChange={(e) => e.target.value && setMembers([...members, e.target.value])}
                disabled={addable.length === 0}
                className="clr-select"
                style={{ maxWidth: "none", width: "100%", ...monoFont }}
              >
                <option value="" disabled>
                  {addable.length ? "Add interface…" : "No unassigned interfaces left"}
                </option>
                {addable.map((n) => (
                  <option key={n} value={n}>
                    {ifaceLabel(n)}
                  </option>
                ))}
              </select>
            </div>
          </Field>
        )}

        <Field
          label="Traffic into this zone that no rule allows"
          hint="Zones deny by default — this only chooses how. Reject replies; Deny stays silent."
        >
          <Segmented
            items={[
              { value: "drop", label: "Deny" },
              { value: "reject", label: "Reject" },
            ]}
            value={defaultAction}
            onChange={(v) => setDefaultAction(v as ZoneDefaultAction)}
          />
        </Field>

        {!local && (
          <Field
            label="Traffic between this zone's own interfaces"
            hint="VyOS lets members of a zone talk freely unless you filter here."
          >
            <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
              <select
                value={intraZone}
                onChange={(e) => setIntraZone(e.target.value as RuleAction | "")}
                className="clr-select"
                style={{ maxWidth: "none", width: "100%" }}
              >
                <option value="">Allow (default)</option>
                <option value="accept">Allow</option>
                <option value="drop">Deny</option>
                <option value="reject">Reject</option>
              </select>
            </div>
          </Field>
        )}

        <div className="clr-checkbox-wrapper">
          <input
            type="checkbox"
            id="zone-default-log"
            checked={defaultLog}
            onChange={(e) => setDefaultLog(e.target.checked)}
          />
          <label htmlFor="zone-default-log">Log traffic denied by default (shows in the Traffic Monitor)</label>
        </div>

        {/* A zone denies everything its pairs don't allow, so creating one with
            no rules yet cuts traffic off. Commit-confirm is the safety net. */}
        {!isEdit && (
          <div className="alert alert-warning alert-sm">
            <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
            <div className="alert-text">
              Traffic to this zone is denied until a rule allows it. The change is applied under commit-confirm, so it
              reverts on its own if it cuts off your session.
            </div>
          </div>
        )}

        {error && (
          <div className="alert alert-danger alert-sm">
            <Icon shape="exclamation-circle" size={14} className="alert-icon" />
            <div className="alert-text">{error}</div>
          </div>
        )}

        <ModalFooter>
          <button type="button" className="btn btn-neutral" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "Applying…" : isEdit ? "Apply Changes" : "Create Zone"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
