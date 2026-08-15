"use client";

// Shared form primitives for the High Availability pages (VRRP, Virtual
// Servers, Config Sync). Thin wrappers over the Clarity form classes so the
// three pages read as one.

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { ModalFooter as ClarityModalFooter } from "@/components/ui/Modal";

/// Mono face for addresses/paths, layered onto `clr-input`.
export const monoStyle = { fontFamily: "var(--qz-font-mono)" } as const;

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="clr-form-control" style={{ marginTop: 0 }}>
      <label className="clr-control-label">{label}</label>
      {children}
      {hint && <div className="clr-subtext">{hint}</div>}
    </div>
  );
}

/// A plain text input wired to the shared styling. `mono` for addresses/paths.
export function TextInput({
  value,
  onChange,
  placeholder,
  mono,
  list,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  list?: string;
  disabled?: boolean;
}) {
  return (
    <input
      value={value}
      list={list}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="clr-input"
      style={{ maxWidth: "none", ...(mono ? monoStyle : undefined) }}
    />
  );
}

/// Collapsible "Advanced" section wrapper.
export function Advanced({ children, label = "Advanced" }: { children: React.ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        border: "1px solid var(--cds-alias-object-border-subtle)",
        borderRadius: "var(--clr-base-border-radius-s)",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between bg-transparent border-0 cursor-pointer"
        style={{ padding: "10px 12px", fontSize: 13, fontWeight: 600, color: "var(--cds-alias-typography-color-450)" }}
      >
        <span>{label}</span>
        <Icon shape="angle" dir={open ? "up" : "down"} size={14} style={{ color: "var(--cds-alias-typography-color-200)" }} />
      </button>
      {open && (
        <div
          className="flex flex-col gap-3"
          style={{ padding: "8px 12px 12px", borderTop: "1px solid var(--cds-alias-object-border-subtle)" }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/// An add/remove editor for a list of free-text values (VIPs, members, track
/// interfaces, excluded addresses, config-sync sections).
export function StringListEditor({
  values,
  onChange,
  placeholder,
  addLabel = "Add",
  list,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  addLabel?: string;
  list?: string;
}) {
  const setAt = (i: number, v: string) => onChange(values.map((x, j) => (j === i ? v : x)));
  const removeAt = (i: number) => onChange(values.filter((_, j) => j !== i));
  return (
    <div className="flex flex-col gap-2">
      {values.map((v, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            value={v}
            list={list}
            onChange={(e) => setAt(i, e.target.value)}
            placeholder={placeholder}
            className="clr-input"
            style={{ maxWidth: "none", ...monoStyle }}
          />
          <button
            type="button"
            onClick={() => removeAt(i)}
            aria-label="Remove"
            className="btn btn-sm btn-link-neutral btn-icon flex-shrink-0"
          >
            <Icon shape="times" size={14} />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...values, ""])} className="btn btn-sm btn-neutral self-start">
        <Icon shape="plus" size={13} /> {addLabel}
      </button>
    </div>
  );
}

/// Modal footer with Cancel + submit.
export function ModalFooter({
  onCancel,
  saving,
  submitLabel,
}: {
  onCancel: () => void;
  saving: boolean;
  submitLabel: string;
}) {
  return (
    <ClarityModalFooter>
      <button type="button" className="btn btn-neutral" onClick={onCancel}>
        Cancel
      </button>
      <button type="submit" className="btn btn-primary" disabled={saving}>
        {saving ? "Applying…" : submitLabel}
      </button>
    </ClarityModalFooter>
  );
}

export function ErrorText({ msg }: { msg: string }) {
  if (!msg) return null;
  return (
    <div className="alert alert-danger alert-sm">
      <Icon shape="exclamation-circle" size={14} className="alert-icon" />
      <div className="alert-text">{msg}</div>
    </div>
  );
}

export const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s));
