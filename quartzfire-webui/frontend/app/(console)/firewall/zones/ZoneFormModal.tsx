"use client";

import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
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
            className={inputCls}
            style={{ ...monoSt, opacity: locked ? 0.5 : 1 }}
            onFocus={focusBorder}
            onBlur={blurBorder}
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
            <div style={locked ? { opacity: 0.5, pointerEvents: "none" } : undefined}>
              <Segmented
                items={[
                  { value: "network", label: "Network zone" },
                  { value: "local", label: "Firewall zone" },
                ]}
                value={local ? "local" : "network"}
                onChange={(v) => setLocal(v === "local")}
              />
            </div>
          </Field>
        )}

        {!local && (
          <Field
            label="Interfaces"
            hint="An interface can only belong to one zone — those already claimed aren't listed."
          >
            <div
              className="rounded-md overflow-y-auto"
              style={{ ...monoSt, minHeight: 84, maxHeight: 150, padding: members.length ? "4px 0" : 0 }}
            >
              {members.length === 0 ? (
                <div className="flex items-center justify-center h-[84px] text-[13px] text-[var(--qz-fg-4)]">
                  No interfaces
                </div>
              ) : (
                members.map((m) => (
                  <div
                    key={m}
                    className="flex items-center gap-2 px-3 py-[5px] text-[13px] text-[var(--qz-fg-1)]"
                  >
                    <span>{descriptions[m] ?? m}</span>
                    {descriptions[m] && <span className="text-[11px] text-[var(--qz-fg-4)]">{m}</span>}
                    <button
                      type="button"
                      onClick={() => setMembers(members.filter((x) => x !== m))}
                      title={`Remove ${m}`}
                      className="ml-auto flex items-center justify-center w-[18px] h-[18px] rounded cursor-pointer border-0 text-[var(--qz-fg-4)] hover:text-[var(--qz-fg-1)]"
                      style={{ background: "transparent" }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))
              )}
            </div>
            <select
              value=""
              onChange={(e) => e.target.value && setMembers([...members, e.target.value])}
              disabled={addable.length === 0}
              className={`${inputCls} cursor-pointer mt-2`}
              style={{ ...monoSt, opacity: addable.length ? 1 : 0.5 }}
              onFocus={focusBorder}
              onBlur={blurBorder}
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
            <select
              value={intraZone}
              onChange={(e) => setIntraZone(e.target.value as RuleAction | "")}
              className={`${inputCls} cursor-pointer`}
              style={inputSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            >
              <option value="">Allow (default)</option>
              <option value="accept">Allow</option>
              <option value="drop">Deny</option>
              <option value="reject">Reject</option>
            </select>
          </Field>
        )}

        <label className="flex items-center gap-2 text-[13px] text-[var(--qz-fg-2)] cursor-pointer">
          <input type="checkbox" checked={defaultLog} onChange={(e) => setDefaultLog(e.target.checked)} />
          Log traffic denied by default (shows in the Traffic Monitor)
        </label>

        {/* A zone denies everything its pairs don't allow, so creating one with
            no rules yet cuts traffic off. Commit-confirm is the safety net. */}
        {!isEdit && (
          <div className="flex items-start gap-2 text-[11px] text-[var(--qz-fg-4)]">
            <AlertTriangle size={13} className="flex-shrink-0 mt-[2px]" />
            <span>
              Traffic to this zone is denied until a rule allows it. The change is applied under commit-confirm, so it
              reverts on its own if it cuts off your session.
            </span>
          </div>
        )}

        {error && (
          <p className="text-[12px] m-0" style={{ color: "var(--qz-danger)" }}>
            {error}
          </p>
        )}

        <div className="flex gap-2 justify-end mt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-[9px] rounded-md text-[13px] font-medium cursor-pointer"
            style={{ background: "transparent", border: "1px solid var(--qz-border)", color: "var(--qz-fg-2)" }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-[9px] rounded-md text-[13px] font-semibold cursor-pointer border-0"
            style={{ background: "var(--qz-accent)", color: "var(--qz-fg-on-accent)", opacity: saving ? 0.7 : 1 }}
          >
            {saving ? "Applying…" : isEdit ? "Apply changes" : "Create zone"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
