"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Icon } from "@/components/ui/Icon";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import {
  confirmPending,
  dismissGuardNotice,
  getGuardState,
  GuardState,
  revertPending,
  subscribeGuard,
  syncPending,
} from "@/lib/guard";

/// Commit-confirm surface, mounted once in the shell's app-level alert slot
/// (above the header, Clarity `alert-app-level` anatomy).
///
/// While a guarded change is awaiting confirmation it shows the countdown
/// with Confirm / Revert actions; when the anti-lockout check refuses a
/// change it shows the override dialog; after an auto-revert it tells the
/// user their change was undone (the page's data is stale at that point,
/// hence the Reload action).
export function CommitGuard() {
  const state = useSyncExternalStore<GuardState>(subscribeGuard, getGuardState, getGuardState);

  // Pick up a pending change that survived a full page reload (or was armed
  // by another tab).
  useEffect(() => {
    void syncPending();
  }, []);

  if (state.phase === "idle") return null;
  if (state.phase === "lockout") return <LockoutDialog reasons={state.reasons} resolve={state.resolve} />;

  if (state.phase === "pending") return <PendingBanner state={state} />;

  if (state.phase === "reverted") {
    return (
      <div className="alert alert-danger alert-app-level">
        <Icon shape="history" size={16} className="alert-icon" />
        <div className="alert-text">
          <strong>{state.description}</strong> was not confirmed and has been reverted — the previous
          configuration is back in effect. What you see may be stale until you reload.
        </div>
        <div className="alert-actions">
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Reload View
          </button>
          <button type="button" className="btn" onClick={dismissGuardNotice}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  // revert_failed — the loudest state we have: an unconfirmed change is live
  // and could not be undone (or a confirmed one could not be persisted).
  return (
    <div className="alert alert-danger alert-app-level">
      <Icon shape="exclamation-triangle" size={16} className="alert-icon" />
      <div className="alert-text">
        <strong>{state.description}:</strong> {state.error}
      </div>
      <div className="alert-actions">
        <button type="button" className="btn" onClick={dismissGuardNotice}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

function PendingBanner({ state }: { state: Extract<GuardState, { phase: "pending" }> }) {
  const { pending, busy, error } = state;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  const remaining = Math.max(0, Math.ceil((pending.expiresAt - now) / 1000));

  return (
    <div style={{ position: "relative" }}>
      <div className="alert alert-warning alert-app-level">
        <Icon shape="shield-x" size={16} className="alert-icon" />
        <div className="alert-text">
          <strong>{pending.description}</strong> is live —{" "}
          {remaining > 0 ? (
            <>
              confirm it within{" "}
              <span
                style={{
                  fontFamily: "var(--qz-font-mono)",
                  fontWeight: 700,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {remaining}s
              </span>{" "}
              or it will be automatically reverted.
            </>
          ) : (
            <>checking whether it was reverted…</>
          )}
          {error && <span style={{ fontWeight: 600 }}> {error}</span>}
        </div>
        <div className="alert-actions">
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => void confirmPending()}
          >
            {busy === "confirm" ? "Confirming…" : "Confirm Change"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => void revertPending()}
          >
            {busy === "revert" ? "Reverting…" : "Revert Now"}
          </button>
        </div>
      </div>
      {/* Countdown bar along the banner's bottom edge makes the deadline
          legible at a glance. */}
      <div
        style={{
          position: "absolute",
          left: 0,
          bottom: 0,
          height: 3,
          width: `${Math.min(100, (remaining / pending.timeoutSecs) * 100)}%`,
          background: "rgba(0,0,0,0.35)",
          transition: "width 250ms linear",
        }}
      />
    </div>
  );
}

/// The anti-lockout check refused a change that would sever this session —
/// make the user read why before letting them push it through anyway (the
/// override still runs under commit-confirm, so even a wrong call reverts).
function LockoutDialog({ reasons, resolve }: { reasons: string[]; resolve: (proceed: boolean) => void }) {
  return (
    <ModalShell onClose={() => resolve(false)} maxWidth={520}>
      <ModalHeader
        title="This Change Would Lock You Out"
        subtitle="The anti-lockout guard refused to apply it"
        onClose={() => resolve(false)}
      />
      <div className="flex flex-col gap-4">
        <ul className="list" style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <p className="clr-caption">
          If you apply it anyway it still runs under commit-confirm: unless you confirm it from a
          session that survives the change, the previous configuration is restored automatically.
        </p>
      </div>
      <ModalFooter>
        <button type="button" className="btn btn-neutral" onClick={() => resolve(false)}>
          Cancel
        </button>
        <button type="button" className="btn btn-danger" onClick={() => resolve(true)}>
          Apply Anyway
        </button>
      </ModalFooter>
    </ModalShell>
  );
}
