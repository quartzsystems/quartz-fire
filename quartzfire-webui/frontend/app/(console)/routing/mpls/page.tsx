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

  const tabs: [Section, string][] = [
    ["config", "Global"],
    ["status", "Status"],
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h2 style={{ margin: 0 }}>MPLS</h2>
        <p className="clr-secondary" style={{ marginTop: 4 }}>
          Multiprotocol Label Switching — label forwarding and the LDP control plane.
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
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
          <div className="flex flex-col gap-5">
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
          </div>
        )}
      </div>
    </div>
  );
}
