"use client";

// MTU table cell. Shows the configured value plainly; when the running config
// sets no MTU, shows the kind's kernel default (muted, with a tooltip) so the
// column reflects the interface's effective MTU instead of a bare dash.

import { DEFAULT_MTU, InterfaceKind } from "@/lib/interfaces";

export function MtuCell({ mtu, kind }: { mtu: number | null; kind: InterfaceKind }) {
  if (mtu != null) return <>{mtu}</>;
  return (
    <span className="text-[var(--cds-alias-typography-color-200)]" title="Default (not set in config)">
      {DEFAULT_MTU[kind]}
    </span>
  );
}
