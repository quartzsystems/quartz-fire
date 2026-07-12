"use client";

import { HeartPulse } from "lucide-react";

/// Placeholder — High Availability is not implemented yet. The nav entry and
/// route exist so the section is reachable; the body is intentionally an empty
/// state until Config Sync / VRRP land.
export default function HighAvailabilityPage() {
  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          High Availability
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Keep a standby firewall in lockstep — configuration sync and VRRP failover
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        <div
          className="flex flex-col items-center justify-center gap-3 rounded-lg py-16 text-center"
          style={{ background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" }}
        >
          <HeartPulse size={28} className="text-[var(--qz-fg-4)]" />
          <div className="text-[15px] font-semibold text-[var(--qz-fg-2)]">Coming soon</div>
          <p className="text-[13px] text-[var(--qz-fg-4)] max-w-[420px] m-0">
            High Availability isn&apos;t available yet. Use Config Sync and VRRP under this
            section as they come online.
          </p>
        </div>
      </div>
    </div>
  );
}
