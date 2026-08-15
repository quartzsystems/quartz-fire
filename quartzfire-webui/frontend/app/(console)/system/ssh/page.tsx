"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { fetchSystemConfig, SshSettings, SystemUser } from "@/lib/system";
import { useDashboard } from "@/lib/DashboardContext";
import { SshFormModal } from "./SshFormModal";

/// Definition-grid label cell (DC: sentence case, color-200).
function DefLabel({ children }: { children: React.ReactNode }) {
  return <span style={{ color: "var(--cds-alias-typography-color-200)" }}>{children}</span>;
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

/// Multi-value cell — mono, values joined with " · " per the DC reference.
function MonoList({ items, fallback }: { items: string[]; fallback: string }) {
  if (items.length === 0)
    return <span style={{ color: "var(--cds-alias-typography-color-200)" }}>{fallback}</span>;
  return (
    <span style={{ fontFamily: "var(--qz-font-mono)", color: "var(--cds-alias-typography-color-400)" }}>
      {items.join(" · ")}
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
        <div className="flex flex-col gap-3">
          <div className="card" style={{ maxWidth: 720 }}>
            <div className="card-header">SSH Service</div>
            <div
              className="card-block"
              style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: "10px 24px", fontSize: 13 }}
            >
              <DefLabel>Service</DefLabel>
              <span>{ssh.enabled ? <Pill tone="success">Enabled</Pill> : <Pill>Disabled</Pill>}</span>
              <DefLabel>Ports</DefLabel>
              <MonoList items={ssh.ports} fallback="22 (default)" />
              <DefLabel>Listen addresses</DefLabel>
              <MonoList items={ssh.listen_addresses} fallback="All addresses" />
              <DefLabel>Password authentication</DefLabel>
              <span>
                {ssh.password_auth_disabled ? (
                  <Pill tone="warning">Disabled — keys only</Pill>
                ) : (
                  <Pill tone="success">Allowed</Pill>
                )}
              </span>
            </div>
          </div>

          <div className="card" style={{ maxWidth: 720 }}>
            <div className="card-header">
              Authorized Keys
              <span style={{ marginLeft: "auto" }}>
                <Link href="/system/users" style={{ fontSize: 12, fontWeight: 400 }}>
                  Manage on the Users page →
                </Link>
              </span>
            </div>
            <div
              className="card-block"
              style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: "10px 24px", fontSize: 13 }}
            >
              {usersWithKeys.length === 0 ? (
                <p className="clr-secondary m-0" style={{ gridColumn: "1 / -1" }}>
                  No account has SSH public keys yet. Keys are managed per user account.
                </p>
              ) : (
                usersWithKeys.map((u) => (
                  <Fragment key={u.name}>
                    <DefLabel>{u.name}</DefLabel>
                    <span style={{ fontFamily: "var(--qz-font-mono)", color: "var(--cds-alias-typography-color-400)" }}>
                      {/* DC shows the short algorithm name: "cw-macbook (ed25519)". */}
                      {u.keys.map((k) => `${k.id} (${(k.type ?? "?").replace(/^ssh-/, "")})`).join(" · ")}
                    </span>
                  </Fragment>
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
