"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { fetchSystemConfig, SshSettings, SystemUser } from "@/lib/system";
import { useDashboard } from "@/lib/DashboardContext";
import { SshFormModal } from "./SshFormModal";

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

/// Clarity status pill — mono uppercase label.
function Pill({ tone, children }: { tone?: "success" | "warning"; children: React.ReactNode }) {
  return (
    <span
      className={`label${tone ? ` label-${tone}` : ""}`}
      style={{
        fontFamily: "var(--qz-font-mono)",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        width: "fit-content",
      }}
    >
      {children}
    </span>
  );
}

function MonoList({ items, fallback }: { items: string[]; fallback: string }) {
  if (items.length === 0)
    return <span style={{ color: "var(--cds-alias-typography-color-200)" }}>{fallback}</span>;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1" style={{ fontFamily: "var(--qz-font-mono)" }}>
      {items.map((v) => (
        <span key={v}>{v}</span>
      ))}
    </span>
  );
}

export default function SshPage() {
  const { setToast } = useDashboard();
  const [ssh, setSsh] = useState<SshSettings | null>(null);
  const [users, setUsers] = useState<SystemUser[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [modal, setModal] = useState(false);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      const cfg = await fetchSystemConfig();
      setSsh(cfg.ssh);
      setUsers(cfg.users);
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load SSH settings.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const usersWithKeys = users.filter((u) => u.keys.length > 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <div className="mr-auto">
          <h2 className="m-0">SSH</h2>
          <p className="clr-secondary" style={{ marginTop: 4 }}>
            Remote console access to the firewall (sshd).
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setModal(true)}
          disabled={status !== "ready" || !ssh}
        >
          Edit Settings
        </button>
      </div>

      {status === "loading" && <div className="clr-secondary">Loading SSH settings…</div>}
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
      {status === "ready" && ssh && (
        <div className="flex flex-col gap-4">
          <div className="card" style={{ maxWidth: 720 }}>
            <div className="card-header">SSH Service</div>
            <div className="card-block" style={{ paddingTop: 4, paddingBottom: 8 }}>
              <InfoRow label="Service">
                {ssh.enabled ? <Pill tone="success">Enabled</Pill> : <Pill>Disabled</Pill>}
              </InfoRow>
              <InfoRow label="Ports"><MonoList items={ssh.ports} fallback="22 (default)" /></InfoRow>
              <InfoRow label="Listen addresses"><MonoList items={ssh.listen_addresses} fallback="All addresses" /></InfoRow>
              <InfoRow label="Password authentication">
                {ssh.password_auth_disabled ? (
                  <Pill tone="warning">Disabled (keys only)</Pill>
                ) : (
                  <Pill tone="success">Allowed</Pill>
                )}
              </InfoRow>
            </div>
          </div>

          <div className="card" style={{ maxWidth: 720 }}>
            <div className="card-header">
              Authorized Keys
              <span style={{ marginLeft: "auto" }}>
                <Link href="/system/users" className="btn btn-sm btn-link">
                  Manage on the Users page →
                </Link>
              </span>
            </div>
            <div className="card-block" style={{ paddingTop: 4, paddingBottom: 8 }}>
              {usersWithKeys.length === 0 ? (
                <p className="clr-secondary py-2" style={{ margin: 0 }}>
                  No account has SSH public keys yet. Keys are managed per user account.
                </p>
              ) : (
                usersWithKeys.map((u) => (
                  <InfoRow key={u.name} label={u.name}>
                    <span className="flex flex-wrap gap-x-3 gap-y-1" style={{ fontFamily: "var(--qz-font-mono)" }}>
                      {u.keys.map((k) => (
                        <span key={k.id}>
                          {k.id}
                          <span style={{ color: "var(--cds-alias-typography-color-200)" }}> ({k.type ?? "?"})</span>
                        </span>
                      ))}
                    </span>
                  </InfoRow>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {modal && ssh && (
        <SshFormModal
          live={ssh}
          keylessUsers={users.filter((u) => u.keys.length === 0).map((u) => u.name)}
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
