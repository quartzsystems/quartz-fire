"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { fetchSystemConfig, GeneralSettings } from "@/lib/system";
import { useDashboard } from "@/lib/DashboardContext";
import { GeneralFormModal } from "./GeneralFormModal";

/// One label/value line of the settings card.
function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      className="flex items-start gap-4 py-[9px]"
      style={{ borderBottom: "1px solid var(--cds-alias-object-border-subtle)" }}
    >
      <span
        className="w-[200px] flex-shrink-0 pt-[1px]"
        style={{ fontSize: 12, color: "var(--cds-alias-typography-color-200)" }}
      >
        {label}
      </span>
      <span className="min-w-0" style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>
        {children}
      </span>
    </div>
  );
}

function MonoList({ items }: { items: string[] }) {
  if (items.length === 0) return <span style={{ color: "var(--cds-alias-typography-color-200)" }}>—</span>;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1" style={{ fontFamily: "var(--qz-font-mono)" }}>
      {items.map((v) => (
        <span key={v}>{v}</span>
      ))}
    </span>
  );
}

function MonoValue({ value, fallback }: { value: string | null; fallback: string }) {
  if (value === null) return <span style={{ color: "var(--cds-alias-typography-color-200)" }}>{fallback}</span>;
  return <span style={{ fontFamily: "var(--qz-font-mono)" }}>{value}</span>;
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
      <div>
        <h2>General</h2>
        <p className="clr-secondary" style={{ marginTop: 4 }}>
          Identity, DNS, time, and NTP settings of the firewall itself
        </p>
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
          <div className="card-header">
            System Settings
            <span style={{ marginLeft: "auto" }}>
              <Button kind="secondary" size="sm" icon="pencil" onClick={() => setModal(true)}>
                Edit Settings
              </Button>
            </span>
          </div>
          <div className="card-block" style={{ paddingTop: 4, paddingBottom: 8 }}>
            <InfoRow label="Hostname"><MonoValue value={data.hostname} fallback="vyos (default)" /></InfoRow>
            <InfoRow label="Domain Name"><MonoValue value={data.domain_name} fallback="—" /></InfoRow>
            <InfoRow label="DNS Servers"><MonoList items={data.name_servers} /></InfoRow>
            <InfoRow label="NTP Servers"><MonoList items={data.ntp_servers} /></InfoRow>
            <InfoRow label="Time Zone"><MonoValue value={data.timezone} fallback="UTC (default)" /></InfoRow>
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
