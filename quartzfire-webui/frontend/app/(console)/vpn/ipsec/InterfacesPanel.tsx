"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { applyIpsecInterfaces } from "@/lib/ipsec";

/// Which interfaces IKE/IPsec listens on (`vpn ipsec interface <name>`). A peer
/// won't come up until its `local-address` interface is bound here. Edited as a
/// simple toggle list against the known interfaces, plus any already-bound
/// names that no longer appear as live interfaces (so they stay removable).
export function InterfacesPanel({ live, interfaces, onSaved }: {
  live: string[];
  interfaces: string[];
  onSaved: (message: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(live));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Show every live interface plus any bound name not in that list.
  const names = Array.from(new Set([...interfaces, ...live])).sort((a, b) => a.localeCompare(b));

  const toggle = (name: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  const dirty = selected.size !== live.length || live.some((n) => !selected.has(n));

  const apply = async () => {
    setError("");
    setSaving(true);
    try {
      const applied = await applyIpsecInterfaces(live, Array.from(selected));
      onSaved(applied === 0 ? "No changes — interface bindings already match." : `Updated IPsec interface bindings.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to apply changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <div className="card-block">
        <p className="text-[13px] m-0" style={{ color: "var(--cds-alias-typography-color-300)", marginBottom: 12 }}>
          IKE listens on these interfaces.
        </p>

        {names.length === 0 && <p className="text-[13px] m-0" style={{ color: "var(--cds-alias-typography-color-200)" }}>No interfaces available.</p>}

        <div className="flex flex-col" style={{ gap: 6 }}>
          {names.map((name) => (
            <div key={name} className="clr-checkbox-wrapper">
              <input
                id={`ipsec-if-${name}`}
                type="checkbox"
                checked={selected.has(name)}
                onChange={(e) => toggle(name, e.target.checked)}
              />
              <label htmlFor={`ipsec-if-${name}`} style={{ fontFamily: "var(--qz-font-mono)" }}>{name}</label>
            </div>
          ))}
        </div>

        <p className="m-0" style={{ fontSize: 12, color: "var(--cds-alias-typography-color-200)", marginTop: 12 }}>
          A peer stays down until the interface carrying its local address is enabled here.
        </p>

        {error && (
          <div className="alert alert-danger alert-sm" style={{ marginTop: 12 }}>
            <Icon shape="exclamation-circle" size={14} className="alert-icon" />
            <span className="alert-text">{error}</span>
          </div>
        )}
      </div>
      <div className="card-footer">
        <Button kind="primary" onClick={apply} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save Interfaces"}
        </Button>
      </div>
    </div>
  );
}
