"use client";

import { useEffect, useMemo, useState } from "react";
import { PieChart } from "lucide-react";
import { AcStatus, fetchAcStatus } from "@/lib/appcontrol";
import { AppSliceInput, TopAppsDonut } from "./TopAppsDonut";
import { LiveButton } from "./LiveButton";

const POLL_MS = 5_000;

export function TopApplicationsTile() {
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState<AcStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (paused) return;
    let alive = true;
    const load = async () => {
      try {
        const s = await fetchAcStatus();
        if (!alive) return;
        setStatus(s);
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "failed to load");
      }
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [paused]);

  const runtime = status?.status ?? null;
  const running = status?.running ?? false;

  const { apps, totalBytes } = useMemo(() => {
    const apps: AppSliceInput[] = (runtime?.top_apps ?? [])
      .filter((a) => a.bytes > 0)
      .map((a) => ({ id: a.app_id, name: a.app, bytes: a.bytes, flows: a.flows }));
    const total = runtime?.total_app_bytes ?? apps.reduce((n, a) => n + a.bytes, 0);
    return { apps, totalBytes: total };
  }, [runtime]);

  const empty = !running
    ? "Application Control is not running."
    : apps.length === 0 || totalBytes <= 0
      ? "No classified traffic yet."
      : null;

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between gap-2 mb-3 flex-shrink-0">
        <div className="flex items-center gap-[9px] min-w-0">
          <PieChart size={18} className="text-[var(--qz-accent)]" />
          <h2 className="text-[16px] font-bold text-[var(--qz-fg-1)] m-0 truncate" style={{ letterSpacing: "-0.01em" }}>
            Top Applications
          </h2>
          <span className="text-[11px] text-[var(--qz-fg-4)] flex-shrink-0">by classified bytes</span>
        </div>
        <LiveButton paused={paused} onToggle={() => setPaused((p) => !p)} />
      </div>

      {error && !status && <div className="text-[13px] text-[var(--qz-danger)] mb-2">{error}</div>}

      {empty ? (
        <div className="flex-1 grid place-items-center text-[12px] text-[var(--qz-fg-4)]">{empty}</div>
      ) : (
        // Stretch the donut to the tile's full remaining height (the donut
        // scales to its box); without this it collapses to its min size.
        <div className="flex-1 min-h-0 flex flex-col [&>*]:flex-1 [&>*]:min-h-0">
          <TopAppsDonut apps={apps} totalBytes={totalBytes} />
        </div>
      )}
    </div>
  );
}
