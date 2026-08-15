"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { RowActions } from "@/components/dashboard/RowActions";
import { getCurrentUser } from "@/lib/api";
import { deleteUser, fetchSystemConfig, SystemUser } from "@/lib/system";
import { useDashboard } from "@/lib/DashboardContext";
import { UserFormModal } from "./UserFormModal";

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

const columns: Column<SystemUser>[] = [
  { key: "name", header: "Username", value: (r) => r.name, mono: true, sortable: true, width: 160 },
  {
    key: "full_name",
    header: "Full Name",
    value: (r) => r.full_name ?? "",
    render: (r) =>
      r.full_name ? r.full_name : <span style={{ color: "var(--cds-alias-typography-color-200)" }}>—</span>,
  },
  {
    key: "auth",
    header: "Authentication",
    value: (r) => (r.has_password ? "password" : "keys only"),
    render: (r) =>
      r.has_password ? <Pill tone="success">Password</Pill> : <Pill tone="warning">Keys only</Pill>,
    width: 130,
  },
  {
    key: "keys",
    header: "SSH Keys",
    value: (r) => r.keys.length,
    mono: true,
    render: (r) =>
      r.keys.length > 0 ? (
        <span className="inline-flex items-center gap-[6px]">
          <Icon shape="key" size={13} style={{ color: "var(--cds-alias-typography-color-200)" }} />
          {r.keys.length}
        </span>
      ) : (
        <span style={{ color: "var(--cds-alias-typography-color-200)" }}>—</span>
      ),
    sortable: true,
    width: 100,
  },
];

export default function UsersPage() {
  const { setToast } = useDashboard();
  const [users, setUsers] = useState<SystemUser[] | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  // null = closed; { user: undefined } = create; { user } = edit.
  const [modal, setModal] = useState<{ user?: SystemUser } | null>(null);

  const currentUser = getCurrentUser()?.username ?? null;

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      setUsers((await fetchSystemConfig()).users);
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load user accounts.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async (user: SystemUser) => {
    try {
      await deleteUser(user.name);
      setToast(`Deleted user ${user.name}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete user ${user.name}.`);
    }
  };

  const defaultVyosUser = users?.some((u) => u.name === "vyos") ?? false;

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2>Users</h2>
        <p className="clr-secondary" style={{ marginTop: 4 }}>
          Administrator accounts — used for both the WebUI and console/SSH logins
        </p>
      </div>

      {status === "loading" && <div className="clr-secondary">Loading user accounts…</div>}
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
      {status === "ready" && users && (
        <div className="flex flex-col gap-4">
          {defaultVyosUser && (
            <div className="alert alert-warning alert-sm">
              <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
              <div className="alert-text">
                The built-in <span style={{ fontFamily: "var(--qz-font-mono)" }}>vyos</span> account exists on
                every installation. Make sure its default password has been changed, or replace it with a
                personal account and delete it.
              </div>
            </div>
          )}

          <DataTable
            rows={users}
            columns={columns}
            rowId={(r) => r.name}
            storageKey="system-users"
            searchPlaceholder="Search users…"
            emptyMessage="No user accounts configured."
            onRefresh={() => load("refresh")}
            onRowOpen={(row) => setModal({ user: row })}
            toolbar={
              <Button kind="primary" size="sm" icon="plus" onClick={() => setModal({})}>
                Create User
              </Button>
            }
            actions={(row) => {
              // Deleting yourself would strand the session mid-flight, and
              // VyOS refuses an empty user set — guard both up front.
              if (row.name === currentUser || users.length === 1) {
                return (
                  <div className="inline-flex items-center gap-1 justify-end">
                    <button
                      type="button"
                      title={`Edit user ${row.name}`}
                      aria-label="Edit"
                      onClick={() => setModal({ user: row })}
                      className="btn btn-sm btn-link-neutral btn-icon"
                    >
                      <Icon shape="pencil" size={14} />
                    </button>
                    <span
                      className="px-1"
                      title={row.name === currentUser ? "You can't delete the account you're signed in as." : "The last account can't be deleted."}
                    >
                      {row.name === currentUser ? <Pill>You</Pill> : <Pill>Last</Pill>}
                    </span>
                  </div>
                );
              }
              return (
                <RowActions
                  label={`user ${row.name}`}
                  onEdit={() => setModal({ user: row })}
                  onDelete={() => remove(row)}
                />
              );
            }}
          />
        </div>
      )}

      {modal && users && (
        <UserFormModal
          initial={modal.user}
          existing={users}
          onClose={() => setModal(null)}
          onSaved={(msg) => {
            setModal(null);
            setToast(msg);
            load("refresh");
          }}
        />
      )}
    </div>
  );
}
