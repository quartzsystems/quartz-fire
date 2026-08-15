"use client";

import { Icon } from "@/components/ui/Icon";

/// Placeholder — High Availability is not implemented yet. The nav entry and
/// route exist so the section is reachable; the body is intentionally an empty
/// state until Config Sync / VRRP land.
export default function HighAvailabilityPage() {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2>High Availability</h2>
        <p className="clr-secondary" style={{ marginTop: 4 }}>
          Keep a standby firewall in lockstep — configuration sync and VRRP failover
        </p>
      </div>

      <div className="card">
        <div className="card-block flex flex-col items-center justify-center gap-3 py-16 text-center">
          <Icon shape="cluster" size={28} style={{ color: "var(--cds-alias-typography-color-200)" }} />
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--cds-alias-typography-color-400)" }}>Coming soon</div>
          <p className="clr-secondary max-w-[420px] m-0">
            High Availability isn&apos;t available yet. Use Config Sync and VRRP under this
            section as they come online.
          </p>
        </div>
      </div>
    </div>
  );
}
