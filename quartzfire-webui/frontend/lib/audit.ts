// Audit data layer: the device's commit history (every configuration change,
// whoever made it — WebUI, CLI, or API) and the system journal (the firewall
// OS's own logs). Traffic logs are deliberately excluded — they live on the
// Traffic Monitor page.

import { apiFetch, vyosApi } from "./api";
import { type PendingWire, registerPending } from "./guard";
import type { VyosResponse } from "./interfaces";

/// One configuration commit, from `show system commit`. Revision 0 is the
/// most recent commit.
export interface CommitEntry {
  revision: number;
  /** Device-local commit time, as the CLI renders it. */
  date: string;
  user: string;
  /** How the commit was made: cli, api, init, … */
  via: string;
  comment: string | null;
}

/// One system journal entry, from the backend's journalctl reader.
export interface SystemLogEntry {
  /** Milliseconds since the epoch. */
  ts: number;
  unit: string;
  /** Syslog priority 0–7, lower = more severe. */
  priority: number;
  message: string;
}

/// Parse `show system commit` output. Each revision renders as
/// `0   2026-07-09 12:34:56 by vyos via api`; a commit comment follows on its
/// own indented line.
export function parseCommitHistory(text: string): CommitEntry[] {
  const out: CommitEntry[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+by\s+(\S+)(?:\s+via\s+(\S+))?/.exec(line);
    if (m) {
      out.push({
        revision: Number(m[1]),
        date: m[2].replace(/\s+/g, " "),
        user: m[3],
        via: m[4] ?? "",
        comment: null,
      });
    } else if (out.length > 0 && line.trim() && !/^Revisions/i.test(line.trim())) {
      // Continuation line — the previous revision's commit comment.
      const last = out[out.length - 1];
      last.comment = last.comment ? `${last.comment} ${line.trim()}` : line.trim();
    }
  }
  return out;
}

/// Commit history, newest first (revision 0 = latest).
export async function fetchCommitHistory(): Promise<CommitEntry[]> {
  const resp = await vyosApi<VyosResponse<string | null>>("show", {
    op: "show",
    path: ["system", "commit"],
  });
  if (!resp.success) {
    throw new Error(resp.error || "Device returned an error reading the commit history.");
  }
  return parseCommitHistory(resp.data ?? "");
}

/// Compress a commit diff into a one-line summary of which top-level config
/// sections changed and by how many lines, e.g. `firewall +4 −1 · nat +2`.
/// Handles both diff shapes VyOS produces: `[edit path]` headers with +/-
/// lines, and a config tree with +/- markers on changed lines. Returns "" when
/// the diff records no changes (also: the oldest retained revision).
export function summarizeCommitDiff(diff: string): string {
  const counts = new Map<string, { add: number; del: number }>();
  let section = "";
  let depth = 0;
  const bump = (name: string, add: boolean) => {
    const key = name || "(top level)";
    const c = counts.get(key) ?? { add: 0, del: 0 };
    if (add) c.add++;
    else c.del++;
    counts.set(key, c);
  };
  for (const raw of diff.split("\n")) {
    const t = raw.trim();
    if (!t) continue;
    const edit = /^\[edit(?:\s+(\S+))?/.exec(t);
    if (edit) {
      section = edit[1] ?? "(top level)";
      depth = 1;
      continue;
    }
    const marked = t.startsWith("+") || t.startsWith("-");
    const body = marked ? t.slice(1).trim() : t;
    // Skip pure brace lines — a fully-added subtree marks its `}` lines too,
    // and counting them would inflate the numbers.
    if (marked && body && body !== "{" && body !== "}") {
      bump(depth === 0 ? body.split(/\s+/)[0] : section, t.startsWith("+"));
    }
    for (const ch of body) {
      if (ch === "{") {
        if (depth === 0) section = body.split(/\s+/)[0] ?? section;
        depth++;
      } else if (ch === "}") {
        depth = Math.max(0, depth - 1);
      }
    }
  }
  const parts = [...counts.entries()].sort(
    (a, b) => b[1].add + b[1].del - (a[1].add + a[1].del),
  );
  if (parts.length === 0) return "";
  const fmt = ([name, c]: (typeof parts)[number]) =>
    [name, c.add ? `+${c.add}` : "", c.del ? `−${c.del}` : ""].filter(Boolean).join(" ");
  const shown = parts.slice(0, 3).map(fmt);
  const extra = parts.length - 3;
  return shown.join(" · ") + (extra > 0 ? ` · +${extra} more` : "");
}

/// What one commit changed, as the device's own diff text (empty when the
/// device can no longer produce it, e.g. the oldest retained revision).
export async function fetchCommitDiff(revision: number): Promise<string> {
  const resp = await vyosApi<VyosResponse<string | null>>("show", {
    op: "show",
    path: ["system", "commit", "diff", String(revision)],
  });
  if (!resp.success) {
    throw new Error(resp.error || `Device returned an error diffing revision ${revision}.`);
  }
  return resp.data ?? "";
}

/// Recent system journal entries, newest first, traffic lines excluded.
export function fetchSystemLog(): Promise<SystemLogEntry[]> {
  return apiFetch<SystemLogEntry[]>("/monitor/system-log");
}

/// Return to the configuration of a previous commit revision. No reboot
/// (unlike the CLI's `rollback`): the backend loads and commits that
/// revision's config under commit-confirm, so the shell banner asks for
/// confirmation and auto-reverts if none arrives — rolling back a rollback
/// that cut the session off.
export async function rollbackToRevision(revision: number): Promise<void> {
  const wire = await apiFetch<PendingWire>("/config/rollback", {
    method: "POST",
    body: JSON.stringify({ revision, timeout_secs: 120 }),
  });
  registerPending(wire);
}
