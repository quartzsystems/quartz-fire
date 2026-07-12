"use client";

import { FolderSync } from "lucide-react";

/// Placeholder — HA Config Sync is not implemented yet. Route exists so the nav
/// entry is reachable; body is an intentional empty state until the feature lands.
export default function ConfigSyncPage() {
  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          Config Sync
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Replicate configuration from the primary to the standby firewall
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        <div
          className="flex flex-col items-center justify-center gap-3 rounded-lg py-16 text-center"
          style={{ background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" }}
        >
          <FolderSync size={28} className="text-[var(--qz-fg-4)]" />
          <div className="text-[15px] font-semibold text-[var(--qz-fg-2)]">Coming soon</div>
          <p className="text-[13px] text-[var(--qz-fg-4)] max-w-[420px] m-0">
            Config Sync isn&apos;t available yet. This section is reserved for it.
          </p>
        </div>
      </div>
    </div>
  );
}
