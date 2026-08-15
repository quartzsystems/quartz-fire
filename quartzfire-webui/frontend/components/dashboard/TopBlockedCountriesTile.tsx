"use client";

// Top Blocked Countries — ranks the countries with the most traffic dropped by
// block-listed geolocation actions. Data comes from the per-country geoc_<cc>
// nftables counters the qzgeo helpers dump to /run/quartzfire-geoip
// (status.counters.countries); country names come from the libloc dump.

import { useEffect, useMemo, useState } from "react";
import { formatBytes } from "@/lib/format";
import {
  countryName,
  fetchGeoCountries,
  fetchGeoStatus,
  GeoCountry,
  GeoStatus,
} from "@/lib/geolocation";

const POLL_MS = 5_000;
const MAX_ROWS = 8;

interface Row {
  code: string;
  name: string;
  packets: number;
  bytes: number;
}

export function TopBlockedCountriesTile() {
  const [status, setStatus] = useState<GeoStatus | null>(null);
  const [countries, setCountries] = useState<GeoCountry[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Country names change rarely — fetch once (best-effort; falls back to codes).
  useEffect(() => {
    fetchGeoCountries()
      .then((c) => setCountries(c.countries))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const s = await fetchGeoStatus();
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

  const rows = useMemo<Row[]>(() => {
    const counts = status?.counters?.countries ?? {};
    return Object.entries(counts)
      .map(([code, c]) => ({ code, name: countryName(countries, code), packets: c.packets, bytes: c.bytes }))
      .filter((r) => r.packets > 0)
      .sort((a, b) => b.packets - a.packets || a.code.localeCompare(b.code))
      .slice(0, MAX_ROWS);
  }, [status, countries]);

  const max = rows.length ? rows[0].packets : 0;
  const enforcing = status?.status?.active ?? false;

  const empty =
    rows.length === 0
      ? enforcing
        ? "No country blocks recorded yet."
        : "No block-listed geolocation policy is enforcing."
      : null;

  return (
    <>
      <div className="card-header flex-shrink-0">
        Top Blocked Countries
        <span
          className="ml-auto text-[12px] flex-shrink-0"
          style={{ fontWeight: 400, color: "var(--cds-alias-typography-color-200)" }}
        >
          by dropped packets
        </span>
      </div>

      <div className="card-block flex-1 min-h-0 flex flex-col">
        {error && !status && (
          <div className="text-[13px] mb-2" style={{ color: "var(--cds-alias-status-danger)" }}>
            {error}
          </div>
        )}

        {empty ? (
          <div className="flex-1 grid place-items-center text-[12px] text-[var(--cds-alias-typography-color-200)] text-center px-4">
            {empty}
          </div>
        ) : (
          <div className="flex-1 flex flex-col gap-[10px] overflow-y-auto">
            {rows.map((r) => (
              <div key={r.code} className="flex flex-col gap-[4px]">
                <div className="flex items-baseline gap-2 text-[12px]">
                  <span
                    className="flex-shrink-0 text-[11px] text-[var(--cds-alias-typography-color-200)]"
                    style={{ fontFamily: "var(--qz-font-mono)", width: 24 }}
                  >
                    {r.code.toUpperCase()}
                  </span>
                  <span className="text-[var(--cds-alias-typography-color-400)] truncate flex-1" title={r.name}>
                    {r.name}
                  </span>
                  <span
                    className="text-[var(--cds-alias-typography-color-450)] font-semibold flex-shrink-0"
                    style={{ fontFamily: "var(--qz-font-mono)" }}
                    title={`${r.packets.toLocaleString()} packets · ${formatBytes(r.bytes)}`}
                  >
                    {r.packets.toLocaleString()}
                  </span>
                  <span
                    className="text-[var(--cds-alias-typography-color-200)] flex-shrink-0 w-[64px] text-right"
                    style={{ fontFamily: "var(--qz-font-mono)" }}
                  >
                    {formatBytes(r.bytes)}
                  </span>
                </div>
                {/* blocked = danger, so the ranked bars stay red */}
                <div
                  className="h-[4px] rounded-full overflow-hidden"
                  style={{ background: "var(--cds-alias-object-container-background-shade)" }}
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${max > 0 ? Math.max(3, (r.packets / max) * 100) : 0}%`,
                      background: "var(--cds-alias-status-danger)",
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
