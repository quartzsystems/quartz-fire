"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Tabs } from "@/components/ui/Tabs";
import { Column, DataTable, FilterDef } from "@/components/dashboard/DataTable";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import {
  CommitEntry,
  fetchCommitDiff,
  fetchCommitHistory,
  fetchSystemLog,
  rollbackToRevision,
  summarizeCommitDiff,
  SystemLogEntry,
} from "@/lib/audit";
import { useDashboard } from "@/lib/DashboardContext";

// ── per-commit change summaries ───────────────────────────────────────────────
// Summaries are derived from each revision's diff, fetched lazily. Cached by
// date+user (stable identity — revision NUMBERS shift with every new commit)
// and persisted, so a normal visit only fetches the commits it hasn't seen.

const SUMMARY_CACHE_KEY = "qz-audit-summaries";
const SUMMARY_CACHE_MAX = 400;
/** Only this many of the newest commits get summaries fetched. */
const SUMMARY_FETCH_MAX = 50;
/** Diff fetches in flight at once. */
const SUMMARY_BATCH = 4;

const summaryKey = (r: CommitEntry) => `${r.date}|${r.user}`;

function loadSummaryCache(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(SUMMARY_CACHE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

type Tab = "config" | "system";

/// Syslog severity rendered as a pill — the numeric levels mean nothing at a
/// glance.
function PriorityPill({ priority }: { priority: number }) {
  const pill = (tone: string | null, text: string) => (
    <span
      className={`label${tone ? ` label-${tone}` : ""}`}
      style={{
        fontFamily: "var(--qz-font-mono)",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        width: "fit-content",
      }}
    >
      {text}
    </span>
  );
  if (priority <= 3) return pill("danger", "Error");
  if (priority === 4) return pill("warning", "Warning");
  if (priority === 5) return pill("info", "Notice");
  return pill(null, "Info");
}

/// Render a millisecond timestamp as `YYYY-MM-DD HH:MM:SS` in the browser's
/// local time — matching how Config Changes shows commit dates (the CLI's
/// device-local rendering) so both tabs read identically.
function formatCommitStyle(ms: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const d = new Date(ms);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function commitColumns(summaries: Record<string, string>): Column<CommitEntry>[] {
  return [
    { key: "revision", header: "Revision", value: (r) => r.revision, mono: true, sortable: true, width: 90 },
    { key: "date", header: "Date", value: (r) => r.date, mono: true, sortable: true, width: 180 },
    { key: "user", header: "User", value: (r) => r.user, mono: true, sortable: true, width: 120 },
    { key: "via", header: "Via", value: (r) => r.via, mono: true, sortable: true, width: 100 },
    {
      key: "changes",
      header: "Changes",
      value: (r) => summaries[summaryKey(r)] ?? "",
      render: (r) => {
        const s = summaries[summaryKey(r)];
        if (s === undefined) return <span style={{ color: "var(--cds-alias-typography-color-200)" }}>…</span>;
        return s ? s : <span style={{ color: "var(--cds-alias-typography-color-200)" }}>—</span>;
      },
    },
    {
      key: "comment",
      header: "Comment",
      value: (r) => r.comment ?? "",
      render: (r) =>
        r.comment ? r.comment : <span style={{ color: "var(--cds-alias-typography-color-200)" }}>—</span>,
    },
  ];
}

const logColumns: Column<SystemLogEntry>[] = [
  {
    key: "time",
    header: "Date",
    value: (r) => r.ts,
    render: (r) => formatCommitStyle(r.ts),
    mono: true,
    sortable: true,
    width: 170,
  },
  {
    key: "priority",
    header: "Severity",
    value: (r) => r.priority,
    render: (r) => <PriorityPill priority={r.priority} />,
    sortable: true,
    width: 90,
  },
  { key: "unit", header: "Source", value: (r) => r.unit, mono: true, sortable: true, width: 130 },
  { key: "message", header: "Message", value: (r) => r.message, mono: true },
];

const logFilters: FilterDef<SystemLogEntry>[] = [
  {
    key: "severity",
    label: "Severity",
    options: [
      { value: "error", label: "Errors" },
      { value: "warn", label: "Warnings and up" },
    ],
    predicate: (r, v) => (v === "error" ? r.priority <= 3 : r.priority <= 4),
  },
];

/// Modal showing the device's own diff of one commit revision.
function CommitDiffModal({ revision, onClose }: { revision: number; onClose: () => void }) {
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; text: string }>({
    status: "loading",
    text: "",
  });

  useEffect(() => {
    let live = true;
    fetchCommitDiff(revision)
      .then((text) => live && setState({ status: "ready", text }))
      .catch((e) =>
        live && setState({ status: "error", text: e instanceof Error ? e.message : "Failed to load the diff." }),
      );
    return () => {
      live = false;
    };
  }, [revision]);

  return (
    <ModalShell onClose={onClose} maxWidth={720}>
      <ModalHeader
        title={`Commit Revision ${revision}`}
        subtitle="Configuration changes this commit introduced"
        onClose={onClose}
      />
      {state.status === "loading" && <div className="clr-secondary">Loading diff…</div>}
      {state.status === "error" && (
        <div className="alert alert-danger alert-sm">
          <Icon shape="exclamation-circle" size={14} className="alert-icon" />
          <div className="alert-text">{state.text}</div>
        </div>
      )}
      {state.status === "ready" && (
        <pre
          className="m-0 rounded-lg p-3 overflow-auto"
          style={{
            fontFamily: "var(--qz-font-mono)",
            fontSize: 12,
            lineHeight: 1.6,
            background: "var(--cds-alias-object-container-background-shade)",
            border: "1px solid var(--cds-alias-object-border-color-tint)",
            color: "var(--cds-alias-typography-color-400)",
            maxHeight: "60vh",
            whiteSpace: "pre-wrap",
          }}
        >
          {state.text.trim() || "No differences recorded for this revision."}
        </pre>
      )}
    </ModalShell>
  );
}

/// Confirmation dialog for rolling the config back to a previous revision.
/// The rollback itself runs under commit-confirm, so a bad call auto-reverts.
function RollbackModal({
  commit,
  onClose,
  onStarted,
}: {
  commit: CommitEntry;
  onClose: () => void;
  onStarted: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  const run = async () => {
    setWorking(true);
    setError("");
    try {
      await rollbackToRevision(commit.revision);
      onStarted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rollback failed.");
      setWorking(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={480}>
      <ModalHeader
        title={`Roll Back to Revision ${commit.revision}`}
        subtitle={`Configuration as committed ${commit.date} by ${commit.user}`}
        onClose={onClose}
      />
      <div className="flex flex-col gap-4">
        <p className="m-0" style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>
          The entire configuration returns to the state of this revision — every change committed since
          (by the WebUI, CLI, or API) is undone. No reboot is needed.
        </p>
        <p className="m-0" style={{ fontSize: 12, color: "var(--cds-alias-typography-color-200)" }}>
          The rollback applies under commit-confirm: it must be confirmed in the banner within 2 minutes,
          otherwise the current configuration is restored automatically.
        </p>
        {error && (
          <p className="m-0" style={{ fontSize: 12, color: "var(--cds-alias-status-danger)" }}>
            {error}
          </p>
        )}
        <ModalFooter>
          <button type="button" className="btn btn-neutral" onClick={onClose} disabled={working}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" disabled={working} onClick={run}>
            {working ? "Rolling back…" : "Roll Back"}
          </button>
        </ModalFooter>
      </div>
    </ModalShell>
  );
}

export default function AuditLogPage() {
  const { setToast } = useDashboard();
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  // Journal lines carry no unique key of their own (identical messages can
  // land in the same millisecond), so rows get an index id.
  const [log, setLog] = useState<(SystemLogEntry & { id: number })[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [tab, setTab] = useState<Tab>("config");
  const [diffRevision, setDiffRevision] = useState<number | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<CommitEntry | null>(null);

  // ── change summaries (lazy, cached) ──
  const [summaries, setSummaries] = useState<Record<string, string>>(loadSummaryCache);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      let toStore = summaries;
      const keys = Object.keys(toStore);
      if (keys.length > SUMMARY_CACHE_MAX) {
        toStore = Object.fromEntries(keys.slice(-SUMMARY_CACHE_MAX).map((k) => [k, toStore[k]]));
      }
      window.localStorage.setItem(SUMMARY_CACHE_KEY, JSON.stringify(toStore));
    } catch {
      /* ignore quota / serialization errors */
    }
  }, [summaries]);

  // Fetch one small batch of missing summaries per pass; each state update
  // re-runs the effect for the next batch until nothing is missing. Failures
  // cache as "" (rendered "—") so a bad revision can't retry-loop.
  useEffect(() => {
    const missing = commits
      .slice(0, SUMMARY_FETCH_MAX)
      .filter((c) => summaries[summaryKey(c)] === undefined)
      .slice(0, SUMMARY_BATCH);
    if (missing.length === 0) return;
    let live = true;
    Promise.allSettled(
      missing.map(async (c) => [summaryKey(c), summarizeCommitDiff(await fetchCommitDiff(c.revision))] as const),
    ).then((results) => {
      if (!live) return;
      setSummaries((prev) => {
        const next = { ...prev };
        results.forEach((res, i) => {
          next[summaryKey(missing[i])] = res.status === "fulfilled" ? res.value[1] : "";
        });
        return next;
      });
    });
    return () => {
      live = false;
    };
  }, [commits, summaries]);

  const commitCols = useMemo(() => commitColumns(summaries), [summaries]);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      // Either half may fail on its own (e.g. journal unreadable) without
      // taking the other down; fail the page only if both do.
      const [commitsRes, logRes] = await Promise.allSettled([fetchCommitHistory(), fetchSystemLog()]);
      if (commitsRes.status === "rejected" && logRes.status === "rejected") {
        throw commitsRes.reason;
      }
      setCommits(commitsRes.status === "fulfilled" ? commitsRes.value : []);
      setLog(logRes.status === "fulfilled" ? logRes.value.map((e, id) => ({ ...e, id })) : []);
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load the audit log.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const headerBlock = (
    <div>
      <h2 className="m-0">Audit Log</h2>
      <p className="clr-secondary" style={{ marginTop: 4 }}>
        Every configuration commit, and the system journal behind them.
      </p>
    </div>
  );

  const tabStrip = (
    <Tabs
      items={[
        { value: "config", label: "Config Changes", count: commits.length },
        { value: "system", label: "System Log", count: log.length },
      ]}
      value={tab}
      onChange={(v) => setTab(v as Tab)}
    />
  );

  return (
    <div className="flex flex-col gap-3">
      {status !== "ready" && headerBlock}

      {status === "loading" && <div className="clr-secondary">Loading audit log…</div>}
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
      {status === "ready" &&
        (tab === "config" ? (
          <DataTable
            rows={commits}
            columns={commitCols}
            rowId={(r) => String(r.revision)}
            storageKey="system-audit-commits"
            searchPlaceholder="Search…"
            emptyMessage="No commit history recorded on this device."
            onRefresh={() => load("refresh")}
            onRowOpen={(row) => setDiffRevision(row.revision)}
            headerLeft={headerBlock}
            subHeader={tabStrip}
            footerHint="Double-click a commit to see its diff. Drag headers to reorder columns."
            actions={(row) => (
              <span className="inline-flex items-center gap-1 justify-end">
                <button
                  type="button"
                  title={`Show what revision ${row.revision} changed`}
                  aria-label="Show diff"
                  onClick={() => setDiffRevision(row.revision)}
                  className="btn btn-sm btn-link-neutral btn-icon"
                >
                  <Icon shape="file" size={14} />
                </button>
                {/* Revision 0 IS the current config — nothing to roll back to. */}
                {row.revision > 0 && (
                  <button
                    type="button"
                    title={`Roll the configuration back to revision ${row.revision}`}
                    aria-label="Roll back to this revision"
                    onClick={() => setRollbackTarget(row)}
                    className="btn btn-sm btn-link-neutral btn-icon"
                  >
                    <Icon shape="history" size={14} />
                  </button>
                )}
              </span>
            )}
          />
        ) : (
          <DataTable
            rows={log}
            columns={logColumns}
            rowId={(r) => String(r.id)}
            filters={logFilters}
            // v2: reset persisted layouts that seeded from the old
            // stretched-to-fit measurements (unreadably wide columns).
            storageKey="system-audit-log-v2"
            searchPlaceholder="Search…"
            emptyMessage="No system log entries readable on this device."
            onRefresh={() => load("refresh")}
            headerLeft={headerBlock}
            subHeader={tabStrip}
          />
        ))}

      {diffRevision !== null && (
        <CommitDiffModal revision={diffRevision} onClose={() => setDiffRevision(null)} />
      )}

      {rollbackTarget && (
        <RollbackModal
          commit={rollbackTarget}
          onClose={() => setRollbackTarget(null)}
          onStarted={() => {
            setRollbackTarget(null);
            setToast("Rollback applied — confirm it in the banner to keep it.");
            load("refresh");
          }}
        />
      )}
    </div>
  );
}
