"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { fetchSystemConfig, GeneralSettings } from "@/lib/system";
import { useDashboard } from "@/lib/DashboardContext";
import { GeneralFormModal } from "./GeneralFormModal";

/// Definition-grid label cell (DC: sentence case, color-200).
function DefLabel({ children }: { children: React.ReactNode }) {
  return <span style={{ color: "var(--cds-alias-typography-color-200)" }}>{children}</span>;
}

/// Multi-value cell — mono, values joined with " · " per the DC reference.
function MonoList({ items }: { items: string[] }) {
  if (items.length === 0) return <span style={{ color: "var(--cds-alias-typography-color-200)" }}>—</span>;
  return (
    <span style={{ fontFamily: "var(--qz-font-mono)", color: "var(--cds-alias-typography-color-400)" }}>
      {items.join(" · ")}
    </span>
  );
}

function MonoValue({ value, fallback }: { value: string | null; fallback: string }) {
  if (value === null) return <span style={{ color: "var(--cds-alias-typography-color-200)" }}>{fallback}</span>;
  return (
    <span style={{ fontFamily: "var(--qz-font-mono)", color: "var(--cds-alias-typography-color-400)" }}>
      {value}
    </span>
  );
}

export default function GeneralSettingsPage() {
  const { setToast } = useDashboard();
  const [data, setData] = useState<GeneralSettings | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [modal, setModal] = useState(false);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      setData((await fetchSystemConfig()).general);
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load system settings.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <div className="mr-auto">
          <h2 className="m-0">General</h2>
          <p className="clr-secondary" style={{ marginTop: 4 }}>
            Identity, DNS, time, and NTP settings of the firewall itself.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setModal(true)}
          disabled={status !== "ready" || !data}
        >
          Edit Settings
        </button>
      </div>

      {status === "loading" && <div className="clr-secondary">Loading system settings…</div>}
      {status === "error" && (
        <div className="alert alert-danger alert-sm">
          <Icon shape="exclamation-circle" size={14} className="alert-icon" />
          <div className="alert-text">{errorMsg}</div>
          <div className="alert-actions">
            <button type="button" className="alert-action" onClick={() => load()}>
              Retry
            </button>
          </div>
        </div>
      )}
      {status === "ready" && data && (
        <div className="card" style={{ maxWidth: 720 }}>
          <div className="card-header">System Settings</div>
          <div
            className="card-block"
            style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: "10px 24px", fontSize: 13 }}
          >
            <DefLabel>Hostname</DefLabel>
            <MonoValue value={data.hostname} fallback="vyos (default)" />
            <DefLabel>Domain name</DefLabel>
            <MonoValue value={data.domain_name} fallback="—" />
            <DefLabel>DNS servers</DefLabel>
            <MonoList items={data.name_servers} />
            <DefLabel>NTP servers</DefLabel>
            <MonoList items={data.ntp_servers} />
            <DefLabel>Time zone</DefLabel>
            <MonoValue value={data.timezone} fallback="UTC (default)" />
          </div>
        </div>
      )}

      {modal && data && (
        <GeneralFormModal
          live={data}
          onClose={() => setModal(false)}
          onSaved={(msg) => {
            setModal(false);
            setToast(msg);
            load("refresh");
          }}
        />
      )}
    </div>
  );
}
