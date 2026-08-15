"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
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
      <div className="card-block flex flex-col gap-4">
        <p className="text-[13px] m-0" style={{ color: "var(--cds-alias-typography-color-300)" }}>
          Select the interfaces IKE/IPsec should listen on. A peer stays down until the interface carrying its local address is enabled here.
        </p>

        {names.length === 0 && <p className="text-[13px] m-0" style={{ color: "var(--cds-alias-typography-color-200)" }}>No interfaces available.</p>}

        <div className="flex flex-col" style={{ border: "1px solid var(--cds-alias-object-border-subtle)", borderRadius: 4 }}>
          {names.map((name, i) => (
            <label key={name} className="flex items-center justify-between px-3 py-[10px] cursor-pointer select-none" style={{ borderTop: i === 0 ? undefined : "1px solid var(--cds-alias-object-border-subtle)" }}>
              <span className="text-[13px]" style={{ color: "var(--cds-alias-typography-color-450)", fontFamily: "var(--qz-font-mono)" }}>{name}</span>
              <Switch on={selected.has(name)} onChange={(v) => toggle(name, v)} />
            </label>
          ))}
        </div>

        {error && <p className="text-[12px] m-0" style={{ color: "var(--cds-alias-status-danger)" }}>{error}</p>}
      </div>
      <div className="card-footer">
        <Button kind="primary" size="sm" onClick={apply} disabled={saving || !dirty}>
          {saving ? "Applying…" : "Apply"}
        </Button>
      </div>
    </div>
  );
}
