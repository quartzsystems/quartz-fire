"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { Tabs } from "@/components/ui/Tabs";
import { MplsConfig, fetchMpls } from "@/lib/mpls";
import { useDashboard } from "@/lib/DashboardContext";
import { MplsConfigPanel } from "./MplsConfigPanel";
import { MplsStatusPanel } from "./MplsStatusPanel";

type Section = "config" | "status";

export default function MplsPage() {
  const { setToast } = useDashboard();
  const [cfg, setCfg] = useState<MplsConfig | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [section, setSection] = useState<Section>("config");
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      setCfg(await fetchMpls());
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load MPLS configuration.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await load("refresh");
    } finally {
      setRefreshing(false);
    }
  };

  const tabs: [Section, string][] = [
    ["config", "Global"],
    ["status", "Status"],
  ];

  return (
    <div className="flex flex-col" style={{ gap: 12 }}>
      <div className="flex items-start gap-2">
        <div className="mr-auto">
          <h2 className="m-0">MPLS</h2>
          <p className="clr-secondary" style={{ marginTop: 4 }}>
            Multiprotocol Label Switching — label forwarding and the LDP control plane.
          </p>
        </div>
        {status === "ready" && (
          <Button kind="outline" onClick={refresh} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        )}
      </div>

      {status === "loading" && <div className="clr-secondary">Loading MPLS configuration…</div>}
      {status === "error" && (
        <div className="flex flex-col gap-3">
          <div className="alert alert-danger alert-sm">
            <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
            <div className="alert-text">{errorMsg}</div>
          </div>
          <div>
            <Button kind="secondary" icon="refresh" onClick={() => load()}>Retry</Button>
          </div>
        </div>
      )}
      {status === "ready" && cfg && (
        <>
          <Tabs
            items={tabs.map(([id, label]) => ({ value: id, label }))}
            value={section}
            onChange={(v) => setSection(v as Section)}
          />

          {section === "config" && (
            <MplsConfigPanel
              live={cfg}
              onSaved={(msg) => {
                setToast(msg);
                load("refresh");
              }}
            />
          )}
          {section === "status" && <MplsStatusPanel />}
        </>
      )}
    </div>
  );
}
