"use client";

// Shared form primitives for the High Availability pages (VRRP, Virtual
// Servers, Config Sync). Mirrors the input styling used across the WebUI's
// existing config modals so the three pages read as one.

import { useState } from "react";
import { Plus, X } from "lucide-react";

export const inputCls = "w-full rounded-md px-3 py-[9px] text-[13px] text-[var(--qz-fg-1)] outline-none";
export const inputSt = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;
export const monoSt = { ...inputSt, fontFamily: "var(--qz-font-mono)" } as const;

export function focusBorder(e: React.FocusEvent<HTMLElement>) {
  (e.currentTarget as HTMLElement).style.borderColor = "var(--qz-accent)";
}
export function blurBorder(e: React.FocusEvent<HTMLElement>) {
  (e.currentTarget as HTMLElement).style.borderColor = "var(--qz-border)";
}

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
    <div>
      <label className="block text-[12px] text-[var(--qz-fg-3)] mb-[6px]">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-[var(--qz-fg-4)] m-0 mt-[5px]">{hint}</p>}
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
      className={`${inputCls} disabled:opacity-70`}
      style={mono ? monoSt : inputSt}
      onFocus={focusBorder}
      onBlur={blurBorder}
    />
  );
}

/// Collapsible "Advanced" section wrapper.
export function Advanced({ children, label = "Advanced" }: { children: React.ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md" style={inputSt}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-[10px] bg-transparent border-0 cursor-pointer text-[13px] font-medium text-[var(--qz-fg-1)]"
      >
        <span>{label}</span>
        <span className="text-[var(--qz-fg-4)]">{open ? "–" : "+"}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 flex flex-col gap-3 border-t" style={{ borderColor: "var(--qz-border)" }}>
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
            className={inputCls}
            style={monoSt}
            onFocus={focusBorder}
            onBlur={blurBorder}
          />
          <button
            type="button"
            onClick={() => removeAt(i)}
            aria-label="Remove"
            className="grid place-items-center w-8 h-8 rounded-md bg-transparent border border-[var(--qz-border)] text-[var(--qz-fg-4)] hover:text-[var(--qz-danger)] transition-colors cursor-pointer flex-shrink-0"
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...values, ""])}
        className="inline-flex items-center gap-[6px] self-start text-[12px] font-medium px-[10px] py-[6px] rounded-md bg-transparent border border-[var(--qz-border)] text-[var(--qz-fg-2)] hover:text-[var(--qz-fg-1)] hover:border-[var(--qz-border-strong)] transition-colors cursor-pointer"
      >
        <Plus size={13} /> {addLabel}
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
    <div className="flex gap-2 justify-end mt-1">
      <button
        type="button"
        onClick={onCancel}
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
        {saving ? "Applying…" : submitLabel}
      </button>
    </div>
  );
}

export function ErrorText({ msg }: { msg: string }) {
  if (!msg) return null;
  return <p className="text-[12px] m-0" style={{ color: "var(--qz-danger)" }}>{msg}</p>;
}

export const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s));
