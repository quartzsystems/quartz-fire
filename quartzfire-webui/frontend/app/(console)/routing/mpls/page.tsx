"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
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
    ["config", "Configuration"],
    ["status", "Status"],
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          MPLS
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Multiprotocol Label Switching — label forwarding and the LDP control plane
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && <div className="text-[13px] text-[var(--qz-fg-4)]">Loading MPLS configuration…</div>}
        {status === "error" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-[13px] text-[var(--qz-danger)]">
              <AlertTriangle size={15} />
              {errorMsg}
            </div>
            <div>
              <Button kind="secondary" icon={RotateCw} onClick={() => load()}>Retry</Button>
            </div>
          </div>
        )}
        {status === "ready" && cfg && (
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-1 border-b border-[var(--qz-border)]">
              {tabs.map(([id, label]) => {
                const active = section === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setSection(id)}
                    className={[
                      "px-3 py-2 text-[13px] font-medium border-b-2 -mb-px transition-colors cursor-pointer",
                      active ? "text-[var(--qz-accent)] border-[var(--qz-accent)]" : "text-[var(--qz-fg-3)] border-transparent hover:text-[var(--qz-fg-1)]",
                    ].join(" ")}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

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
