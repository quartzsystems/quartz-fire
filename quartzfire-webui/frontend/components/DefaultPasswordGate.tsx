"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { AuthUserInfo, getCurrentUser, logout, setUser } from "@/lib/api";
import { setUserPassword } from "@/lib/system";
import { useDashboard } from "@/lib/DashboardContext";

/// Forced password change for accounts that signed in with the factory-default
/// password. The backend flags the login; this modal blocks the console until
/// the password is changed (or the user signs out). Escape/backdrop don't
/// dismiss it — the only ways out are a new password or logout.
export function DefaultPasswordGate() {
  const router = useRouter();
  const { setToast } = useDashboard();
  const [user, setLocalUser] = useState<AuthUserInfo | null>(null);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // localStorage is unavailable during SSR/prerender — read it after mount
  // (by which time AuthGuard's fetchMe has refreshed the cached user).
  useEffect(() => {
    setLocalUser(getCurrentUser());
  }, []);

  if (!user?.default_password) return null;

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (password === "vyos") {
      setError("That's still the default password — pick a different one.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSaving(true);
    try {
      await setUserPassword(user.username, password);
      const updated = { ...user, default_password: false };
      setUser(updated);
      setLocalUser(updated);
      setToast("Password changed. Use it for your next sign-in.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change the password.");
      setSaving(false);
    }
  };

  const signOut = async () => {
    await logout();
    router.push("/");
  };

  return (
    <ModalShell onClose={() => {}} maxWidth={440}>
      <ModalHeader title="Change the Default Password" onClose={signOut} />
      <div className="alert alert-warning">
        <Icon shape="shield-x" size={16} className="alert-icon" />
        <div className="alert-text">
          The account <span style={{ fontFamily: "var(--qz-font-mono)" }}>{user.username}</span> is
          still using the factory-default password. Anyone who can reach this firewall can sign in
          with it — set a new password to continue.
        </div>
      </div>

      <form onSubmit={submit}>
        <div className="clr-form-control" style={{ marginTop: 16 }}>
          <label className="clr-control-label" htmlFor="dpg-new">
            New Password
          </label>
          <input
            id="dpg-new"
            type="password"
            className="clr-input"
            style={{ maxWidth: "none" }}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            autoFocus
          />
        </div>
        <div className="clr-form-control" style={{ marginTop: 16 }}>
          <label className="clr-control-label" htmlFor="dpg-confirm">
            Confirm Password
          </label>
          <input
            id="dpg-confirm"
            type="password"
            className="clr-input"
            style={{ maxWidth: "none" }}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
          <div className="clr-subtext">At least 8 characters, and not the factory default.</div>
        </div>

        {error && (
          <div className="alert alert-danger alert-sm" style={{ marginTop: 12 }}>
            <Icon shape="exclamation-circle" size={14} className="alert-icon" />
            <span className="alert-text">{error}</span>
          </div>
        )}

        <ModalFooter>
          <button type="button" className="btn btn-neutral" onClick={() => void signOut()}>
            Sign Out
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "Changing…" : "Change Password"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
