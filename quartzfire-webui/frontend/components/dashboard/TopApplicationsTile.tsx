"use client";

import { useEffect, useMemo, useState } from "react";
import { AcStatus, fetchAcStatus } from "@/lib/appcontrol";
import { AppSliceInput, TopAppsDonut } from "./TopAppsDonut";

const POLL_MS = 5_000;

export function TopApplicationsTile() {
  const [status, setStatus] = useState<AcStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
  }, []);

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
    <>
      <div className="card-header flex-shrink-0">
        Top Applications
        <span
          className="ml-auto text-[12px] flex-shrink-0"
          style={{ fontWeight: 400, color: "var(--cds-alias-typography-color-200)" }}
        >
          by classified bytes
        </span>
      </div>

      <div className="card-block flex-1 min-h-0 flex flex-col">
        {error && !status && (
          <div className="text-[13px] mb-2" style={{ color: "var(--cds-alias-status-danger)" }}>
            {error}
          </div>
        )}

        {empty ? (
          <div className="flex-1 grid place-items-center text-[12px] text-[var(--cds-alias-typography-color-200)]">
            {empty}
          </div>
        ) : (
          // Stretch the donut + legend to the tile's full remaining space: the
          // donut fills the height as a square pinned left, the legend hugs the
          // card's right edge (see TopAppsDonut `fill`).
          <div className="flex-1 min-h-0 flex flex-col [&>*]:flex-1 [&>*]:min-h-0">
            <TopAppsDonut apps={apps} totalBytes={totalBytes} fill />
          </div>
        )}
      </div>
    </>
  );
}
